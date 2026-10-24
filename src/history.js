'use strict';

// Reading the past out of the log. A version is a cut through the retained
// entries of a record — everything up to an event id (the record as THIS
// node held it after that entry), every op stamped at or below a stamp,
// every op a version vector covers — and the record at that version is the
// fold of the entries inside the cut, the same `applyOp` that built it the
// first time. The fold is exact when nothing compaction dropped can have
// left a trace in it: nothing was ever dropped (`droppedTs` 0), or a reset
// (`write`, `delete`, `purge`) stamped above `droppedTs` is inside the cut —
// a reset discards everything stamped below it, and everything dropped was
// stamped at or below `droppedTs`. One exception is documented: a counter
// slot alive across that reset keeps a sum older increments went into
// (the straddle `repair()` has too); the fold of everything retained is
// compared with the record as it is, which catches it whenever the present
// still shows it. Pure over log entries; the storage runs the lens and the
// hooks.

const { applyOp } = require('./ops.js');
const { parseEventId, vectorHas } = require('./vector.js');
const { SyncomError, typed } = require('./errors.js');

// Whether this node applied a log entry: not skipped, or held for a schema
// version this node has since reached (and replayed).
const appliedHere = (entry, version) =>
  !entry.skipped || (entry.held !== undefined && version !== null && entry.held <= version);

// The ops that start a record over: what is stamped below them is gone from
// the record, whatever the log holds before them. A scrubbed write has no
// data to start from; a purge, scrubbed or not, is the end.
const RESET = new Set(['write', 'delete']);
const isReset = (entry) => entry.op.type === 'purge' || (!entry.scrubbed && RESET.has(entry.op.type));

const gone = (id, reason) => {
  const why = {
    compacted: 'compaction dropped entries the version depends on',
    scrubbed: 'a purge scrubbed the entries the version depends on',
    epoch: 'the event id belongs to another incarnation of this log',
    merge: 'a snapshot joined after the stamp carries ops stamped before it',
  };
  return new SyncomError('HISTORY_GONE', `History of record ${id} is gone: ${why[reason]}`, { id, reason });
};

const isVector = (value) =>
  value !== null &&
  typeof value === 'object' &&
  Object.keys(value).every((key) => Number.isSafeInteger(value[key]) && value[key] >= 0);

// `at`, checked: an event id (a string), a stamp (a number or a Date),
// `{ vector }` or `{ tag }`. The shape is data, so a wrong one is INVALID_VERSION.
const parseVersion = (at) => {
  if (typeof at === 'string') {
    const parsed = parseEventId(at);
    if (parsed === null) throw typed('INVALID_VERSION', `at: not an event id: ${at}`);
    return { kind: 'event', epoch: parsed.epoch, seq: parsed.seq };
  }
  const stamp = at instanceof Date ? at.getTime() : at;
  if (typeof stamp === 'number') {
    if (!Number.isFinite(stamp) || stamp < 0) throw typed('INVALID_VERSION', `at: not a stamp: ${at}`);
    return { kind: 'stamp', ts: stamp };
  }
  if (at !== null && typeof at === 'object' && isVector(at.vector)) return { kind: 'vector', vector: at.vector };
  if (at !== null && typeof at === 'object' && typeof at.tag === 'string') return { kind: 'tag', name: at.tag };
  throw typed('INVALID_VERSION', 'at: an event id, a stamp (a number or a Date), { vector } or { tag }');
};

// Whether an applied entry falls inside the version.
const within = (version, entry) => {
  if (version.kind === 'event') return entry.seq <= version.seq;
  if (version.kind === 'stamp') return entry.op.ts <= version.ts;
  return vectorHas(version.vector, entry.op);
};

// Where the fold of `entries` starts, and whether what it gives is what the
// node held: from the first entry when nothing was ever dropped, else from
// the first reset stamped above what was.
const exactStart = (entries, droppedTs) => {
  if (droppedTs === 0) return { start: 0, exact: true };
  const start = entries.findIndex((entry) => isReset(entry) && entry.op.ts > droppedTs);
  return start === -1 ? { start: 0, exact: false } : { start, exact: true };
};

// The fold of `entries` from `start`: one step per entry — the entry of the
// log, the record after it, what the op changed. `limits` are the node's
// (`sync.pendingMax`): what it applied under them folds back under them.
const fold = (entries, start, limits = null) => {
  const steps = [];
  let entry = null;
  for (let i = start; i < entries.length; i++) {
    const applied = applyOp(entry, entries[i].op, limits);
    entry = applied.entry;
    steps.push({ logged: entries[i], entry, delta: applied.delta });
  }
  return steps;
};

module.exports = { appliedHere, isReset, parseVersion, within, exactStart, fold, gone };
