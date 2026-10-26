'use strict';

// The HOSTING side of replication: the router unit a wrpc server (or anything
// shaped like one) mounts — a plain object of `{ access, handler }`
// procedures shaped for wrpc's defineRouter, with no import of wrpc.
// `changes` is an async generator, which wrpc treats as a subscription; its
// values are labelled with this node's log position through the `tracked`
// shape (Symbol.for('wrpc.tracked'), part of wrpc's frozen wire protocol),
// so a resuming subscriber replays exactly what it missed.
//
// The dialing side is src/sync/manager.js; `SyncManager.unit()` builds the unit here
// with what the two halves share: the storage, the telemetry writer, the
// wakers every live feed waits on and the set `hosted()` lists.

const { packOps, unpackOps } = require('../ops.js');
const { opKey } = require('../vector.js');
const { notify } = require('../hooks.js');
const { GLOBAL_SCOPE, opInScope } = require('../scope.js');
const { isKeyId, isPlainObject, isStreamName } = require('../shape.js');

// The scopes a hello may ask for: every op of a feed is matched against them.
const MAX_SCOPES = 256;
const { isUpdate: isPresenceUpdate, isEntry: isPresenceEntry, sized } = require('../presence/presence.js');
const { PROTOCOL, DEFAULT_PAGE_SIZE, schemaOf, kindsOf } = require('../protocol.js');

const DEFAULT_PAGE_BYTES = 4 << 20;
const TRACKED = Symbol.for('wrpc.tracked');
const encoder = new TextEncoder();

// A refusal as it goes on the wire: the numeric `code` a transport carries
// (wrpc sends code and message), and `reason` — a constant naming which
// check refused — for the host's own logs and listeners.
const coded = (message, code, reason) => {
  const error = new Error(message);
  error.code = code;
  error.reason = reason;
  error.expose = true;
  return error;
};

const LIMIT_KEYS = new Set(['opsPerPush', 'bytesPerPush', 'opsPerSecond']);

// The ops one push may carry when the host says nothing: twenty pages of a
// dialer's default size. A page that size is a peer gone wrong — or one
// that wants this node's memory — and is refused at a length check, before
// a byte of it is read. `limits: { opsPerPush: Infinity }` lifts it; the
// bytes and the rate have no default (the byte count serializes every page).
const DEFAULT_OPS_PER_PUSH = 10_000;

// `unit({ limits })`: each a positive number (Infinity for none), unknown keys refused.
const normalizeLimits = (limits) => {
  const normalized = { opsPerPush: DEFAULT_OPS_PER_PUSH };
  if (limits === undefined || limits === null) return normalized;
  if (typeof limits !== 'object') throw new TypeError('unit({ limits }): limits must be an object');
  for (const key of Object.keys(limits)) {
    if (!LIMIT_KEYS.has(key)) throw new TypeError(`unit({ limits }): unknown limit '${key}'`);
    const value = limits[key];
    if (value === undefined) continue;
    if (typeof value !== 'number' || Number.isNaN(value) || value <= 0) {
      throw new TypeError(`unit({ limits }): ${key} must be a positive number`);
    }
    if (value === Infinity) delete normalized[key];
    else normalized[key] = value;
  }
  return normalized;
};

// The scopes a read may cover: what hello granted, narrowed to what the
// call asks for. A peer granted `'*'` reads what it asks (nothing asked:
// everything); one granted a list reads the intersection — asking for `'*'`
// or for nothing is asking for its list, asking only for others is 403.
const grant = (asked, granted) => {
  const everything = granted.includes(GLOBAL_SCOPE);
  if (!Array.isArray(asked)) return everything ? null : granted;
  const held = everything ? null : new Set(granted);
  const scopes = [];
  for (let i = 0; i < asked.length; i++) {
    const scope = asked[i];
    if (typeof scope !== 'string') continue;
    if (held === null) scopes.push(scope);
    else if (scope === GLOBAL_SCOPE) return granted;
    else if (held.has(scope)) scopes.push(scope);
  }
  if (held === null) return scopes;
  if (scopes.length === 0) throw coded('Scopes not granted', 403, 'SCOPES');
  return scopes;
};

// Resolves on the next change (or abort). The manager keeps ONE listener on
// the storage and wakes every waiting subscription from it, because a host
// has as many `changes` feeds as it has peers.
const waitFor = (wakers, signal) =>
  new Promise((resolve) => {
    if (signal?.aborted) return void resolve();
    const done = () => {
      wakers.delete(done);
      signal?.removeEventListener?.('abort', done);
      resolve();
    };
    wakers.add(done);
    signal?.addEventListener?.('abort', done, { once: true });
  });

// Per-peer push limits, the one place that knows the ops and the bytes:
// a page over `opsPerPush` or `bytesPerPush` is 413, a peer over
// `opsPerSecond` is 429 — a token bucket in its state, refilled at that
// rate, holding one second's worth. Codes, not a hang-up: the dialer
// reports them, marks the host behind and pushes again from the vector at
// the next sign of life on the link (`#recover` in src/sync/manager.js).
const limit = (otel, state, args, ops, limits) => {
  const { opsPerPush, bytesPerPush, opsPerSecond } = limits;
  if (opsPerPush !== undefined && ops.length > opsPerPush) {
    otel.recordLimited('ops');
    throw coded(`Push of ${ops.length} ops exceeds opsPerPush ${opsPerPush}`, 413, 'OPS_PER_PUSH');
  }
  if (bytesPerPush !== undefined) {
    const bytes = encoder.encode(JSON.stringify(args?.ops ?? null)).length;
    if (bytes > bytesPerPush) {
      otel.recordLimited('bytes');
      throw coded(`Push of ${bytes} bytes exceeds bytesPerPush ${bytesPerPush}`, 413, 'BYTES_PER_PUSH');
    }
  }
  if (opsPerSecond !== undefined) {
    const at = Date.now();
    const bucket = (state.bucket ??= { tokens: opsPerSecond, at });
    bucket.tokens = Math.min(opsPerSecond, bucket.tokens + ((at - bucket.at) / 1000) * opsPerSecond);
    bucket.at = at;
    if (ops.length > bucket.tokens) {
      otel.recordLimited('rate');
      throw coded(`Rate limited: ${ops.length} ops over opsPerSecond ${opsPerSecond}`, 429, 'OPS_PER_SECOND');
    }
    bucket.tokens -= ops.length;
  }
};

// A snapshot page as a wrpc stream — NDJSON, serialized first because a
// stream declares its size up front; a page is bounded, so that buffer is
// too. The page itself when the client cannot read streams or the page is
// over `pageBytes`.
const streamed = (client, page, pageBytes) => {
  const canStream = client && client.binary !== false && typeof client.createStream === 'function';
  if (!canStream || page.records.length === 0) return page;
  let text = '';
  for (const record of page.records) text += `${JSON.stringify(record)}\n`;
  const bytes = encoder.encode(text);
  if (bytes.length > pageBytes) return page;
  const stream = client.createStream('syncom/snapshot', bytes.length);
  // The opening packet is already out; writing in this tick would race the
  // caller's chance to attach a consumer.
  queueMicrotask(() => {
    stream.write(bytes);
    stream.end();
  });
  return { id: stream.id, size: bytes.length, cursor: page.cursor, eventId: page.eventId, vector: page.vector };
};

// A refusal before the handler: counted by code; 428 is the normal course
// of a wrpc reconnect (a new server-side client) and only counted.
const refuse = (host, message, code, reason, node = null) => {
  host.otel.recordRefusal(code);
  if (code !== 428) host.logger.warn({ event: 'sync.hello.refused', code, reason, node });
  return coded(message, code, reason);
};

const peerOf = (host, context) => {
  const state = context?.client?.data?.syncom;
  if (!state) throw refuse(host, 'Say hello first', 428, 'HELLO_FIRST');
  return state;
};

// Ops of a peer this host would not take, logged and announced through the
// `refused` event — where the host ties a refusal to the client that pushed.
const announceRefused = (host, node, reason, count) => {
  host.logger.warn({ event: 'sync.op.refused', node, reason, count });
  notify(host.manager, host.logger, 'refused', { node, reason, count });
};

// Refused HERE, before anything sees them: counted too — `reason` is what
// the `syncom.ops.rejected` metric carries. (A signature refusal is counted
// per op in applyRemote already, and only announced here.)
const refuseOps = (host, node, reason, count) => {
  for (let i = 0; i < count; i++) host.otel.recordRejected(reason);
  announceRefused(host, node, reason, count);
};

// What a dialer that lost part of its log needs to move its streams past
// what this host holds of them (REWOUND, src/sync/manager.js `#rewind`): for
// each of its own streams this host is ahead on, the newest op of it held
// here — signed by the dialer's own key, so the claim carries its proof. For
// a dialer whose id is a key (one that signs), only when its hello says it
// holds less, and only what the log still retains: packed like a page, or
// null. One pass over the log, on a hello that is behind on its own streams.
const proofOf = (storage, node, claimed, held) => {
  if (!isKeyId(node) || !isPlainObject(claimed)) return null;
  const wanted = new Map();
  for (const key of Object.keys(held)) {
    if (key !== node && !key.startsWith(`${node}@`)) continue;
    const theirs = Object.hasOwn(claimed, key) && Number.isSafeInteger(claimed[key]) ? claimed[key] : 0;
    if (held[key] > theirs) wanted.set(key, held[key]);
  }
  if (wanted.size === 0) return null;
  const ops = [];
  for (const { op } of storage.log.scan()) {
    if (op.origin !== node) continue;
    const key = opKey(op);
    if (wanted.get(key) !== op.seq) continue;
    ops.push(op);
    wanted.delete(key);
    if (wanted.size === 0) break;
  }
  return ops.length === 0 ? null : packOps(ops);
};

const hello = (host) => async (context, args) => {
  const { storage } = host;
  if (!args || typeof args.node !== 'string') throw refuse(host, 'hello needs a node id', 400, 'BAD_HELLO');
  if (args.version !== undefined && args.version !== PROTOCOL) {
    throw refuse(host, `Unsupported protocol ${args.version}`, 400, 'PROTOCOL', args.node);
  }
  if (args.node === storage.nodeId) {
    throw refuse(host, 'A node cannot sync with itself (copied data directory?)', 409, 'SELF', args.node);
  }
  // Under 'require' a peer whose id is no key could never push: every op of
  // its own would be refused, in silence, at every handshake. Said once,
  // here. (Not a proof of possession — a signed hello challenge would be.)
  if (storage.signatures === 'require' && !isKeyId(args.node)) {
    throw refuse(host, 'This host requires signed ops; hello needs a signing-key node id', 403, 'UNSIGNED', args.node);
  }
  if (host.authorize && !(await host.authorize(context, args))) {
    throw refuse(host, 'Not authorized to sync', 403, 'UNAUTHORIZED', args.node);
  }
  let scopes = [GLOBAL_SCOPE];
  if (Array.isArray(args.scopes)) {
    // A scope is a stream name or the global one, each once, MAX_SCOPES at
    // most: every op of a feed is matched against them.
    if (args.scopes.length > MAX_SCOPES) {
      throw refuse(host, `hello asks for more than ${MAX_SCOPES} scopes`, 400, 'BAD_HELLO', args.node);
    }
    scopes = [];
    const asked = new Set();
    for (let i = 0; i < args.scopes.length; i++) {
      const scope = args.scopes[i];
      if (asked.has(scope) || (scope !== GLOBAL_SCOPE && !isStreamName(scope))) continue;
      asked.add(scope);
      scopes.push(scope);
    }
  }
  const schema = schemaOf(args.schema);
  const kinds = kindsOf(args.kinds);
  if (context?.client) {
    context.client.data ??= {};
    // A repeated hello keeps the rate buckets: greeting again is not a refill.
    const bucket = context.client.data.syncom?.bucket;
    const presenceBucket = context.client.data.syncom?.presenceBucket;
    const ref = { url: null, node: args.node };
    context.client.data.syncom = { node: args.node, scopes, schema, kinds, bucket, presenceBucket, ref };
    if (typeof context.client.join === 'function') {
      for (const scope of scopes) context.client.join(`syncom:${scope}`);
    }
  }
  notify(host.manager, host.logger, 'hello', { node: args.node, scopes, schema, kinds });
  host.drift(schema, { url: null, node: args.node });
  handPresence(host, context, scopes);
  const answer = {
    node: storage.nodeId,
    vector: storage.vector,
    epoch: storage.log.epoch,
    version: PROTOCOL,
    schema: schemaOf(storage.schemaInfo),
    // The kinds this host can hold: a dialer that holds more does not
    // bootstrap from here (KINDS_MISMATCH), since a snapshot of this host
    // would lack those fields.
    kinds: storage.kinds,
  };
  const proof = proofOf(storage, args.node, args.vector, answer.vector);
  if (proof !== null) answer.proof = proof;
  return answer;
};

const push = (host) => async (context, args) => {
  const { storage, limits } = host;
  const state = peerOf(host, context);
  const { node, scopes } = state;
  const ops = unpackOps(args?.ops);
  limit(host.otel, state, args, ops, limits);
  // The scopes hello granted bound what a peer writes here, not only what
  // it reads: an op outside them is refused before anything sees it. No
  // stream is harmed — seqs run per scope, and a dialer that honours its
  // registry never sends one. (An op in a granted scope that writes a
  // record outside them is refused inside applyRemote, which reads the
  // record: that one is a gap in its stream.)
  const granted = [];
  let outOfScope = 0;
  for (const op of ops) {
    if (opInScope(op, scopes)) granted.push(op);
    else outOfScope++;
  }
  if (outOfScope > 0) refuseOps(host, node, 'scope', outOfScope);
  // `url` is null: a host does not dial, so it has no url for the peer.
  const via = state.ref ?? { url: null, node };
  // `bound`: the records the peer writes must be in its scopes too, as this
  // node scopes them — the scope an op declares is only the peer's word.
  const result = await storage.applyRemote(granted, { via, scopes, peer: via, bound: scopes });
  if (result.outOfScope > 0) refuseOps(host, node, 'scope', result.outOfScope);
  if (result.forged > 0) announceRefused(host, node, 'forged', result.forged);
  if (result.unsigned > 0) announceRefused(host, node, 'unsigned', result.unsigned);
  if (result.equivocations > 0) announceRefused(host, node, 'equivocation', result.equivocations);
  // The vector the dialer merges in: the keys this page touched, not the
  // whole thing — a hub's has a key per client and scope.
  const vector = {};
  for (const op of granted) {
    const key = opKey(op);
    const seq = storage.log.seqOf(key);
    if (seq > 0) vector[key] = seq;
  }
  return { vector, ...result, outOfScope: outOfScope + result.outOfScope };
};

const snapshot = (host) => async (context, args) => {
  const state = peerOf(host, context);
  const page = await host.storage.snapshot({
    cursor: args?.cursor ?? null,
    limit: host.pageSize,
    scopes: grant(args?.scopes, state.scopes),
  });
  // The vector rides on the first page only: the dialer adopts it as of
  // the start, and a hub's is too large to repeat.
  if (args?.cursor) page.vector = undefined;
  return streamed(context?.client, page, host.pageBytes);
};

const changes = (host) =>
  async function* (context, args, subscription = {}) {
    const { storage, feeds, wakers, pageSize } = host;
    const { node, scopes: granted } = peerOf(host, context);
    const { lastEventId, signal } = subscription;
    const scopes = grant(args?.scopes, granted);
    let cursor = lastEventId ?? undefined;
    // What hosted() lists while this feed is live.
    const feed = { node, scopes, since: Date.now(), cursor: cursor ?? null };
    feeds.add(feed);
    try {
      for (;;) {
        if (signal?.aborted) return;
        const page = storage.log.read(cursor, { scopes, limit: pageSize });
        if (page === null) {
          // Cannot resume: another epoch, or compacted past the cursor.
          yield { bootstrap: true };
          return;
        }
        const { entries, last } = page;
        if (entries.length === 0) {
          // Nothing for this peer: what came is another scope's. The cursor
          // moves past it — to a real entry's position, never to
          // `lastEventId`, which runs ahead of the entries while an append
          // is in flight — so the next wake scans only what is new. Not
          // labelled: there is no page to send; a resume from the last page
          // delivered looks at these once more.
          if (last !== null) {
            cursor = storage.log.formatId(last);
            feed.cursor = cursor;
          }
          await waitFor(wakers, signal);
          continue;
        }
        const ops = [];
        for (const { op } of entries) if (op.origin !== node && op.from !== node) ops.push(op);
        cursor = storage.log.formatId(entries[entries.length - 1].seq);
        feed.cursor = cursor;
        // Labelled even when every op was the peer's own echo: the position
        // still moves, and a resume must not replay it.
        yield host.track(cursor, { ops: packOps(ops), eventId: cursor });
      }
    } finally {
      feeds.delete(feed);
    }
  };

/**
 * The unit `manager.unit(options)` returns. `access` defaults to wrpc's own
 * default, 'session'; `authorize(context, hello)` gates a peer by whatever
 * the transport presented. `drift(schema, peer)` is the manager's report of
 * a schema that disagrees with this node's.
 */
// A peer's presence, the inbound event `syncom/presence`: the update must be
// the peer's own (every entry the node that said hello), of a scope it
// asked for, within the rate, signed when this host requires signatures —
// else refused, counted and announced, never relayed. What passes goes to
// everyone in the scope's room but the sender, to the host's own presence
// when `storage.sync.presence()` registered one, and into the host's memory
// of the room, which a newcomer is handed at hello.
// The `syncom.presence.refused` label of a host's refusal.
const PRESENCE_REASONS = Object.freeze({
  HELLO: 'hello',
  PRESENCE_RATE: 'rate',
  PRESENCE_MALFORMED: 'malformed',
  PRESENCE_SCOPE: 'scope',
  PRESENCE_FORGED: 'forged',
  PRESENCE_UNSIGNED: 'unsigned',
});

const presence = (host) => async (context, update) => {
  const session = context?.client?.data?.syncom;
  // Refused: counted by reason, logged, announced as `refused`, never relayed.
  const no = (reason) => {
    const node = session?.node ?? null;
    host.otel.recordPresenceRefused(PRESENCE_REASONS[reason], 1);
    host.logger.warn({ event: 'sync.presence.refused', node, reason });
    notify(host.manager, host.logger, 'refused', { node, reason, count: 1 });
  };
  if (!session) return void no('HELLO');
  const { node, scopes } = session;
  const { rate, timeout } = host.presence;
  const now = Date.now();
  const bucket = (session.presenceBucket ??= { tokens: rate, at: now });
  bucket.tokens = Math.min(rate, bucket.tokens + ((now - bucket.at) / 1000) * rate);
  bucket.at = now;
  if (bucket.tokens < 1) return void no('PRESENCE_RATE');
  bucket.tokens -= 1;
  if (!isPresenceUpdate(update)) return void no('PRESENCE_MALFORMED');
  if (!scopes.includes(update.scope)) return void no('PRESENCE_SCOPE');
  for (const entry of update.s) {
    // Checked as a receiver checks it — the shape, a stamp not ahead, the
    // bounds — before the host keeps or relays a byte of it.
    if (!isPresenceEntry(entry) || !sized(entry[3])) return void no('PRESENCE_MALFORMED');
    if (entry[0] !== node) return void no('PRESENCE_FORGED');
    if (host.storage.signatures === 'require' && entry.length < 5) return void no('PRESENCE_UNSIGNED');
  }
  // The room's memory: the newest state per node, in the order of the last
  // update — so the stale are at the head, and an update looks at them
  // alone, not the room (one renewal per node per room, every few seconds,
  // made each a walk of every node once). One older than its place says
  // waits until it is at the head; the newcomer's hand drops it anyway.
  let room = host.presence.rooms.get(update.scope);
  if (room === undefined) host.presence.rooms.set(update.scope, (room = new Map()));
  const floor = now - timeout;
  for (const [other, held] of room) {
    if (held[2] >= floor) break;
    room.delete(other);
  }
  for (const entry of update.s) {
    const held = room.get(node);
    if (held !== undefined && held[1] >= entry[1]) continue;
    room.delete(node);
    if (entry[3] !== null && room.size < host.presence.max) room.set(node, entry);
  }
  if (room.size === 0) host.presence.rooms.delete(update.scope);
  const server = context?.server;
  if (server && typeof server.to === 'function') {
    const target = server.to(`syncom:${update.scope}`);
    const sent = typeof target.except === 'function' && context.client ? target.except(context.client) : target;
    sent.emit('syncom/presence', update);
  }
  await host.manager.receivePresence(update, { node, url: null });
};

// What a newcomer is handed at hello: the room's states of every scope it asked for.
const handPresence = (host, context, scopes) => {
  const server = context?.server;
  const client = context?.client;
  if (!server || typeof server.sendTo !== 'function' || !client || client.id === undefined) return;
  const floor = Date.now() - host.presence.timeout;
  const self = client.data?.syncom?.node;
  const { rooms } = host.presence;
  const seen = new Set();
  for (let i = 0; i < scopes.length; i++) {
    const scope = scopes[i];
    if (seen.has(scope)) continue;
    seen.add(scope);
    const room = rooms.get(scope);
    if (room === undefined) continue;
    const s = [];
    for (const entry of room.values()) if (entry[2] >= floor && entry[0] !== self) s.push(entry);
    if (s.length > 0) server.sendTo(client.id, 'syncom/presence', { p: 1, scope, s });
  }
};

const createUnit = (manager, options, { storage, otel, wakers, feeds, drift }) => {
  const {
    access = 'session',
    authorize = null,
    tracked = null,
    pageSize = DEFAULT_PAGE_SIZE,
    pageBytes = DEFAULT_PAGE_BYTES,
    meta,
  } = options;
  const presenceOptions = options.presence ?? {};
  if (typeof presenceOptions !== 'object' || presenceOptions === null) {
    throw new TypeError('unit({ presence }): presence must be an object');
  }
  const { timeout: presenceTimeout = 30_000, rate: presenceRate = 20, max: presenceMax = 1024 } = presenceOptions;
  for (const [name, value] of [
    ['timeout', presenceTimeout],
    ['rate', presenceRate],
    ['max', presenceMax],
  ]) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new TypeError(`unit({ presence: { ${name} } }): a positive number`);
    }
  }
  const limits = normalizeLimits(options.limits);
  if (meta !== undefined && (typeof meta !== 'object' || meta === null || Array.isArray(meta))) {
    throw new TypeError('unit({ meta }): meta must be an object');
  }
  // What every procedure reaches of the host.
  const host = {
    manager,
    storage,
    otel,
    wakers,
    feeds,
    drift,
    authorize,
    limits,
    pageSize,
    pageBytes,
    logger: storage.logger,
    track: tracked ?? ((id, data) => ({ [TRACKED]: true, id: String(id), data })),
    presence: { timeout: presenceTimeout, rate: presenceRate, max: presenceMax, rooms: new Map() },
  };
  // `meta` rides on every procedure: what a wrpc `onRequest` hook reads as
  // `context.procedure.meta` — a hub-wide policy (rate limits, audit) stays
  // the host's, and the unit stays a plain object.
  const procedure = (handler) => (meta === undefined ? { access, handler } : { access, handler, meta });
  return {
    hello: procedure(hello(host)),
    push: procedure(push(host)),
    snapshot: procedure(snapshot(host)),
    changes: procedure(changes(host)),
    // An inbound event (wrpc's `on` block): fire-and-forget, never answered.
    on: { presence: procedure(presence(host)) },
  };
};

module.exports = { createUnit };
