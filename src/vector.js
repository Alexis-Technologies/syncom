'use strict';

// Clocks, version vectors and event ids — the three ordering primitives the
// sync engine is built on. Pure functions over plain values, shared by both
// halves.
//
// A CLOCK is `[ts, origin]`: a millisecond timestamp with the node id as the
// tie-break, so two stamps are never equal unless they are the same stamp.
// A VECTOR is `{ [origin]: seq }` — the highest per-origin sequence number a
// node has applied. An EVENT ID is `'<epoch>.<seq>'` — one node's position in
// its own log, the cursor a subscriber hands back to resume (the shape wrpc's
// createEventLog uses, on purpose: it is what rides in `lastEventId`).

const compareClock = (a, b) => {
  if (!a) return b ? -1 : 0;
  if (!b) return 1;
  if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
  if (a[1] === b[1]) return 0;
  return a[1] < b[1] ? -1 : 1;
};

const maxClock = (a, b) => (compareClock(a, b) >= 0 ? a : b);

const vectorMax = (a = {}, b = {}) => {
  const result = { ...a };
  for (const origin in b) {
    if (!(result[origin] >= b[origin])) result[origin] = b[origin];
  }
  return result;
};

// Sequence numbers run per ORIGIN AND SCOPE, so a peer that syncs one scope
// still sees every seq of that scope in order — a global counter would show
// it holes wherever an op of another scope sat. The vector key spells that
// out: `origin` for the global scope, `origin@scope` otherwise.
const vectorKey = (origin, scope) => (scope && scope !== '*' ? `${origin}@${scope}` : origin);

// Ops born from joining a snapshot (`merge`, `advance`) run in a stream of
// their own: they never travel back to the node the snapshot came from, and
// a stream that node never sees must not be one whose holes it would count.
const BOOT_SCOPE = '~';
const isBootstrapOp = (op) => op.type === 'merge' || op.type === 'advance';
const opKey = (op) => vectorKey(op.origin, isBootstrapOp(op) ? BOOT_SCOPE : op.scope);

// The scope a vector key belongs to: null for the global scope and for the
// bootstrap stream, which every subscriber takes.
const keyScope = (key) => {
  const at = key.indexOf('@');
  if (at === -1) return null;
  const scope = key.slice(at + 1);
  return scope === BOOT_SCOPE ? null : scope;
};

// Whether an op is news to a node holding `vector`.
const vectorHas = (vector, op) => (vector[opKey(op)] ?? 0) >= op.seq;

// The op is the next one expected from its origin in its scope.
const vectorNext = (vector, op) => (vector[opKey(op)] ?? 0) + 1 === op.seq;

// Mutates: records that `op` has been applied.
const vectorAdvance = (vector, op) => {
  const key = opKey(op);
  if ((vector[key] ?? 0) < op.seq) vector[key] = op.seq;
  return vector;
};

const formatEventId = (epoch, seq) => `${epoch}.${seq}`;

const parseEventId = (value) => {
  if (typeof value !== 'string') return null;
  const dot = value.lastIndexOf('.');
  if (dot <= 0) return null;
  const seq = Number(value.slice(dot + 1));
  if (!Number.isInteger(seq) || seq < 0) return null;
  return { epoch: value.slice(0, dot), seq };
};

// A Lamport-style wall clock: never repeats, never runs backwards, and never
// falls behind a stamp it has seen from a peer — so a local write always wins
// last-writer-wins against everything this node already knows about, even
// when a peer's wall clock is ahead of ours.
class Clock {
  #last = 0;

  now() {
    const ts = Math.max(Date.now(), this.#last + 1);
    this.#last = ts;
    return ts;
  }

  observe(ts) {
    if (typeof ts === 'number' && ts > this.#last) this.#last = ts;
  }
}

module.exports = {
  compareClock,
  maxClock,
  vectorMax,
  vectorKey,
  opKey,
  keyScope,
  isBootstrapOp,
  vectorHas,
  vectorNext,
  vectorAdvance,
  formatEventId,
  parseEventId,
  Clock,
};
