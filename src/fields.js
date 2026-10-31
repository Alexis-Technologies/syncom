'use strict';

// The API of the field kinds the core keeps beyond registers — counters and
// sets — over the `core` Storage lends (Storage#lend). Every write is one op
// through the queued commit (`core.commit`, what `storage[COMMIT]` runs),
// its arguments checked first in src/args.js. The kinds a plugin brings
// (lists, texts, trees) bring their methods with them (src/plugin.js
// `methods`); Storage keeps one delegate per method here, and a stub that
// refuses with PLUGIN_MISSING for a plugin's method it was not opened with.

const { fieldName, fieldNames, setElements } = require('./args.js');

// Each returns the commit's promise as it is (`core.write`, no async frame
// of its own): an argument it refuses is a throw, which the storage's
// delegate hands back as a rejection.

/** Adds `value` to counter field `key` — the commutative alternative to update(). */
const inc = (core, id, key, value = 1, options) => {
  fieldName('inc', key);
  if (!Number.isFinite(value)) throw new TypeError('inc() takes a finite number');
  return core.write('inc', id, { key, value }, { actor: options?.actor });
};

/**
 * Adds `elements` to set field `key` — an observed-remove set: two nodes
 * that add concurrently both keep theirs, and an add a remove did not
 * observe survives it. Creates the field, and the record, when absent.
 */
const add = (core, id, key, elements, options) =>
  core.write('add', id, { key, value: setElements('add', key, elements) }, { actor: options?.actor });

/** Removes from set field `key` the `elements` this node has seen added; one it never saw is left alone. */
const remove = (core, id, key, elements, options) =>
  core.write('remove', id, { key, value: setElements('remove', key, elements) }, { actor: options?.actor });

/**
 * Removes fields of record `id` — one name or an array of them — of any
 * kind: a register's tombstone that an older concurrent `set` loses to and
 * a newer one brings back. Fields the record does not hold are no op.
 */
const unset = (core, id, fields, options) =>
  core.write('unset', id, { value: fieldNames('unset', fields) }, { actor: options?.actor });

module.exports = { inc, add, remove, unset };
