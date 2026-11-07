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

const { packOps, unpackOps } = require('./wire.js');
const { opKey } = require('../vector.js');
const { notify } = require('../hooks.js');
const { GLOBAL_SCOPE, inScope, opInScope } = require('../scope.js');
const { isKeyId, isPlainObject, isStreamName } = require('../shape.js');
const { SIGNER, CURSOR, DB } = require('../symbols.js');
const { toBase64 } = require('../crypto/pem.js');

// The scopes a hello may ask for: every op of a feed is matched against them.
const MAX_SCOPES = 256;
const { isUpdate: isPresenceUpdate, isEntry: isPresenceEntry, sized } = require('../presence/presence.js');
const { PROTOCOL, DEFAULT_PAGE_SIZE, schemaOf, kindsOf } = require('./protocol.js');
const { parseEntry, sleep } = require('./shared.js');

const DEFAULT_PAGE_BYTES = 4 << 20;
const TRACKED = Symbol.for('wrpc.tracked');
// A feed over a shared log labels a page at least every so many entries it passed without one for its peer.
const PASS_EVERY = 64;
// A feed whose read of the shared log failed waits this long before it reads again, doubling.
const FEED_BACKOFF = 1000;
const MAX_FEED_BACKOFF = 60_000;
// A feed over a shared log that read nothing for this long tells its peer it is caught up (an idle page).
const IDLE_AFTER = 50;
const IDLE = Symbol('syncom.idle');
// The next entry of a shared read, or IDLE after `ms` with none.
const nextOrIdle = (pending, ms) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(IDLE), ms);
    timer.unref?.();
    pending.then(
      (result) => {
        clearTimeout(timer);
        resolve(result);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });

// `unit({ allow })`: which of the three procedures this unit serves; a peer
// asking for one it does not is refused by code (403): `push` as READ_ONLY —
// the host takes nothing — `snapshot` and `changes` as NOT_SERVED.
const ALLOW_KEYS = new Set(['push', 'changes', 'snapshot', 'blob']);
const normalizeAllow = (allow) => {
  const normalized = { push: true, changes: true, snapshot: true, blob: true };
  if (allow === undefined || allow === null) return normalized;
  if (typeof allow !== 'object') throw new TypeError('unit({ allow }): allow must be an object');
  for (const key of Object.keys(allow)) {
    if (!ALLOW_KEYS.has(key)) throw new TypeError(`unit({ allow }): unknown procedure '${key}'`);
    if (allow[key] === undefined) continue;
    if (typeof allow[key] !== 'boolean') throw new TypeError(`unit({ allow }): ${key} must be a boolean`);
    normalized[key] = allow[key];
  }
  return normalized;
};
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

const LIMIT_KEYS = new Set(['opsPerPush', 'bytesPerPush', 'opsPerSecond', 'rowsPerQuery']);
// The rows one `query` answers at most, and a scoped `count` reads, when the host says nothing.
const DEFAULT_ROWS_PER_QUERY = 500;

// The ops one push may carry when the host says nothing: twenty pages of a
// dialer's default size. A page that size is a peer gone wrong — or one
// that wants this node's memory — and is refused at a length check, before
// a byte of it is read. `limits: { opsPerPush: Infinity }` lifts it; the
// bytes and the rate have no default (the byte count serializes every page).
const DEFAULT_OPS_PER_PUSH = 10_000;

// `unit({ limits })`: each a positive number (Infinity for none), unknown keys refused.
const normalizeLimits = (limits) => {
  const normalized = { opsPerPush: DEFAULT_OPS_PER_PUSH, rowsPerQuery: DEFAULT_ROWS_PER_QUERY };
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

// What a hello hands a peer to sign: 32 random bytes as base64url, bound to both node ids in the message.
const challengeOf = () => {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  let text = '';
  for (let i = 0; i < bytes.length; i++) text += String.fromCharCode(bytes[i]);
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const proveMessage = (challenge, host, node) => JSON.stringify([1, 'prove', challenge, host, node]);

// A call this unit does not serve, or cannot: counted, logged under the procedure's event, refused by code.
const refuseCall = (host, procedure, message, code, reason, node = null) => {
  host.otel.recordRefusal(code);
  host.logger.warn({ event: `sync.${procedure}.refused`, code, reason, node });
  return coded(message, code, reason);
};

const peerOf = (host, context, procedure = null) => {
  const state = context?.client?.data?.syncom;
  if (!state) throw refuse(host, 'Say hello first', 428, 'HELLO_FIRST');
  // Under `prove` nothing is taken or handed before the peer signed the challenge its hello was given.
  if (procedure !== null && host.prove && state.proven !== true) {
    throw refuseCall(host, procedure, 'Prove the key first (syncom/prove)', 403, 'UNPROVEN', state.node);
  }
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
// null. One lookup per stream (`log.entryOf`), on a hello behind on its own streams.
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
  for (const [key, seq] of wanted) {
    const entry = storage.log.entryOf(key, seq);
    if (entry !== undefined) ops.push(entry.op);
  }
  return ops.length === 0 ? null : packOps(ops);
};

// A hello: the peer named, checked and granted its scopes, its state on the client; `keep` false for a hello
// carried by a thin client's call over a stateless transport (one request, one client — `greeted`): the state is
// set for the call and nothing of the client is kept — no room, no session, no presence.
const hello = (host) => (context, args) => greet(host, context, args, true);

const greet = async (host, context, args, keep) => {
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
  // Scopes taken back from this node (`sync.revoke`): never granted again, and named in the answer.
  const taken = host.revoked.get(args.node);
  let revoked = null;
  if (taken !== undefined) {
    const kept = [];
    revoked = [];
    for (let i = 0; i < scopes.length; i++) (taken.has(scopes[i]) ? revoked : kept).push(scopes[i]);
    scopes = kept;
  }
  const challenge = host.prove ? challengeOf() : null;
  if (context?.client) {
    context.client.data ??= {};
    // A repeated hello keeps the rate buckets: greeting again is not a refill.
    const bucket = context.client.data.syncom?.bucket;
    const presenceBucket = context.client.data.syncom?.presenceBucket;
    const ref = { url: null, node: args.node };
    const state = {
      node: args.node,
      scopes,
      schema,
      kinds,
      bucket,
      presenceBucket,
      ref,
      challenge,
      proven: false,
      // Counted up by a revoke: a feed opened under an older grant ends, one opened after serves the new one.
      generation: 0,
    };
    context.client.data.syncom = state;
    if (keep) {
      if (typeof context.client.join === 'function') {
        for (const scope of scopes) context.client.join(`syncom:${scope}`);
      }
      remember(host, context, state);
    }
  }
  notify(host.manager, host.logger, 'hello', { node: args.node, scopes, schema, kinds });
  host.drift(schema, { url: null, node: args.node });
  if (keep) handPresence(host, context, scopes);
  // Over a shared log the epoch is the log's, the same on every hub, so a
  // client moved between hubs keeps its cursor; a hub that cannot write
  // answers the vector as the log moved it, not its own as of its open.
  const { shared } = host;
  const answer = {
    node: storage.nodeId,
    vector: (shared === null ? null : shared.vector()) ?? storage.vector,
    epoch: shared === null ? storage.log.epoch : shared.epoch,
    version: PROTOCOL,
    schema: schemaOf(storage.schemaInfo),
    // The kinds this host can hold: a dialer that holds more does not
    // bootstrap from here (KINDS_MISMATCH), since a snapshot of this host
    // would lack those fields.
    kinds: storage.kinds,
  };
  const proof = proofOf(storage, args.node, args.vector, answer.vector);
  if (proof !== null) answer.proof = proof;
  if (challenge !== null) answer.challenge = challenge;
  if (revoked !== null && revoked.length > 0) answer.revoked = revoked;
  return answer;
};

// The live session of a greeted peer, by node, for `sync.revoke(node, scopes)`: told at once through the
// server (`syncom/revoke`), its grant narrowed, its feeds ended. A session is let go of when the same client
// greets again or another takes its place; one whose socket is gone is a no-op to tell.
const remember = (host, context, state) => {
  const { client, server } = context;
  let sessions = host.sessions.get(state.node);
  if (sessions === undefined) host.sessions.set(state.node, (sessions = new Set()));
  for (const session of sessions) if (session.client === client) sessions.delete(session);
  const session = {
    client,
    revoke(scopes) {
      const taken = new Set(scopes);
      const kept = [];
      for (let i = 0; i < state.scopes.length; i++) if (!taken.has(state.scopes[i])) kept.push(state.scopes[i]);
      state.scopes = kept;
      state.generation++;
      if (server && typeof server.sendTo === 'function' && client?.id !== undefined) {
        server.sendTo(client.id, 'syncom/revoke', { scopes: scopes.slice() });
      }
    },
  };
  sessions.add(session);
};

// `prove`: the challenge hello handed this peer, signed under its key — the key that is its node id.
const prove = (host) => async (context, args) => {
  const state = peerOf(host, context);
  const sig = args?.sig;
  if (state.challenge === null || typeof sig !== 'string') {
    throw refuseCall(host, 'prove', 'Nothing to prove, or no signature', 400, 'BAD_PROOF', state.node);
  }
  const signer = host.storage[SIGNER];
  let ok = false;
  try {
    ok = await signer.verifyMessage(proveMessage(state.challenge, host.storage.nodeId, state.node), sig, state.node);
  } catch {
    ok = false;
  }
  if (ok !== true) {
    throw refuseCall(host, 'prove', 'The signature does not prove the key', 403, 'BAD_PROOF', state.node);
  }
  state.proven = true;
  state.challenge = null;
  return { proven: true };
};

const push = (host) => async (context, args) => {
  const { storage, limits } = host;
  const state = peerOf(host, context, 'push');
  const { node, scopes } = state;
  if (!host.allow.push) throw refuseCall(host, 'push', 'This host takes no pushes', 403, 'READ_ONLY', node);
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
  // A hub that cannot write — a follower, a writer whose lease was lost —
  // lands nothing: over a shared log with an inbox it forwards the page for a
  // writer to land (held to the vector as the log moved it), else the client
  // is told to push elsewhere.
  if (storage.readOnly) {
    if (host.shared === null || host.shared.inbox === false) {
      const message = 'This hub is read-only and forwards nothing: push to another';
      throw refuseCall(host, 'push', message, 503, 'READ_ONLY', node);
    }
    const result = await host.shared.forward(granted, node, scopes);
    return { ...result, outOfScope: outOfScope + result.outOfScope };
  }
  // `url` is null: a host does not dial, so it has no url for the peer.
  const via = state.ref ?? { url: null, node };
  // `bound`: the records the peer writes must be in its scopes too, as this
  // node scopes them — the scope an op declares is only the peer's word.
  const options = { via, scopes, peer: via, bound: scopes };
  if (host.authorizeWrite !== null) options.authorize = host.authorizeWrite;
  const result = await storage.applyRemote(granted, options);
  if (result.refused !== undefined) refuseOps(host, node, 'rule', result.refused.length);
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

// Over a shared log a snapshot is positioned in the log, not in this hub's
// own: a marker appended first, the first page taken once the consumer
// passed it — so everything the log held before the marker is in the pages,
// and the client resumes after it — and the vector a hub that cannot write
// answers is the one the log moved.
const positioned = async (host) => {
  const { shared } = host;
  try {
    const id = await shared.mark();
    await shared.reached(id);
    return id;
  } catch (error) {
    host.logger.warn({ event: 'sync.snapshot.failed', err: error });
    throw refuseCall(host, 'snapshot', `The shared log did not answer: ${error.message}`, 503, 'SHARED_LOG');
  }
};

const snapshot = (host) => async (context, args) => {
  const state = peerOf(host, context, 'snapshot');
  if (!host.allow.snapshot) {
    throw refuseCall(host, 'snapshot', 'This host serves no snapshots', 403, 'NOT_SERVED', state.node);
  }
  const cursor = args?.cursor ?? null;
  const position = host.shared !== null && cursor === null ? await positioned(host) : null;
  const page = await host.storage.snapshot({
    cursor,
    limit: host.pageSize,
    scopes: grant(args?.scopes, state.scopes),
  });
  if (position !== null) {
    page.eventId = position;
    page.vector = host.shared.vector() ?? page.vector;
  }
  // The vector rides on the first page only: the dialer adopts it as of
  // the start, and a hub's is too large to repeat.
  if (cursor !== null) page.vector = undefined;
  return streamed(context?.client, page, host.pageBytes);
};

// The feed over a shared log: the topic from the client's cursor on, every
// entry's ops narrowed to its scopes and less its own echoes, one page per
// entry, labelled with the entry's id — the same position on every hub. A
// position the log no longer has (another log's, trimmed past) ends the feed
// with `bootstrap`; a fresh subscription (no cursor) too: the snapshot's first
// page is what positions a client in the log. A read that fails is read again
// from the cursor, backed off.
const sharedChanges = async function* (host, context, args, subscription) {
  const { shared, feeds } = host;
  const state = peerOf(host, context);
  const { node, scopes: granted, generation } = state;
  const { lastEventId, signal } = subscription;
  const scopes = grant(args?.scopes, granted);
  if (lastEventId === undefined || lastEventId === null) {
    yield { bootstrap: true };
    return;
  }
  let cursor = lastEventId;
  const feed = { node, scopes, since: Date.now(), cursor };
  feeds.add(feed);
  try {
    let passed = 0;
    let backoff = 0;
    // Whether the last page told the peer it was caught up: told once per lull.
    let idle = false;
    for (;;) {
      if (signal?.aborted) return;
      try {
        const iterator = shared.read(cursor, signal)[Symbol.asyncIterator]();
        let pending = iterator.next();
        for (;;) {
          // A lull in the log — nothing for IDLE_AFTER — is the peer's `caughtUp`: an empty page, labelled
          // with the cursor, says so once; the read goes on.
          const result = idle ? await pending : await nextOrIdle(pending, IDLE_AFTER);
          if (signal?.aborted || state.generation !== generation) return;
          if (result === IDLE) {
            idle = true;
            yield host.track(cursor, { ops: [], eventId: cursor, idle: true });
            continue;
          }
          if (result.done) break;
          const entry = result.value;
          pending = iterator.next();
          backoff = 0;
          const parsed = parseEntry(entry.value);
          const ops = [];
          if (parsed !== null && parsed !== undefined) {
            for (let i = 0; i < parsed.ops.length; i++) {
              const op = parsed.ops[i];
              if (opInScope(op, scopes) && op.origin !== node && op.from !== node) ops.push(op);
            }
          }
          cursor = entry.id;
          // Nothing for this peer: the position moves without a page, labelled
          // every PASS_EVERY entries so a resume looks at few of these again.
          if (ops.length === 0 && ++passed < PASS_EVERY) continue;
          passed = 0;
          idle = false;
          feed.cursor = cursor;
          yield host.track(cursor, { ops: packOps(ops), eventId: cursor });
        }
        // The read ended without an abort — the log closed, a tail that ends: read again from the cursor.
      } catch (error) {
        if (signal?.aborted) return;
        if (error?.code === 410 || error?.code === 400) {
          yield { bootstrap: true };
          return;
        }
        host.logger.warn({ event: 'shared.feed.failed', topic: shared.topic, node, err: error });
      }
      backoff = backoff === 0 ? FEED_BACKOFF : Math.min(backoff * 2, MAX_FEED_BACKOFF);
      await sleep(backoff, signal);
    }
  } finally {
    feeds.delete(feed);
  }
};

const changes = (host) =>
  async function* (context, args, subscription = {}) {
    const { storage, feeds, wakers, pageSize } = host;
    const state = peerOf(host, context, 'changes');
    const { node, scopes: granted, generation } = state;
    if (!host.allow.changes) throw refuseCall(host, 'changes', 'This host serves no feed', 403, 'NOT_SERVED', node);
    if (host.shared !== null) return yield* sharedChanges(host, context, args, subscription);
    const { lastEventId, signal } = subscription;
    const scopes = grant(args?.scopes, granted);
    let cursor = lastEventId ?? undefined;
    // What hosted() lists while this feed is live.
    const feed = { node, scopes, since: Date.now(), cursor: cursor ?? null };
    feeds.add(feed);
    try {
      // Whether the last page told the peer it was caught up: told once per lull.
      let idle = false;
      for (;;) {
        // The feed ends when the socket does, or when scopes were taken back (`sync.revoke`): the peer opens a
        // feed again under the narrower grant, which is another generation of its session.
        if (signal?.aborted || state.generation !== generation) return;
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
          // Caught up: an empty page labelled with the cursor says so once
          // before the wait (the log's first position when nothing was read
          // yet — never `lastEventId`), so the peer knows it holds everything.
          if (!idle) {
            idle = true;
            const at = cursor ?? storage.log.formatId(0);
            yield host.track(at, { ops: [], eventId: at, idle: true });
          }
          await waitFor(wakers, signal);
          continue;
        }
        const ops = [];
        for (const { op } of entries) if (op.origin !== node && op.from !== node) ops.push(op);
        cursor = storage.log.formatId(entries[entries.length - 1].seq);
        feed.cursor = cursor;
        idle = false;
        // Labelled even when every op was the peer's own echo: the position
        // still moves, and a resume must not replay it.
        yield host.track(cursor, { ops: packOps(ops), eventId: cursor });
      }
    } finally {
      feeds.delete(feed);
    }
  };

// `query` and `count` (`unit({ query: true })`): a thin client's read of this host's records through the query
// plugin — `{ entity, query, order, limit, offset }` — the rows narrowed to the peer's scopes (as the host scopes a
// record, the scope function reading the row; one it throws on is left out) and capped by `limits.rowsPerQuery`.
const BAD_QUERY = 'BAD_QUERY';
const cursorOf = (host, args, procedure, state) => {
  if (!host.query) throw refuseCall(host, procedure, 'This host answers no queries', 403, 'QUERY_DISABLED', state.node);
  if (!isPlainObject(args) || typeof args.entity !== 'string') {
    throw refuseCall(host, procedure, `${procedure} needs an entity`, 400, BAD_QUERY, state.node);
  }
  const query = args.query === undefined || args.query === null ? {} : args.query;
  if (!isPlainObject(query)) throw refuseCall(host, procedure, 'query must be an object', 400, BAD_QUERY, state.node);
  let cursor;
  try {
    // Through the seam as it is: the collection's sealed records are the key holder's and never a peer's.
    cursor = host.storage[CURSOR](args.entity, query);
    if (Array.isArray(args.order)) {
      for (let i = 0; i < args.order.length; i++) {
        const key = args.order[i];
        if (typeof key === 'string') cursor = cursor.order(key);
        else if (isPlainObject(key) && typeof key.field === 'string') {
          cursor = key.desc === true ? cursor.desc(key.field) : cursor.order(key.field);
        } else throw new TypeError('order: a field name or { field, desc }');
      }
    }
  } catch (error) {
    throw refuseCall(host, procedure, error.message, 400, BAD_QUERY, state.node);
  }
  return cursor;
};

// The rows a peer may read: every one for a grant of everything, else the ones of its scopes.
const scoped = (host, rows, scopes) => {
  if (scopes === null) return rows;
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    let scope;
    try {
      scope = host.scopeOf(row.id, row);
    } catch (error) {
      host.logger.warn({ event: 'sync.query.scope', id: row.id, err: error });
      continue;
    }
    if (inScope(scope, scopes)) out.push(row);
  }
  return out;
};

// The peer of a read: greeted before, or — a thin client over a stateless transport, where one request is one
// client and no hello can come first — greeting with the call itself, `args.hello` the hello's own arguments, taken
// as a hello is (authorize, the scopes, the revocations) and kept nowhere.
const greeted = async (host, context, args, procedure) => {
  if (!context?.client?.data?.syncom && isPlainObject(args?.hello)) await greet(host, context, args.hello, false);
  return peerOf(host, context, procedure);
};

const query = (host) => async (context, args) => {
  const state = await greeted(host, context, args, 'query');
  let cursor = cursorOf(host, args, 'query', state);
  const cap = host.limits.rowsPerQuery;
  const limit = Number.isInteger(args.limit) && args.limit > 0 ? Math.min(args.limit, cap) : cap;
  const offset = Number.isInteger(args.offset) && args.offset > 0 ? args.offset : 0;
  const scopes = grant(args.scopes, state.scopes);
  try {
    // A scoped peer's window is cut after its scopes are: the cap bounds what is read, the window what goes out.
    if (scopes === null) cursor = cursor.limit(limit).offset(offset);
    else cursor = cursor.limit(cap);
    const rows = scoped(host, await cursor.fetch(), scopes);
    return { rows: scopes === null ? rows : rows.slice(offset, offset + limit) };
  } catch (error) {
    throw refuseCall(host, 'query', error.message, 400, BAD_QUERY, state.node);
  }
};

// An attachment's bytes by digest (`syncom/blob`): a wrpc stream of the bytes where the transport carries one, the
// bytes as base64 otherwise; 404 `BLOB_NOT_FOUND` where this host holds none (or has no blobs store), 403
// `NOT_SERVED` where `allow.blob` is off, 400 `BAD_DIGEST` for what is no digest.
const DIGEST = /^[0-9a-f]{64}$/;
const blob = (host) => async (context, args) => {
  const state = peerOf(host, context, 'blob');
  if (!host.allow.blob) throw refuseCall(host, 'blob', 'This host serves no blobs', 403, 'NOT_SERVED', state.node);
  const digest = args?.digest;
  if (typeof digest !== 'string' || !DIGEST.test(digest)) {
    throw refuseCall(host, 'blob', 'blob needs a digest (SHA-256, hex)', 400, 'BAD_DIGEST', state.node);
  }
  const store = host.storage[DB]?.blobs;
  const bytes = store === undefined ? null : await store.get(digest);
  if (bytes === null) throw refuseCall(host, 'blob', `No blob ${digest} here`, 404, 'BLOB_NOT_FOUND', state.node);
  const client = context?.client;
  if (client && client.binary !== false && typeof client.createStream === 'function') {
    const stream = client.createStream('syncom/blob', bytes.length);
    queueMicrotask(() => {
      stream.write(bytes);
      stream.end();
    });
    return { id: stream.id, size: bytes.length, digest };
  }
  return { digest, size: bytes.length, base64: toBase64(bytes) };
};

const count = (host) => async (context, args) => {
  const state = await greeted(host, context, args, 'count');
  const cursor = cursorOf(host, args, 'count', state);
  const scopes = grant(args.scopes, state.scopes);
  try {
    if (scopes === null) return { count: await cursor.count() };
    // A scoped count reads the rows (the catalog knows no scopes), as many as the cap allows.
    return { count: scoped(host, await cursor.limit(host.limits.rowsPerQuery).fetch(), scopes).length };
  } catch (error) {
    throw refuseCall(host, 'count', error.message, 400, BAD_QUERY, state.node);
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

const createUnit = (
  manager,
  options,
  { storage, otel, wakers, feeds, drift, shared = null, sessions = new Map(), revoked = new Map(), scopeOf = null },
) => {
  const {
    access = 'session',
    authorize = null,
    authorizeWrite = null,
    tracked = null,
    pageSize = DEFAULT_PAGE_SIZE,
    pageBytes = DEFAULT_PAGE_BYTES,
    meta,
    prove: proving = storage.signatures === 'require',
    query: serveQuery = false,
  } = options;
  if (authorizeWrite !== null && typeof authorizeWrite !== 'function') {
    throw new TypeError('unit({ authorizeWrite }): authorizeWrite must be a function');
  }
  if (typeof proving !== 'boolean') throw new TypeError('unit({ prove }): prove must be a boolean');
  if (proving && storage[SIGNER] === null) {
    throw new TypeError('unit({ prove }): a proof of key needs the signing plugin (@alexify/syncom/signing)');
  }
  if (typeof serveQuery !== 'boolean') throw new TypeError('unit({ query }): query must be a boolean');
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
  const allow = normalizeAllow(options.allow);
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
    shared,
    sessions,
    revoked,
    scopeOf: scopeOf ?? (() => GLOBAL_SCOPE),
    authorize,
    authorizeWrite,
    prove: proving,
    query: serveQuery,
    limits,
    allow,
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
  const unit = {
    hello: procedure(hello(host)),
    push: procedure(push(host)),
    snapshot: procedure(snapshot(host)),
    changes: procedure(changes(host)),
    prove: procedure(prove(host)),
    blob: procedure(blob(host)),
    // An inbound event (wrpc's `on` block): fire-and-forget, never answered.
    on: { presence: procedure(presence(host)) },
  };
  if (serveQuery) {
    unit.query = procedure(query(host));
    unit.count = procedure(count(host));
  }
  return unit;
};

module.exports = { createUnit };
