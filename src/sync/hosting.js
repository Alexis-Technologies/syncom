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
// wakers every live feed waits on and the set `hosted()` lists. The rules the
// procedures stand on — refusals, the peer of a call, the options, the limits,
// the grant, the proof, the sessions — are src/sync/rules.js; the reads a thin
// client makes (`query`, `count`, `blob`) are src/sync/reads.js; here are the
// hello, the push, the snapshot, the two feeds, the presence and the unit.

const { packOps, unpackOps } = require('./wire.js');
const { opKey } = require('../vector.js');
const { notify } = require('../hooks.js');
const { GLOBAL_SCOPE, opInScope } = require('../scope.js');
const { isKeyId, isPlainObject, isStreamName, VERDICT } = require('../shape.js');
const { SIGNER, SOURCE } = require('../symbols.js');
const {
  refuse,
  refuseCall,
  peerOf,
  announceRefused,
  refuseOps,
  normalizeAllow,
  normalizeLimits,
  limit,
  grant,
  challengeOf,
  prove,
  joinRooms,
  remember,
  handPresence,
} = require('./rules.js');
const { normalizeQuery, query, count, blob } = require('./reads.js');

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

const encoder = new TextEncoder();

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
    state.keep = keep;
    context.client.data.syncom = state;
    if (keep) {
      // Under `prove` the rooms and the presence wait for the proof: nothing is handed before the key is shown.
      if (!host.prove) joinRooms(context, scopes);
      remember(host, context, state);
    }
  }
  notify(host.manager, host.logger, 'hello', { node: args.node, scopes, schema, kinds });
  host.drift(schema, { url: null, node: args.node });
  if (keep && !host.prove) handPresence(host, context, scopes);
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
    // Verified before it is forwarded, as a writer verifies a push: a forged or an unsigned op stops here, counted
    // and announced — never a writer's to find in its inbox.
    const { verdicts } = await storage[SOURCE].checkOps(granted);
    const taking = [];
    let forged = 0;
    let unsigned = 0;
    for (let i = 0; i < granted.length; i++) {
      if (verdicts[i] === VERDICT.OK) taking.push(granted[i]);
      else if (verdicts[i] === VERDICT.FORGED) forged++;
      else unsigned++;
    }
    if (forged > 0) refuseOps(host, node, 'forged', forged);
    if (unsigned > 0) refuseOps(host, node, 'unsigned', unsigned);
    const result = await host.shared.forward(taking, node, scopes);
    return {
      ...result,
      forged: result.forged + forged,
      unsigned: result.unsigned + unsigned,
      outOfScope: outOfScope + result.outOfScope,
    };
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
// own: a marker appended first (behind every op the hub offered, refused
// while its relay is behind), the first page taken once the consumer passed
// it — so everything the log held before the marker is in the pages, and the
// client resumes after it — and the vector the page carries is what the hub's
// reads reflect (`shared.vector()`), never a position reserved but not landed.
// A hub that cannot write serves none: its shadow runs ahead of its engine,
// and a page of it could lack what the vector claims — a fresh client
// bootstraps from a hub that writes (the load balancer's rule).
const positioned = async (host, node) => {
  const { shared, storage } = host;
  if (storage.readOnly) {
    const message = 'A hub that cannot write serves no snapshot: bootstrap from a hub that writes';
    throw refuseCall(host, 'snapshot', message, 403, 'READ_ONLY', node);
  }
  try {
    const id = await shared.mark();
    await shared.reached(id);
    return id;
  } catch (error) {
    host.logger.warn({ event: 'sync.snapshot.failed', err: error });
    const refused = refuseCall(
      host,
      'snapshot',
      `The shared log did not answer: ${error.message}`,
      503,
      'SHARED_LOG',
      node,
    );
    // What of the log: the relay `behind`, the `marker` not reached in time, a `stopped` consumer.
    refused.detail = error.reason ?? null;
    throw refused;
  }
};

const snapshot = (host) => async (context, args) => {
  const state = peerOf(host, context, 'snapshot');
  if (!host.allow.snapshot) {
    throw refuseCall(host, 'snapshot', 'This host serves no snapshots', 403, 'NOT_SERVED', state.node);
  }
  const cursor = args?.cursor ?? null;
  const position = host.shared !== null && cursor === null ? await positioned(host, state.node) : null;
  const page = await host.storage.snapshot({
    cursor,
    limit: host.pageSize,
    scopes: grant(args?.scopes, state.scopes),
  });
  if (position !== null) {
    page.eventId = position;
    page.vector = host.shared.vector();
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
          // `beforeSend` rules a hosted page as it rules a push: an op it says no to goes as its header.
          const sent = ops.length === 0 ? ops : await host.manager.sendable(ops, state.ref);
          yield host.track(cursor, { ops: packOps(sent), eventId: cursor });
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
        // `beforeSend` rules a hosted page as it rules a push: an op it says no to goes as its header.
        const sent = ops.length === 0 ? ops : await host.manager.sendable(ops, state.ref);
        // Labelled even when every op was the peer's own echo: the position
        // still moves, and a resume must not replay it.
        yield host.track(cursor, { ops: packOps(sent), eventId: cursor });
      }
    } finally {
      feeds.delete(feed);
    }
  };

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
  PRESENCE_UNPROVEN: 'unproven',
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
  // Under `prove` nothing is taken before the key is shown — a presence update neither.
  if (host.prove && session.proven !== true) return void no('PRESENCE_UNPROVEN');
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

const createUnit = (
  manager,
  options,
  { storage, otel, wakers, feeds, drift, shared = null, sessions = new Map(), revoked = new Map(), scopeOf = null },
) => {
  const {
    access = 'session',
    authorize = null,
    // The manager's rule (`sync.authorizeWrite`) unless the unit names its own.
    authorizeWrite = manager.authorizeWrite ?? null,
    tracked = null,
    pageSize = DEFAULT_PAGE_SIZE,
    pageBytes = DEFAULT_PAGE_BYTES,
    meta,
    prove: proving = storage.signatures === 'require',
  } = options;
  const serveQuery = normalizeQuery(options.query);
  if (authorizeWrite !== null && typeof authorizeWrite !== 'function') {
    throw new TypeError('unit({ authorizeWrite }): authorizeWrite must be a function');
  }
  if (typeof proving !== 'boolean') throw new TypeError('unit({ prove }): prove must be a boolean');
  if (proving && storage[SIGNER] === null) {
    throw new TypeError('unit({ prove }): a proof of key needs the signing plugin (@alexify/syncom/signing)');
  }
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
    // What a read that carries its hello greets through (src/sync/reads.js `greeted`).
    greet: (context, args, keep) => greet(host, context, args, keep),
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
