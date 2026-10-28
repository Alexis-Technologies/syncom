'use strict';

// What one log has that another node lacks: the ops to hand over, by that
// node's version vector — the selection a push makes (src/sync/manager.js) and a
// branch merge makes (src/branch/branch.js), in one place. Ops of the receiver's
// own origin, and the merges made from its snapshot, are left out: it has
// those by definition. `first` is the first seq this log retains of each of
// the sender's own streams (the bootstrap stream apart — it holds holes by
// design): a receiver behind one of them cannot be caught up from here. A
// push vouches for the sender's own streams alone — a third node's reach
// the host another way; a branch merge has no other way, so it asks for
// every stream (`allStreams`) and joins as state when one is out of reach.

const { opInScope } = require('../scope.js');
const { isBootstrapOp } = require('../vector.js');

/**
 * `{ ops, first }` from `log` for a receiver `exclude` (its node id) that
 * holds `vector`, in `scopes` (null: every scope); `own` is the sender's
 * node id; `allStreams` takes `first` of every origin, not the sender's alone.
 */
const outbound = (log, { exclude, vector, scopes = null, own, allStreams = false }) => {
  const first = {};
  const picked = [];
  // By stream, not over the whole log: a binary search for what the
  // receiver holds of each, the rest taken — what it lacks, not what the
  // log retains (a handshake with a log of a million ops read them all).
  for (const [key, list, from] of log.streams()) {
    const lead = list[from].op;
    if (lead.origin === exclude) continue;
    // A stream other than the bootstrap one is of one scope: its first op's.
    const boot = isBootstrapOp(lead);
    if (!boot && !opInScope(lead, scopes)) continue;
    if (!boot && (allStreams || lead.origin === own)) {
      for (let i = from; i < list.length; i++) {
        if (list[i].op.from === exclude) continue;
        first[key] = list[i].op.seq;
        break;
      }
    }
    const held = Object.hasOwn(vector, key) && Number.isSafeInteger(vector[key]) ? vector[key] : 0;
    let low = from;
    let high = list.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (list[mid].op.seq <= held) low = mid + 1;
      else high = mid;
    }
    for (let i = low; i < list.length; i++) {
      const { op } = list[i];
      if (op.from === exclude || (boot && !opInScope(op, scopes))) continue;
      picked.push(list[i]);
    }
  }
  // In log order, as the log holds them.
  picked.sort((a, b) => a.seq - b.seq);
  const ops = [];
  for (let i = 0; i < picked.length; i++) ops.push(picked[i].op);
  return { ops, first };
};

/** The sender's own streams the receiver cannot be caught up on: what it holds stops short of the first op retained. */
const unreachable = (first, vector) => {
  const missing = {};
  for (const key of Object.keys(first)) {
    const held = vector[key] ?? 0;
    if (held + 1 < first[key]) missing[key] = { host: held, retained: first[key] };
  }
  return missing;
};

module.exports = { outbound, unreachable };
