'use strict';

// A peer's batch, applied: `storage.applyRemote(ops)` lands here, inside the
// mutation queue. Every op's signature is checked and its fingerprint taken
// first (a pre-pass over the page), then every op is admitted (well-formed,
// inside the skew horizon, the next of its stream, following the op this
// node holds before it), applied one by one, and the batch is then made
// durable — log first, then the records — and announced. This is the trust
// boundary: nothing below `admit` reads a field it did not check. `core` is
// what Storage lends its write paths — see Storage#open.

const { applyOp, isAlive, latestClock, settleMeta } = require('./ops.js');
const { keyScope, opKey } = require('./vector.js');
const { fingerprintOf, scrubOp } = require('./header.js');
const { inScope } = require('./scope.js');
const { traced, now } = require('./telemetry/writer.js');
const { isPlainObject, VALIDATED, wellFormed, VERDICT } = require('./shape.js');
const { SyncomError } = require('./errors.js');

const { OK, FORGED } = VERDICT;

const NOTHING = {
  applied: 0,
  skipped: 0,
  duplicates: 0,
  gaps: 0,
  malformed: 0,
  unsigned: 0,
  forged: 0,
  outOfScope: 0,
  equivocations: 0,
};
// Signatures are verified this many at a time under Promise.all: the
// verdicts are independent, and both halves verify off the main thread —
// node:crypto on libuv's thread pool, Web Crypto on its own — so a chunk is
// checked several at once rather than one after another.
const VERIFY_CHUNK = 64;

// What one batch accumulates: the ops it accepts (logged, whether or not
// they changed anything), the entries it touched and their deltas, and the
// counts the result reports. `vector` is this node's, advanced as ops are
// accepted so the next op of a stream is seen as the next; `fps` the
// fingerprints of the ops admitted, `prints` of the ones accepted, by stream
// and seq, what this log holds once they are appended. `bound` is the scopes
// of the peer that pushed the page, on a host: the records it may write.
const openBatch = (core, { via = null, scopes = null, peer = null, adoptFrom = null, bound = null } = {}) => {
  const at = Date.now();
  return {
    core,
    via,
    peer,
    scopes,
    adoptFrom,
    bound,
    // The seqs this batch moved, by stream; every other is the log's, read
    // one key at a time (`seqIn`) — a hub's vector, thousands of streams,
    // was copied whole for every page.
    vector: {},
    fps: new Map(),
    prints: null,
    now: at,
    horizon: at + core.maxSkew,
    accepted: [],
    touched: new Map(),
    deltas: new Map(),
    changes: new Map(),
    adopted: null,
    skipped: null,
    held: null,
    purged: null,
    duplicates: 0,
    gaps: 0,
    malformed: 0,
    signatures: core.signatures,
    unsigned: 0,
    forged: 0,
    outOfScope: 0,
    equivocations: 0,
    firstUnsigned: null,
    firstForged: null,
    firstEquivocation: null,
  };
};

// One op's verdict, contained: a check that throws — synchronously or not —
// is a signature that does not check, FORGED for that op alone. A throw out
// of the page would fail it whole (PAGE_FAILED, then STUCK): one hostile op
// would stop the stream it rides on.
const verdictOf = async (core, op, signatures) => {
  try {
    return await core.verify(op, signatures);
  } catch {
    return FORGED;
  }
};

// An op's fingerprint (src/header.js) — a string in Node.js, a promise in
// the browser — or null when it cannot be taken: a value JSON cannot read,
// as malformed as a shape that does not check.
const printOf = (op) => {
  try {
    return fingerprintOf(op);
  } catch {
    return null;
  }
};

// The verdict on every op of the page and its fingerprint, before any is
// admitted — `admit` must stay sequential (each accept moves the vector),
// verification and hashing need not. A malformed op has no fingerprint
// (null), which `admit` counts. Only a well-formed op that carries a
// signature is verified, and under 'require' every well-formed one; the
// rest is OK by rule, which is what keeps an unsigned page — a node's
// without the signing plugin — at a property check and a hash per op. Never throws.
const checkPage = async (batch, ops) => {
  const { signatures, core } = batch;
  // No signing plugin: nothing to check against — a peer's signature rides
  // along unread, the 'verify' semantics for an unsigned op.
  const verifying = signatures !== false && core.verify !== null;
  const verdicts = [];
  const fps = [];
  const pending = [];
  for (let start = 0; start < ops.length; start += VERIFY_CHUNK) {
    pending.length = 0;
    for (let i = start; i < ops.length && i < start + VERIFY_CHUNK; i++) {
      const op = ops[i];
      verdicts.push(OK);
      fps.push(null);
      if (!wellFormed(op)) continue;
      const fp = printOf(op);
      if (fp === null || typeof fp === 'string') fps[i] = fp;
      else pending.push(fp.then((value) => void (fps[i] = value)).catch(() => {}));
      if (!verifying || (op.sig === undefined && signatures !== 'require')) continue;
      pending.push(verdictOf(core, op, signatures).then((verdict) => void (verdicts[i] = verdict)));
    }
    if (pending.length > 0) await Promise.all(pending);
  }
  return { verdicts, fps };
};

// Refused before admission: counted per op (the metric), remembered once
// per page (the event — a page of forgeries is one listener call, not 500).
// Neither logged nor relayed, the vector unmoved: like a malformed op, a
// refused one is a gap for its stream until it comes again, intact.
const refuseSignature = (batch, op, verdict) => {
  if (verdict === FORGED) {
    batch.forged++;
    batch.firstForged ??= op;
  } else {
    batch.unsigned++;
    batch.firstUnsigned ??= op;
  }
  batch.core.otel.recordRejected(verdict);
};

const reportSignatures = (batch) => {
  const { core } = batch;
  if (batch.forged > 0) {
    const op = batch.firstForged;
    const count = batch.forged;
    core.logger.warn({ event: 'sync.op.forged', origin: op.origin, seq: op.seq, count });
    const message = `Op ${op.origin}:${op.seq} does not verify against its origin (${count} in this page)`;
    core.emit('error', new SyncomError('BAD_SIGNATURE', message, { op, count }));
  }
  if (batch.unsigned > 0) {
    const op = batch.firstUnsigned;
    const count = batch.unsigned;
    core.logger.warn({ event: 'sync.op.unsigned', origin: op.origin, seq: op.seq, count });
    const message = `Op ${op.origin}:${op.seq} carries no signature; sync.signatures is 'require' (${count} in this page)`;
    core.emit('error', new SyncomError('UNSIGNED', message, { op, count }));
  }
};

// A field of a kind this node runs no plugin for: every op of it is refused
// the same way — a hub without the text plugin refuses every keystroke it
// relays — so the metric counts each, and the warn and the `error` event
// come once per page, with the count and the kinds.
const onlyKinds = (rejected) => {
  for (let i = 0; i < rejected.length; i++) if (rejected[i].reason !== 'kind') return false;
  return true;
};
const refuseKind = (batch, op, rejected) => {
  batch.core.otel.recordRejected('kind');
  if (batch.kinds === undefined) batch.kinds = { op, rejected, count: 0, names: new Set() };
  batch.kinds.count++;
  for (let i = 0; i < rejected.length; i++) batch.kinds.names.add(rejected[i].kind);
};
const reportKinds = (batch) => {
  if (batch.kinds === undefined) return;
  const { core } = batch;
  const { op, rejected, count, names } = batch.kinds;
  const kinds = [...names];
  core.logger.warn({ event: 'sync.op.rejected', id: op.id, rejected, count, kinds });
  const message = `Refused ${count} op${count > 1 ? 's' : ''} of a kind this node runs no plugin for (${kinds.join(', ')})`;
  core.emit('error', new SyncomError('OP_REFUSED', message, { op, rejected, count, kinds }));
};

// The fingerprint this node holds for the op at `seq` of the stream `key`:
// one accepted earlier in this batch, else the log's — or undefined.
const heldAt = (batch, key, seq) => batch.prints?.get(key)?.get(seq) ?? batch.core.log.fingerprintOf(key, seq);

// The seq this node holds of stream `key`, as the batch has moved it.
const seqIn = (batch, key) => (Object.hasOwn(batch.vector, key) ? batch.vector[key] : batch.core.log.seqOf(key));
const advanceIn = (batch, op) => {
  const key = opKey(op);
  if (seqIn(batch, key) < op.seq) batch.vector[key] = op.seq;
};

// Accepted: logged and relayed, the vector moves, and its fingerprint is
// what the stream's next op is held to.
const accept = (batch, op) => {
  advanceIn(batch, op);
  batch.accepted.push(op);
  const key = opKey(op);
  let seqs = (batch.prints ??= new Map()).get(key);
  if (seqs === undefined) batch.prints.set(key, (seqs = new Map()));
  seqs.set(op.seq, batch.fps.get(op));
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
  core.emit('error', error);
};

// The peer joined a snapshot covering these seqs; so, through its merges,
// have we — when the op is that peer's own and came down its feed (the
// merges came first), for the scopes we take from it. Pushed or relayed, an
// advance is logged and passed on but grants nothing: the vector is the one
// thing a peer must not be able to move on another node's behalf. Nor this
// node's own streams, whoever says so: a seq moved there is a gap at every
// other peer, or a stream past a safe integer and malformed everywhere.
const adopt = (batch, op) => {
  if (batch.adoptFrom === null || op.origin !== batch.adoptFrom) return;
  const { vector, core } = batch;
  const own = `${core.nodeId}@`;
  for (const key of Object.keys(op.vector)) {
    const seq = op.vector[key];
    if (key === '__proto__' || key === core.nodeId || key.startsWith(own)) continue;
    const scope = keyScope(key);
    const taken = scope === null || inScope(scope, batch.scopes);
    if (taken && Number.isSafeInteger(seq) && seq > 0 && seqIn(batch, key) < seq) {
      vector[key] = seq;
      (batch.adopted ??= {})[key] = seq;
    }
  }
};

// Equivocation: the op's writer made two ops at one seq of one stream — this
// node holds the other (`reason: 'seq'`) — or this op follows another op at
// the seq before it than the one held here (`'chain'`: its `prev` names
// another fingerprint, or none where it is signed). A directory restored
// from a backup, a second instance under one identity, or a key holder that
// lies. Refused like a forged op — neither logged nor relayed, the vector
// unmoved — counted per op, reported once per page with both fingerprints.
const equivocates = (batch, op, reason, held, received) => {
  batch.equivocations++;
  batch.firstEquivocation ??= { op, reason, held, received };
  batch.core.otel.recordRejected(reason === 'chain' ? 'chain' : 'equivocation');
  return false;
};

const reportEquivocations = (batch) => {
  if (batch.equivocations === 0) return;
  const { core } = batch;
  const { op, reason, held, received } = batch.firstEquivocation;
  const count = batch.equivocations;
  const fields = { origin: op.origin, scope: op.scope ?? null, seq: op.seq, reason, held, received, count };
  core.logger.warn({ event: 'sync.op.equivocation', ...fields });
  const message =
    reason === 'chain'
      ? `Op ${op.origin}:${op.seq} does not follow the op this node holds at seq ${op.seq - 1} (${count} in this page)`
      : `Op ${op.origin}:${op.seq} is not the op this node holds at that seq (${count} in this page)`;
  core.emit('error', new SyncomError('EQUIVOCATION', message, { op, ...fields }));
};

// The newest stamp a merge's meta holds — a peer's whole meta, every stamp
// of it observed once the record is written here — or null.
const newestHeld = (core, op) => {
  // A peer's op is its page's, never changed after it arrived: its meta is
  // normalized once for this check and the join that follows.
  const latest = latestClock(settleMeta(op.meta), false, core.limits);
  return latest === null ? null : latest[0];
};

// A stamp beyond the horizon: a broken clock or a poisoned one, never a
// concurrent write. Counted with the malformed, reported, never observed.
const skewed = (batch, op, ts) => {
  const { core } = batch;
  const ahead = ts - batch.now;
  core.logger.warn({ event: 'sync.op.skew', origin: op.origin, seq: op.seq, ts, ahead });
  core.otel.recordMalformed();
  batch.malformed++;
  const message = `Op ${op.origin}:${op.seq} carries a stamp ${ahead} ms ahead of this node (maxSkew ${core.maxSkew})`;
  core.emit('error', new SyncomError('SKEW', message, { op }));
  return false;
};

// Whether `op` goes on to be applied. Malformed ops and skewed stamps — the
// op's own, or one its merge meta holds (read once the op is the next of its
// stream: a duplicate costs no fold of its meta) — are counted and dropped
// (not observed: this node's clock stays where it is); what the vector
// already covers is a duplicate, what skips ahead a gap — the peer will be
// asked again from the last position. Held to the fingerprints this node
// keeps (`fp`, from checkPage — null for a malformed op): a duplicate that
// is another op than the one held at its seq, and a next op whose `prev` is
// not the one held at the seq before it, are equivocation. A next op this
// node holds no predecessor for — the stream starts with it, or came by a
// snapshot — is taken, and the chain held from it; so is an unsigned op that
// names none (a hand-made one: `applyRemote` takes what a caller built). An advance is accepted
// here, with nothing to apply.
const admit = (batch, op, fp) => {
  const { core } = batch;
  if (fp === null) {
    const shape = isPlainObject(op) ? { origin: op.origin, seq: op.seq, type: op.type, id: op.id } : typeof op;
    core.logger.warn({ event: 'sync.op.malformed', op: shape });
    core.otel.recordMalformed();
    batch.malformed++;
    return false;
  }
  if (op.ts > batch.horizon) return skewed(batch, op, op.ts);
  const key = opKey(op);
  if (op.origin === core.nodeId || seqIn(batch, key) >= op.seq) {
    const held = heldAt(batch, key, op.seq);
    if (held !== undefined && held !== fp) return equivocates(batch, op, 'seq', held, fp);
    batch.duplicates++;
    return false;
  }
  if (seqIn(batch, key) + 1 !== op.seq) {
    batch.gaps++;
    return false;
  }
  const before = op.seq > 1 ? heldAt(batch, key, op.seq - 1) : undefined;
  if (before !== undefined && op.prev !== before && (op.prev !== undefined || op.sig !== undefined)) {
    return equivocates(batch, op, 'chain', before, op.prev ?? null);
  }
  batch.fps.set(op, fp);
  if (op.type === 'merge') {
    const held = newestHeld(core, op);
    if (held !== null && held > batch.horizon) return skewed(batch, op, held);
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
    return batch.touched.get(op.id) ?? (await core.current(op.id));
  } catch (error) {
    const message = `Record ${op.id} is unreadable here; op ${op.origin}:${op.seq} skipped`;
    const reported = new SyncomError('OP_UNREADABLE', message, { cause: error, op });
    report(batch, { event: 'sync.op.unreadable', id: op.id, err: error }, 'unreadable', reported);
    skip(batch, op);
    return undefined;
  }
};

// The record as the op leaves it, as far as its scope goes: a write's or a
// merge's own data, a set's on top of the record's, the record's for the rest.
const dataAfter = (op, current) => {
  const data = current?.data ?? {};
  if (!isPlainObject(op.data)) return data;
  if (op.type === 'write' || op.type === 'merge') return op.data;
  if (op.type === 'set') return { ...data, ...op.data };
  return data;
};

// A peer pushing to a host writes only records it may read: the scope the
// op declares is the peer's claim (src/sync/hosting.js holds it to the grant);
// the record's own, before the op and after it, is what this node's
// `sync.scope` makes of the data. Outside the grant — or a scope function
// that throws on it — the op is refused like a forged one: not logged, not
// relayed, a gap in its stream. Relaying it as skipped would hand the write
// to every peer of the declared scope.
const outOfBounds = (batch, op, current) => {
  const { core, bound } = batch;
  if (bound === null) return false;
  try {
    if (current && !inScope(core.scopeOf(op.id, current.data), bound)) return true;
    return !inScope(core.scopeOf(op.id, dataAfter(op, current)), bound);
  } catch (error) {
    core.logger.warn({ event: 'sync.op.scope', id: op.id, err: error });
    return true;
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
    core.emit('conflict', { kind: 'unique', entity, fields, id: op.id, other, op });
  }
};

// One admitted op, applied to the record it names.
const applyOne = async (batch, op) => {
  const { core } = batch;
  // From a newer schema version than this node runs: applied as it is
  // (registers are forward-tolerant; the validator does not know the
  // shape), or held in the log until this node runs that version.
  const ahead = core.version !== null && Number.isInteger(op.v) && op.v > core.version;
  // Checked before anything else may log the op, a held one included.
  if (batch.bound !== null) {
    const current = await currentOf(batch, op);
    if (current === undefined) return;
    if (outOfBounds(batch, op, current)) {
      batch.outOfScope++;
      return;
    }
  }
  if (ahead && core.ahead === 'hold') {
    skip(batch, op);
    (batch.held ??= new Map()).set(op, op.v);
    core.emit('schema', { kind: 'ahead', op, held: true });
    return;
  }
  const current = await currentOf(batch, op);
  if (current === undefined) return;
  // What lands on a record purged before it is logged and relayed as a scrub
  // leaves it — the header and the signature, never the payload: scrubbing
  // it after the append rewrote log files on any peer's say, and the
  // payload went on to every peer this node relays to. A merge is the purge
  // stamp's way across, and a purge has no payload.
  if (current?.meta?.purged != null && op.type !== 'purge' && op.type !== 'merge') {
    scrubOp(op);
    (batch.stripped ??= new Set()).add(op);
  }
  if (current?.encrypted) {
    // Sealed here for this node alone: the op is logged and relayed, never
    // applied — flagged skipped, so neither a replay nor a fold of the log
    // applies what this node did not.
    core.logger.warn({ event: 'sync.op.encrypted', id: op.id });
    skip(batch, op);
    return;
  }
  // A `false` from beforeApply skips the op HERE only. A throw aborts the
  // batch — nothing is durable yet, so the peer sees a failed push and
  // offers the page again.
  const visible = current && isAlive(current) ? current.data : null;
  const verdict = await core.hook('beforeApply', { op, via: batch.via, peer: batch.peer, current: visible });
  if (verdict === false) return void skip(batch, op);
  core.clock.observe(op.ts);
  const { entry, changed, delta, rejected, changes } = applyOp(current, op, core.limits);
  if (rejected.length > 0) {
    if (onlyKinds(rejected)) refuseKind(batch, op, rejected);
    else {
      const error = new SyncomError('OP_REFUSED', `Refused op on ${op.id}`, { op, rejected });
      report(batch, { event: 'sync.op.rejected', id: op.id, rejected }, rejected[0].reason, error);
    }
  }
  // Invalid under this node's schema: skipped like a beforeApply `false` —
  // logged, relayed, replay-safe — and reported.
  const invalid = changed && !ahead ? await core.invalid(op, entry) : null;
  if (invalid) {
    const error = new SyncomError('OP_INVALID', `Invalid op on ${op.id}`, { op, ...invalid });
    report(batch, { event: 'sync.op.invalid', id: op.id, ...invalid }, 'validation', error);
    return void skip(batch, op);
  }
  if (ahead) core.emit('schema', { kind: 'ahead', op, held: false });
  accept(batch, op);
  core.otel.recordLag(op.ts);
  // A purge, and anything that lands on a purged record, is scrubbed from
  // this log too, once the batch is durable.
  if (entry.meta.purged && !batch.stripped?.has(op)) (batch.purged ??= new Set()).add(op.id);
  if (!changed) return;
  if (VALIDATED.has(op.type)) await reportConflicts(batch, op, entry);
  batch.touched.set(op.id, entry);
  // The batch's own object, joined in place (a path is never `__proto__`).
  let joined = batch.deltas.get(op.id);
  if (joined === undefined) batch.deltas.set(op.id, (joined = {}));
  Object.assign(joined, delta);
  batch.changes.set(op, changes);
};

// Log first, then the records, then the log is told the batch landed; a
// purged id is scrubbed once everything is durable.
const persist = async (batch) => {
  const { core, accepted, touched } = batch;
  if (accepted.length === 0) return;
  const ticket = core.log.enqueue(accepted, {
    skipped: batch.skipped,
    held: batch.held,
    fps: batch.fps,
    scrubbed: batch.stripped ?? null,
  });
  await ticket.done;
  const { entries } = ticket;
  const first = entries[0].seq;
  const last = entries[entries.length - 1].seq;
  if (batch.adopted) await core.log.advance(batch.adopted);
  let landed = true;
  if (touched.size > 0) {
    landed = await core.persist(touched, first, last);
    core.saveCatalog();
  }
  // Unapplied, a batch whose records did not land is replayed at the next open.
  if (landed) core.log.applied(first, last);
  if (batch.purged) for (const id of batch.purged) await core.scrub(id);
};

// afterApply sees a durable batch; whatever it does, the record views and
// the listeners (the relay among them) hear about every op.
const announce = async (batch, result) => {
  const { core, via, peer, accepted, touched } = batch;
  try {
    await core.hook('afterApply', { via, peer, ops: accepted, ...result });
  } finally {
    for (const [id, entry] of touched) {
      core.refresh(id, isAlive(entry) ? entry.data : null, batch.deltas.get(id), null, entry);
    }
    core.emit('apply', { via, peer, ops: accepted, ...result });
    const changes = [];
    for (const op of accepted) {
      const own = batch.changes.get(op) ?? [];
      core.emit('change', op, via, { changes: own });
      for (const change of own) changes.push({ id: op.id, ...change });
    }
    if (accepted.length > 0 && core.listening('transaction')) {
      const ts = accepted[accepted.length - 1].ts;
      const event = { local: false, via, source: null, message: null, ops: accepted, changes, ts };
      core.emit('transaction', event);
    }
  }
};

const applyRemote = async (core, ops, options) => {
  const batch = openBatch(core, options);
  const { verdicts, fps } = await checkPage(batch, ops);
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    if (verdicts[i] !== OK) {
      refuseSignature(batch, op, verdicts[i]);
      continue;
    }
    if (admit(batch, op, fps[i])) await applyOne(batch, op);
  }
  reportSignatures(batch);
  reportEquivocations(batch);
  reportKinds(batch);
  const result = {
    applied: batch.accepted.length,
    skipped: batch.skipped?.size ?? 0,
    duplicates: batch.duplicates,
    gaps: batch.gaps,
    malformed: batch.malformed,
    unsigned: batch.unsigned,
    forged: batch.forged,
    outOfScope: batch.outOfScope,
    equivocations: batch.equivocations,
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
        'syncom.ops.unsigned': r.unsigned,
        'syncom.ops.forged': r.forged,
        'syncom.ops.out_of_scope': r.outOfScope,
        'syncom.ops.equivocations': r.equivocations,
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
