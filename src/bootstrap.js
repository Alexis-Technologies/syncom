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
const { notify } = require('./hooks.js');
const { traced, now } = require('./telemetry.js');
const { GLOBAL_SCOPE, inScope } = require('./scope.js');
const { isPlainObject, asJson, isRecordId } = require('./shape.js');

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
    if (!inScope(core.scopeOf(id, entry.data), scopes)) continue;
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
  if (!isPlainObject(record) || !isRecordId(record.id)) {
    core.logger.warn({ event: 'sync.record.malformed', id: isPlainObject(record) ? record.id : typeof record });
    return;
  }
  const { id } = record;
  // A stamp beyond the skew allowed is refused here as an op's is in
  // applyRemote: a snapshot is the other way a clock reaches this node.
  const latest = latestClock(record.meta);
  if (latest !== null && latest[0] > batch.horizon) {
    core.logger.warn({ event: 'sync.record.skew', id, ts: latest[0], ahead: latest[0] - batch.horizon });
    return;
  }
  const started = otel.enabled ? now() : 0;
  const data = asJson(record.data);
  const meta = asJson(record.meta);
  const current = batch.touched.get(id) ?? (await core.entries.load(id));
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
  core.observe(latestClock(current?.meta));
  core.observe(latestClock(meta));
  const op = { origin: core.nodeId, seq: 0, ts: core.clock.now(), type: 'merge', id };
  if (scope !== GLOBAL_SCOPE) op.scope = scope;
  if (from) op.from = from;
  if (data !== undefined) op.data = data;
  if (meta !== undefined) op.meta = meta;
  const { entry, changed, delta } = applyOp(current, op);
  if (!changed) {
    if (otel.enabled) otel.recordCommit('merge', 'noop', now() - started);
    return;
  }
  op.seq = ++batch.seq;
  batch.ops.push(op);
  batch.touched.set(id, entry);
  batch.deltas.set(id, { ...(batch.deltas.get(id) ?? {}), ...delta });
  batch.pending.push({ ctx, op, started });
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
  };
  for (const record of records) await mergeOne(batch, record);
  if (batch.ops.length === 0) return;
  const entries = await core.log.append(batch.ops);
  const first = entries[0].seq;
  const last = entries[entries.length - 1].seq;
  await core.persist(batch.touched, first, last);
  core.log.applied(first, last);
  core.flush();
  for (const { ctx, op, started } of batch.pending) {
    try {
      await core.hook('afterWrite', ctx, op);
    } finally {
      const entry = batch.touched.get(op.id);
      core.refresh(op.id, isAlive(entry) ? entry.data : null, batch.deltas.get(op.id));
      notify(core.storage, core.logger, 'change', op, via);
      if (core.otel.enabled) core.otel.recordCommit('merge', 'applied', now() - started);
    }
  }
};

/**
 * Records that everything up to `vector` is reflected in this node's state
 * (a snapshot of it was just joined). It travels as an `advance` op in this
 * node's own log, so a peer replaying the merges that carried the state
 * also learns which ops they cover — and does not report the next live op
 * of those origins as a gap.
 */
const adopt = async (core, vector, { via = null, from = null } = {}) => {
  const known = core.log.vector;
  const news = {};
  for (const key in vector) {
    if (Number.isInteger(vector[key]) && (known[key] ?? 0) < vector[key]) news[key] = vector[key];
  }
  if (Object.keys(news).length === 0) return null;
  const op = { origin: core.nodeId, seq: 0, ts: core.clock.now(), type: 'advance', vector: news };
  if (from) op.from = from;
  op.seq = (known[opKey(op)] ?? 0) + 1;
  const [{ seq }] = await core.log.append([op]);
  await core.log.advance(news);
  core.log.applied(seq);
  notify(core.storage, core.logger, 'change', op, via);
  return op;
};

module.exports = { snapshotPage, mergeBatch, adopt };
