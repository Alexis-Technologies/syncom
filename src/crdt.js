'use strict';

// Plain-object deltas — `diff`, `merge`, `apply` of the root barrel, from
// before the op model: a delta is what `merge` lays over a value (numbers
// added, arrays and Sets joined). Storage converges through src/ops.js,
// never through these. Three things in the package are called a diff: this
// one, the versions plugin's `storage.diff(id, from, to)` (patches in the
// write API's terms, src/patch.js) and the editor's `diffSpans`/`diffBlocks`
// (a Quill delta between two readings of a text).

// `__proto__` is never a field: a JSON-parsed delta can carry it as an own
// key, and assigning it would replace the result's prototype instead.
const isField = (key) => key !== '__proto__';

// A collection's elements, for the set diff; anything else has none.
const elementsOf = (value) => (Array.isArray(value) || value instanceof Set ? value : []);

/** The delta from `source` to `target` that `merge(source, delta)` reads back (an array or a Set: the elements added). */
const diff = (source, target) => {
  if (source === null || typeof source !== 'object') source = {};
  if (target === null || typeof target !== 'object') target = {};
  const delta = {};
  const sourceKeys = new Set(Object.keys(source));
  const targetKeys = new Set(Object.keys(target));

  for (const key of targetKeys) {
    if (!isField(key)) continue;
    if (!sourceKeys.has(key)) {
      delta[key] = target[key];
    } else if (Array.isArray(target[key]) || target[key] instanceof Set) {
      const sourceSet = new Set(elementsOf(source[key]));
      const added = [];
      for (const x of new Set(target[key])) if (!sourceSet.has(x)) added.push(x);
      if (added.length > 0) {
        delta[key] = added;
      }
    } else if (typeof target[key] === 'object' && target[key] !== null) {
      const nestedDiff = diff(source[key], target[key]);
      if (Object.keys(nestedDiff).length > 0) {
        delta[key] = nestedDiff;
      }
    } else if (source[key] !== target[key]) {
      delta[key] = target[key];
    }
  }

  for (const key of sourceKeys) {
    if (isField(key) && !targetKeys.has(key)) {
      delta[key] = undefined;
    }
  }

  return delta;
};

/** `source` with `delta` laid over it: replaced, removed (`undefined`), merged, joined — and numbers added. */
const merge = (source, delta) => {
  if (!delta || typeof delta !== 'object') return source;
  if (source === null || typeof source !== 'object') return delta;

  const result = Array.isArray(source) ? [...source] : { ...source };

  for (const key of Object.keys(delta)) {
    if (!isField(key)) continue;
    if (delta[key] === undefined) {
      delete result[key];
      continue;
    }

    // What the result holds under the key itself — never what its prototype does (`constructor`).
    const held = Object.hasOwn(result, key) ? result[key] : undefined;
    if (Array.isArray(delta[key]) || delta[key] instanceof Set) {
      const union = new Set(held || []);
      for (const x of delta[key]) union.add(x);
      result[key] = [...union];
    } else if (typeof delta[key] === 'object' && delta[key] !== null) {
      if (typeof held === 'object' && held !== null) {
        result[key] = merge(held, delta[key]);
      } else {
        result[key] = delta[key];
      }
    } else if (typeof delta[key] === 'number' && typeof held === 'number') {
      result[key] = held + delta[key];
    } else {
      result[key] = delta[key];
    }
  }

  return result;
};

/** `source` with a history of `write`/`delta`/`delete`/`inc`/`dec` records folded over it, in order. */
const apply = (source, history) => {
  if (!Array.isArray(history)) return source;
  let result = { ...source };

  // `write` is a full record write: the state becomes `record.data`. A write
  // without data (a bare marker) copies the state forward. `delete` names a
  // key to drop it; without one it is the record itself that was deleted,
  // which is the shape Storage produces (`{ type: 'delete', id }`).
  const handlers = {
    write: (record, state) => (record.data && typeof record.data === 'object' ? { ...record.data } : { ...state }),
    delta: (record, state) => merge(state, record.data),
    delete: (record, state) => (record.key === undefined ? {} : { ...state, [record.key]: undefined }),
    inc: (record, state) => merge(state, { [record.key]: record.value }),
    dec: (record, state) => merge(state, { [record.key]: -record.value }),
  };

  for (const record of history) {
    if (!record || typeof record !== 'object' || !record.type) continue;
    const handler = handlers[record.type];
    if (handler) {
      result = handler(record, result);
    }
  }

  return result;
};

module.exports = { diff, merge, apply };
