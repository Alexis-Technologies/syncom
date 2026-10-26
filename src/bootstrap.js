'use strict';

// Bootstrap: how a node that cannot be resumed from a peer's log gets the
// peer's state. The host serves `snapshot()` pages — live records AND
// tombstones, with their metadata, in id order — and the dialer joins each
// page through `mergeSnapshot()` as `merge` ops of its own (so the joined
// state also reaches the peers that resume from ITS log: bootstrap is
// transitive), then records through `adoptVector()` which ops the joined
// state covers. `core` is what Storage lends its write paths — see
// Storage#open.

const { applyOp, isAlive, latestClock } = require('./ops.js');
const { opKey } = require('./vector.js');
const { fingerprintOf } = require('./header.js');
const { link } = require('./commit.js');
const { notify } = require('./hooks.js');
const { traced, now } = require('./telemetry.js');
const { GLOBAL_SCOPE, inScope } = require('./scope.js');
const { isPlainObject, asJson, isRecordId, nestsWithin, MAX_WIRE_DEPTH } = require('./shape.js');

const DEFAULT_LIMIT = 500;

// The index of the first element of a sorted array above `value`.
const upperBound = (sorted, value) => {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (sorted[mid] <= value) low = mid + 1;
    else high = mid;
  }
  return low;
};

// One page, over the catalog, which knows every entry with a file — live
// records, tombstones, sealed ones — in id order: no directory listing per
// page, no load of what the row already says is sealed. `cursor` is the
// last id of the previous page; `null` back means done.
const pageOf = async (core, { cursor = null, limit = DEFAULT_LIMIT, scopes = null } = {}) => {
  const { catalog, log } = core;
  const ids = catalog.all();
  const records = [];
  let last = cursor;
  for (let index = cursor === null ? 0 : upperBound(ids, cursor); index < ids.length; index++) {
    const id = ids[index];
    last = id;
    if (catalog.row(id)?.encrypted) continue;
    let entry;
    try {
      entry = await core.entries.load(id);
    } catch (error) {
      // A record this node cannot read is this node's problem to report
      // (it does, on the read); the page goes out without it.
      core.logger.warn({ event: 'snapshot.skipped', id, err: error });
      continue;
    }
    if (!entry || entry.encrypted) continue;
    // A page for every scope reads no record's scope; one for some does, and a
    // scope function that throws on a record leaves that record out — never
    // the page, which would fail every snapshot of this node while the record
    // is there.
    if (scopes !== null) {
      let scope;
      try {
        scope = core.scopeOf(id, entry.data);
      } catch (error) {
        core.logger.warn({ event: 'snapshot.skipped', id, reason: 'scope', err: error });
        continue;
      }
      if (!inScope(scope, scopes)) continue;
    }
    records.push({ id, data: entry.data, meta: entry.meta });
    if (records.length >= limit) return { records, cursor: last, eventId: log.lastEventId, vector: log.vector };
  }
  return { records, cursor: null, eventId: log.lastEventId, vector: log.vector };
};

/** One page of this node's state for a peer: `storage.snapshot(options)`. */
const snapshotPage = (core, options = {}) => {
  const { otel } = core;
  if (!otel.enabled) return pageOf(core, options);
  const attributes = { 'syncom.limit': options.limit ?? DEFAULT_LIMIT };
  return traced(
    otel,
    'syncom.snapshot',
    attributes,
    () => pageOf(core, options),
    (page) => ({ 'syncom.records': page.records.length, 'syncom.done': page.cursor === null }),
  );
};

// One snapshot record as a merge op of this node's own: run through the
// write hooks, stamped above everything this node holds for it and above
// the joined meta. A record that is refused or changes nothing leaves no op.
const mergeOne = async (batch, record) => {
  const { core, via, from } = batch;
  const { otel } = core;
  // Nested past what an op may carry, the merge op made of it would be
  // malformed at every peer: a gap in this node's own stream for good.
  const shaped =
    isPlainObject(record) &&
    isRecordId(record.id) &&
    nestsWithin(record.data, MAX_WIRE_DEPTH) &&
    nestsWithin(record.meta, MAX_WIRE_DEPTH);
  if (!shaped) {
    core.logger.warn({ event: 'sync.record.malformed', id: isPlainObject(record) ? record.id : typeof record });
    return;
  }
  const { id } = record;
  // A stamp beyond the skew allowed is refused here as an op's is in
  // applyRemote: a snapshot is the other way a clock reaches this node.
  const latest = latestClock(record.meta, false, core.limits);
  if (latest !== null && latest[0] > batch.horizon) {
    core.logger.warn({ event: 'sync.record.skew', id, ts: latest[0], ahead: latest[0] - batch.horizon });
    return;
  }
  const started = otel.enabled ? now() : 0;
  const data = asJson(record.data);
  const meta = asJson(record.meta);
  const current = batch.touched.get(id) ?? (await core.current(id));
  if (current?.encrypted) {
    // Sealed here for this node alone: a peer's state of it is not taken.
    core.logger.warn({ event: 'sync.record.encrypted', id });
    return;
  }
  const visible = current && isAlive(current) ? current.data : null;
  const ctx = { type: 'merge', id, data, meta, current: visible, encrypted: false, source: null, via, from };
  ctx.v = core.version;
  ctx.actor = null;
  if ((await core.hook('beforeWrite', ctx)) !== undefined) {
    throw new TypeError('beforeWrite may only replace data for write and set');
  }
  const scope = core.scopeOf(id, data ?? current?.data ?? {});
  core.observe(latestClock(current?.meta, true), id);
  core.observe(latestClock(meta), id);
  const op = { origin: core.nodeId, seq: 0, ts: core.clock.now(), type: 'merge', id };
  if (scope !== GLOBAL_SCOPE) op.scope = scope;
  if (from) op.from = from;
  if (data !== undefined) op.data = data;
  if (meta !== undefined) op.meta = meta;
  const { entry, changed, delta, rejected, changes } = applyOp(current, op, core.limits);
  // A block of a kind no plugin here knows is left out of what this node
  // holds: told once per record, since the field is gone for its peers too.
  for (const refusal of rejected) {
    if (refusal.reason === 'kind') {
      core.logger.warn({ event: 'sync.record.kind', id, field: refusal.field, kind: refusal.kind });
    }
  }
  if (!changed) {
    if (otel.enabled) otel.recordCommit('merge', 'noop', now() - started);
    return;
  }
  op.seq = ++batch.seq;
  batch.ops.push(op);
  batch.touched.set(id, entry);
  // A record the snapshot carries as purged: what this node held of it —
  // a peer's ops taken before the purge — is scrubbed once the batch is durable.
  if (entry.meta.purged) (batch.purged ??= new Set()).add(id);
  // The batch's own object, joined in place (a path is never `__proto__`).
  let joined = batch.deltas.get(id);
  if (joined === undefined) batch.deltas.set(id, (joined = {}));
  Object.assign(joined, delta);
  batch.pending.push({ ctx, op, started, changes });
};

/**
 * The bootstrap write path: a snapshot page as merge ops of this node's
 * own, under one turn of the mutation queue — one log append, one chain
 * block, one catalog flush — with each record announced on its own, like a
 * local write.
 */
const mergeBatch = async (core, records, via, from) => {
  const batch = {
    core,
    via,
    from,
    horizon: Date.now() + core.maxSkew,
    seq: core.log.seqOf(opKey({ origin: core.nodeId, type: 'merge' })),
    ops: [],
    touched: new Map(),
    deltas: new Map(),
    pending: [],
    purged: null,
  };
  for (const record of records) await mergeOne(batch, record);
  if (batch.ops.length === 0) return;
  // Chained and signed here, not in mergeOne: an op's seq is assigned after
  // applyOp, and the link and the signature cover it. The joiner signs the
  // host's state as its own — a snapshot record carries no provenance to
  // sign over.
  const fps = await link(batch.ops, core.fingerprintOf, core.sign !== null);
  if (core.sign !== null) for (const op of batch.ops) await core.sign(op);
  const entries = await core.log.append(batch.ops, { fps });
  const first = entries[0].seq;
  const last = entries[entries.length - 1].seq;
  if (await core.persist(batch.touched, first, last)) core.log.applied(first, last);
  if (batch.purged) for (const id of batch.purged) await core.scrub(id);
  core.flush();
  const changes = [];
  for (const { ctx, op, started, changes: own } of batch.pending) {
    try {
      await core.hook('afterWrite', ctx, op);
    } finally {
      const entry = batch.touched.get(op.id);
      core.refresh(op.id, isAlive(entry) ? entry.data : null, batch.deltas.get(op.id), null, entry);
      notify(core.storage, core.logger, 'change', op, via, { changes: own });
      for (const change of own) changes.push({ id: op.id, ...change });
      if (core.otel.enabled) core.otel.recordCommit('merge', 'applied', now() - started);
    }
  }
  if (core.storage.listenerCount('transaction') > 0) {
    const ts = batch.ops[batch.ops.length - 1].ts;
    const event = { local: true, via, source: null, message: null, ops: batch.ops, changes, ts };
    notify(core.storage, core.logger, 'transaction', event);
  }
};

// The highest seq this node takes for a stream of its own from a host
// (REWOUND): room left for 2^32 more ops before a seq is no safe integer —
// past that every peer would refuse its ops as malformed.
const MAX_ADOPTED = Number.MAX_SAFE_INTEGER - 2 ** 32;

// Whether `key` is a stream of this node's own: `origin`, `origin@scope`.
const ownKey = (core, key) => key === core.nodeId || key.startsWith(`${core.nodeId}@`);

/**
 * Records that everything up to `vector` is reflected in this node's state
 * (a snapshot of it was just joined). It travels as an `advance` op in this
 * node's own log, so a peer replaying the merges that carried the state
 * also learns which ops they cover — and does not report the next live op
 * of those origins as a gap. This node's own streams are not a peer's to
 * move: their keys are left out — but with `own`, the REWOUND path, which
 * takes them alone, up to MAX_ADOPTED (src/sync/manager.js `#rewind`), with
 * the ops its proof carried (`proofs`, checked there): each the head of its
 * stream from now on, what the next op of it chains to — a stream taken
 * without one names no predecessor.
 */
const adopt = async (core, vector, { via = null, from = null, own = false, proofs = null } = {}) => {
  const known = core.log.vector;
  const news = {};
  // A peer's vector: own keys alone, read as values.
  for (const key of Object.keys(vector)) {
    const seq = vector[key];
    if (key === '__proto__' || ownKey(core, key) !== own) continue;
    if (!Number.isSafeInteger(seq) || seq <= 0 || (own && seq > MAX_ADOPTED)) continue;
    if ((known[key] ?? 0) < seq) news[key] = seq;
  }
  if (Object.keys(news).length === 0) return null;
  if (own && proofs !== null) {
    const heads = {};
    for (const proof of proofs) heads[opKey(proof)] = [proof.seq, await fingerprintOf(proof)];
    core.log.adoptHeads(heads);
  }
  const op = { origin: core.nodeId, seq: 0, ts: core.clock.now(), type: 'advance', vector: news };
  if (from) op.from = from;
  // Numbered after what it adopts of its own stream (REWOUND on `@~`): the
  // seqs below are the host's already.
  const key = opKey(op);
  op.seq = Math.max(known[key] ?? 0, news[key] ?? 0) + 1;
  const fps = await link([op], core.fingerprintOf, core.sign !== null);
  if (core.sign !== null) await core.sign(op);
  const [{ seq }] = await core.log.append([op], { fps });
  await core.log.advance(news);
  core.log.applied(seq);
  notify(core.storage, core.logger, 'change', op, via);
  return op;
};

module.exports = { snapshotPage, mergeBatch, adopt };
