'use strict';

// What one log has that another node lacks: the ops to hand over, by that
// node's version vector — the selection a push makes (src/sync.js) and a
// branch merge makes (src/branch.js), in one place. Ops of the receiver's
// own origin, and the merges made from its snapshot, are left out: it has
// those by definition. `first` is the first seq this log retains of each of
// the sender's own streams (the bootstrap stream apart — it holds holes by
// design): a receiver behind one of them cannot be caught up from here.

const { opInScope } = require('./scope.js');
const { vectorHas, opKey, isBootstrapOp } = require('./vector.js');

/**
 * `{ ops, first }` from `log` for a receiver `exclude` (its node id) that
 * holds `vector`, in `scopes` (null: every scope); `own` is the sender's
 * node id.
 */
const outbound = (log, { exclude, vector, scopes = null, own }) => {
  const entries = log.since(undefined) ?? log.since(log.formatId(log.floor - 1)) ?? [];
  const ops = [];
  const first = {};
  for (const { op } of entries) {
    if (op.origin === exclude || op.from === exclude) continue;
    if (!opInScope(op, scopes)) continue;
    if (op.origin === own && !isBootstrapOp(op)) first[opKey(op)] ??= op.seq;
    if (vectorHas(vector, op)) continue;
    ops.push(op);
  }
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
