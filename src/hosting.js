'use strict';

// The HOSTING side of replication: the router unit a wrpc server (or anything
// shaped like one) mounts — a plain object of `{ access, handler }`
// procedures shaped for wrpc's defineRouter, with no import of wrpc.
// `changes` is an async generator, which wrpc treats as a subscription; its
// values are labelled with this node's log position through the `tracked`
// shape (Symbol.for('wrpc.tracked'), part of wrpc's frozen wire protocol),
// so a resuming subscriber replays exactly what it missed.
//
// The dialing side is src/sync.js; `SyncManager.unit()` builds the unit here
// with what the two halves share: the storage, the telemetry writer, the
// wakers every live feed waits on and the set `hosted()` lists.

const { packOps, unpackOps } = require('./ops.js');
const { opKey } = require('./vector.js');
const { notify } = require('./hooks.js');
const { GLOBAL_SCOPE, opInScope } = require('./scope.js');
const { PROTOCOL, DEFAULT_PAGE_SIZE, schemaOf } = require('./protocol.js');

const DEFAULT_PAGE_BYTES = 4 << 20;
const TRACKED = Symbol.for('wrpc.tracked');

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

const LIMIT_KEYS = ['opsPerPush', 'bytesPerPush', 'opsPerSecond'];

// `unit({ limits })`: each a positive number, unknown keys refused.
const normalizeLimits = (limits) => {
  if (limits === undefined || limits === null) return null;
  if (typeof limits !== 'object') throw new TypeError('unit({ limits }): limits must be an object');
  const normalized = {};
  for (const key of Object.keys(limits)) {
    if (!LIMIT_KEYS.includes(key)) throw new TypeError(`unit({ limits }): unknown limit '${key}'`);
    const value = limits[key];
    if (value === undefined) continue;
    if (!Number.isFinite(value) || value <= 0) {
      throw new TypeError(`unit({ limits }): ${key} must be a positive number`);
    }
    normalized[key] = value;
  }
  return normalized;
};

// The scopes a read may cover: what hello granted, narrowed to what the
// call asks for. A peer granted `'*'` reads what it asks (nothing asked:
// everything); one granted a list reads the intersection — asking for `'*'`
// or for nothing is asking for its list, asking only for others is 403.
const grant = (asked, granted) => {
  const wanted = Array.isArray(asked) ? asked.filter((scope) => typeof scope === 'string') : null;
  if (granted.includes(GLOBAL_SCOPE)) return wanted;
  if (wanted === null || wanted.includes(GLOBAL_SCOPE)) return granted;
  const scopes = wanted.filter((scope) => granted.includes(scope));
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
// reports them and recomputes from the vector at its next hello.
const limit = (otel, state, args, ops, limits) => {
  const { opsPerPush, bytesPerPush, opsPerSecond } = limits;
  if (opsPerPush !== undefined && ops.length > opsPerPush) {
    otel.recordLimited('ops');
    throw coded(`Push of ${ops.length} ops exceeds opsPerPush ${opsPerPush}`, 413, 'OPS_PER_PUSH');
  }
  if (bytesPerPush !== undefined) {
    const bytes = new TextEncoder().encode(JSON.stringify(args?.ops ?? null)).length;
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
  const bytes = new TextEncoder().encode(text);
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

// Ops of a peer this host would not take: counted, logged and announced
// through the `refused` event, never applied. `reason` is what the
// `syncom.ops.rejected` metric carries.
const refuseOps = (host, node, reason, count) => {
  host.logger.warn({ event: 'sync.op.refused', node, reason, count });
  for (let i = 0; i < count; i++) host.otel.recordRejected(reason);
  notify(host.manager, host.logger, 'refused', { node, reason, count });
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
  if (host.authorize && !(await host.authorize(context, args))) {
    throw refuse(host, 'Not authorized to sync', 403, 'UNAUTHORIZED', args.node);
  }
  const scopes = Array.isArray(args.scopes) ? args.scopes.filter((s) => typeof s === 'string') : [GLOBAL_SCOPE];
  const schema = schemaOf(args.schema);
  if (context?.client) {
    context.client.data ??= {};
    // A repeated hello keeps the rate bucket: greeting again is not a refill.
    const bucket = context.client.data.syncom?.bucket;
    const ref = { url: null, node: args.node };
    context.client.data.syncom = { node: args.node, scopes, schema, bucket, ref };
    if (typeof context.client.join === 'function') {
      for (const scope of scopes) context.client.join(`syncom:${scope}`);
    }
  }
  notify(host.manager, host.logger, 'hello', { node: args.node, scopes, schema });
  host.drift(schema, { url: null, node: args.node });
  return {
    node: storage.nodeId,
    vector: storage.vector,
    epoch: storage.log.epoch,
    version: PROTOCOL,
    schema: schemaOf(storage.schemaInfo),
  };
};

const push = (host) => async (context, args) => {
  const { storage, limits } = host;
  const state = peerOf(host, context);
  const { node, scopes } = state;
  const ops = unpackOps(args?.ops);
  if (limits !== null) limit(host.otel, state, args, ops, limits);
  // The scopes hello granted bound what a peer writes here, not only what
  // it reads: an op outside them is refused before anything sees it. No
  // stream is harmed — seqs run per scope, and a dialer that honours its
  // registry never sends one.
  const granted = [];
  let outOfScope = 0;
  for (const op of ops) {
    if (opInScope(op, scopes)) granted.push(op);
    else outOfScope++;
  }
  if (outOfScope > 0) refuseOps(host, node, 'scope', outOfScope);
  // `url` is null: a host does not dial, so it has no url for the peer.
  const via = state.ref ?? { url: null, node };
  const result = await storage.applyRemote(granted, { via, scopes, peer: via });
  // The vector the dialer merges in: the keys this page touched, not the
  // whole thing — a hub's has a key per client and scope.
  const whole = storage.vector;
  const vector = {};
  for (const op of granted) {
    const key = opKey(op);
    if (whole[key] !== undefined) vector[key] = whole[key];
  }
  return { vector, ...result, outOfScope };
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
const createUnit = (manager, options, { storage, otel, wakers, feeds, drift }) => {
  const {
    access = 'session',
    authorize = null,
    tracked = null,
    pageSize = DEFAULT_PAGE_SIZE,
    pageBytes = DEFAULT_PAGE_BYTES,
    meta,
  } = options;
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
  };
};

module.exports = { createUnit };
