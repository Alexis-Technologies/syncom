'use strict';

// A peer's batch, applied: `storage.applyRemote(ops)` lands here, inside the
// mutation queue. Every op is admitted (well-formed, inside the skew
// horizon, the next of its stream), applied one by one, and the batch is
// then made durable — log first, then the records — and announced. This is
// the trust boundary: nothing below `admit` reads a field it did not check.
// `core` is what Storage lends its write paths — see Storage#open.

const { applyOp, isAlive } = require('./ops.js');
const { vectorHas, vectorNext, vectorAdvance, keyScope } = require('./vector.js');
const { notify } = require('./hooks.js');
const { inScope } = require('./scope.js');
const { traced, now } = require('./telemetry.js');
const { isPlainObject, VALIDATED, wellFormed } = require('./shape.js');

const NOTHING = { applied: 0, skipped: 0, duplicates: 0, gaps: 0, malformed: 0 };

// What one batch accumulates: the ops it accepts (logged, whether or not
// they changed anything), the entries it touched and their deltas, and the
// counts the result reports. `vector` is this node's, advanced as ops are
// accepted so the next op of a stream is seen as the next.
const openBatch = (core, { via = null, scopes = null, peer = null, adoptFrom = null } = {}) => {
  const at = Date.now();
  return {
    core,
    via,
    peer,
    scopes,
    adoptFrom,
    vector: core.log.vector,
    now: at,
    horizon: at + core.maxSkew,
    accepted: [],
    touched: new Map(),
    deltas: new Map(),
    adopted: null,
    skipped: null,
    held: null,
    purged: null,
    duplicates: 0,
    gaps: 0,
    malformed: 0,
  };
};

// Accepted: logged and relayed, the vector moves.
const accept = (batch, op) => {
  vectorAdvance(batch.vector, op);
  batch.accepted.push(op);
};

// Accepted but not applied HERE: still logged (flagged `skipped`, so a
// replay leaves it alone) and relayed — the vector must move, or the peer
// would offer the op forever, and a hole in this log would be a gap for
// everyone resuming from it.
const skip = (batch, op) => {
  accept(batch, op);
  (batch.skipped ??= new Set()).add(op);
};

// Refused and reported: a `warn`, the `rejected` metric and an `error`
// event carrying the op and a code.
const report = (batch, event, reason, error) => {
  const { core } = batch;
  core.logger.warn(event);
  core.otel.recordRejected(reason);
  notify(core.storage, core.logger, 'error', error);
};

// The peer joined a snapshot covering these seqs; so, through its merges,
// have we — when the op is that peer's own and came down its feed (the
// merges came first), for the scopes we take from it. Pushed or relayed, an
// advance is logged and passed on but grants nothing: the vector is the one
// thing a peer must not be able to move on another node's behalf.
const adopt = (batch, op) => {
  if (batch.adoptFrom === null || op.origin !== batch.adoptFrom) return;
  const { vector } = batch;
  for (const key of Object.keys(op.vector)) {
    const seq = op.vector[key];
    const scope = keyScope(key);
    const taken = scope === null || inScope(scope, batch.scopes);
    if (taken && key !== '__proto__' && Number.isSafeInteger(seq) && (vector[key] ?? 0) < seq) {
      vector[key] = seq;
      (batch.adopted ??= {})[key] = seq;
    }
  }
};

// Whether `op` goes on to be applied. Malformed ops and skewed stamps are
// counted and dropped (not observed: this node's clock stays where it is);
// what the vector already covers is a duplicate, what skips ahead a gap —
// the peer will be asked again from the last position. An advance is
// accepted here, with nothing to apply.
const admit = (batch, op) => {
  const { core, vector } = batch;
  if (!wellFormed(op)) {
    const shape = isPlainObject(op) ? { origin: op.origin, seq: op.seq, type: op.type, id: op.id } : typeof op;
    core.logger.warn({ event: 'sync.op.malformed', op: shape });
    core.otel.recordMalformed();
    batch.malformed++;
    return false;
  }
  if (op.ts > batch.horizon) {
    const ahead = op.ts - batch.now;
    core.logger.warn({ event: 'sync.op.skew', origin: op.origin, seq: op.seq, ts: op.ts, ahead });
    core.otel.recordMalformed();
    batch.malformed++;
    const message = `Op ${op.origin}:${op.seq} is stamped ${ahead} ms ahead of this node (maxSkew ${core.maxSkew})`;
    notify(core.storage, core.logger, 'error', Object.assign(new Error(message), { op, code: 'SKEW' }));
    return false;
  }
  if (op.origin === core.nodeId || vectorHas(vector, op)) {
    batch.duplicates++;
    return false;
  }
  if (!vectorNext(vector, op)) {
    batch.gaps++;
    return false;
  }
  if (op.type !== 'advance') return true;
  adopt(batch, op);
  accept(batch, op);
  return false;
};

// The record as it is here, or `undefined` when its file is torn or fails
// its integrity check: then this op cannot land, and must not stop the page
// or the stream — it is skipped like a beforeApply `false` and reported; the
// record stays as it is for a read to report.
const currentOf = async (batch, op) => {
  const { core } = batch;
  try {
    return batch.touched.get(op.id) ?? (await core.entries.load(op.id));
  } catch (error) {
    const message = `Record ${op.id} is unreadable here; op ${op.origin}:${op.seq} skipped`;
    const reported = Object.assign(new Error(message, { cause: error }), { op, code: 'OP_UNREADABLE' });
    report(batch, { event: 'sync.op.unreadable', id: op.id, err: error }, 'unreadable', reported);
    skip(batch, op);
    return undefined;
  }
};

// A unique key the op leaves shared with another record: applied — the op is
// in the peer's log already — and reported; the application decides which
// record yields.
const reportConflicts = async (batch, op, entry) => {
  const { core } = batch;
  let conflicts = [];
  try {
    conflicts = await core.conflicts(op.id, entry);
  } catch (error) {
    // A lens that throws for this record: the op is applied as it is (the
    // record is the peer's); only the unique check is lost.
    core.logger.warn({ event: 'sync.op.lens', id: op.id, err: error });
  }
  for (const { fields, other } of conflicts) {
    core.otel.recordConflict('unique');
    const entity = entry.data.$type;
    notify(core.storage, core.logger, 'conflict', { kind: 'unique', entity, fields, id: op.id, other, op });
  }
};

// One admitted op, applied to the record it names.
const applyOne = async (batch, op) => {
  const { core } = batch;
  // From a newer schema version than this node runs: applied as it is
  // (registers are forward-tolerant; the validator does not know the
  // shape), or held in the log until this node runs that version.
  const ahead = core.version !== null && Number.isInteger(op.v) && op.v > core.version;
  if (ahead && core.ahead === 'hold') {
    skip(batch, op);
    (batch.held ??= new Map()).set(op, op.v);
    notify(core.storage, core.logger, 'schema', { kind: 'ahead', op, held: true });
    return;
  }
  const current = await currentOf(batch, op);
  if (current === undefined) return;
  if (current?.encrypted) {
    core.logger.warn({ event: 'sync.op.encrypted', id: op.id });
    accept(batch, op);
    return;
  }
  // A `false` from beforeApply skips the op HERE only. A throw aborts the
  // batch — nothing is durable yet, so the peer sees a failed push and
  // offers the page again.
  const visible = current && isAlive(current) ? current.data : null;
  const verdict = await core.hook('beforeApply', { op, via: batch.via, peer: batch.peer, current: visible });
  if (verdict === false) return void skip(batch, op);
  core.clock.observe(op.ts);
  const { entry, changed, delta, rejected } = applyOp(current, op);
  if (rejected.length > 0) {
    const error = Object.assign(new Error(`Refused op on ${op.id}`), { op, code: 'OP_REFUSED', rejected });
    report(batch, { event: 'sync.op.rejected', id: op.id, rejected }, rejected[0].reason, error);
  }
  // Invalid under this node's schema: skipped like a beforeApply `false` —
  // logged, relayed, replay-safe — and reported.
  const invalid = changed && !ahead ? await core.invalid(op, entry) : null;
  if (invalid) {
    const error = Object.assign(new Error(`Invalid op on ${op.id}`), { op, code: 'OP_INVALID', ...invalid });
    report(batch, { event: 'sync.op.invalid', id: op.id, ...invalid }, 'validation', error);
    return void skip(batch, op);
  }
  if (ahead) notify(core.storage, core.logger, 'schema', { kind: 'ahead', op, held: false });
  accept(batch, op);
  core.otel.recordLag(op.ts);
  // A purge, and anything that lands on a purged record, is scrubbed from
  // this log too, once the batch is durable.
  if (entry.meta.purged) (batch.purged ??= new Set()).add(op.id);
  if (!changed) return;
  if (VALIDATED.has(op.type)) await reportConflicts(batch, op, entry);
  batch.touched.set(op.id, entry);
  batch.deltas.set(op.id, { ...(batch.deltas.get(op.id) ?? {}), ...delta });
};

// Log first, then the records, then the log is told the batch landed; a
// purged id is scrubbed once everything is durable.
const persist = async (batch) => {
  const { core, accepted, touched } = batch;
  if (accepted.length === 0) return;
  const entries = await core.log.append(accepted, { skipped: batch.skipped, held: batch.held });
  const first = entries[0].seq;
  const last = entries[entries.length - 1].seq;
  if (batch.adopted) await core.log.advance(batch.adopted);
  if (touched.size > 0) {
    await core.persist(touched, first, last);
    core.flush();
  }
  core.log.applied(first, last);
  if (batch.purged) for (const id of batch.purged) await core.log.scrub(id);
};

// afterApply sees a durable batch; whatever it does, the record views and
// the listeners (the relay among them) hear about every op.
const announce = async (batch, result) => {
  const { core, via, peer, accepted, touched } = batch;
  try {
    await core.hook('afterApply', { via, peer, ops: accepted, ...result });
  } finally {
    for (const [id, entry] of touched) core.refresh(id, isAlive(entry) ? entry.data : null, batch.deltas.get(id));
    notify(core.storage, core.logger, 'apply', { via, peer, ops: accepted, ...result });
    for (const op of accepted) notify(core.storage, core.logger, 'change', op, via);
  }
};

const applyRemote = async (core, ops, options) => {
  const batch = openBatch(core, options);
  for (const op of ops) {
    if (admit(batch, op)) await applyOne(batch, op);
  }
  const result = {
    applied: batch.accepted.length,
    skipped: batch.skipped?.size ?? 0,
    duplicates: batch.duplicates,
    gaps: batch.gaps,
    malformed: batch.malformed,
  };
  await persist(batch);
  await announce(batch, result);
  return result;
};

const tracedApply = async (core, ops, options) => {
  const { otel } = core;
  const started = now();
  let result = null;
  try {
    const attributes = { 'syncom.ops.count': ops.length };
    result = await traced(
      otel,
      'syncom.apply',
      attributes,
      () => applyRemote(core, ops, options),
      (r) => ({
        'syncom.ops.applied': r.applied,
        'syncom.ops.skipped': r.skipped,
        'syncom.ops.duplicates': r.duplicates,
        'syncom.ops.gaps': r.gaps,
        'syncom.ops.malformed': r.malformed,
      }),
    );
    return result;
  } finally {
    otel.recordApply(result ?? NOTHING, now() - started);
  }
};

/** A peer's batch, run inside the mutation queue. Returns the counts. */
const applyBatch = (core, ops, options = {}) => {
  if (!core.otel.enabled) return applyRemote(core, ops, options);
  return tracedApply(core, ops, options);
};

module.exports = { applyBatch };
