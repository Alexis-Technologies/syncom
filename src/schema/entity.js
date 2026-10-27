'use strict';

// The record as its entity's validator sees it, and the validated value as
// the op carries it — what the write path (src/commit.js) does with a
// definition the schema plugin handed it. The definitions themselves — the
// validators adapted, the id field derived, the indexes read off a schema —
// are the plugin's (src/schema/define.js); the core only applies them. The
// core's side of the schema, so it lives with the schema: commit.js and
// storage.js require it without the plugin, the lens with it. Requires
// shape.js and paths.js only: it ships to the browser.

const { deepEqual } = require('../shape.js');
const { valueAt, ancestorsOf } = require('../paths.js');

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

// Under its id field, without `$type` — the collection is the engine's, not
// the schema's. `id` null (check() on a value without one) passes no id.
const project = (def, id, data) => {
  const projected = {};
  if (def.idField !== false && id !== null) projected[def.idField] = id;
  for (const key of Object.keys(data)) if (key !== '$type') projected[key] = data[key];
  return projected;
};

// Back: the id field dropped, `$type` restored — whatever the validator
// stripped or renamed, a record never loses its collection. Taken as JSON:
// an op is JSON in the log and on the wire, so a value only JSON can carry
// (a Date from a decoder) is what the cache, the disk and the peers all see.
const unproject = (def, output, type) => {
  if (!isObject(output)) {
    throw new TypeError(`open({ schema }): entity ${def.name}: the validator must return an object`);
  }
  const plain = {};
  for (const key of Object.keys(output)) if (key !== '$type' && key !== def.idField) plain[key] = output[key];
  const data = JSON.parse(JSON.stringify(plain));
  data.$type = type;
  return data;
};

// A `set` carries only the fields it names. Of the validated record keep the
// keys of the delta (in their validated form, read by path: the validator
// sees the paths composed) and the top-level keys whose value is not what
// the record read as before the write (defaults, alias targets, a
// migration's rename) — but not a key a delta path lies under, which the
// path's own write covers (a whole-object write of it would reset the
// siblings). A delta key the validator dropped drops out of the delta — the
// op never carries it — and a key the validator left as it was is never
// touched, so a `set` stays a `set`: promoting it to a whole-record write
// would reset the record's base and erase concurrent sets and counters
// from other peers.
const foldSet = (delta, validated, before) => {
  const next = {};
  const covered = new Set();
  for (const key of Object.keys(delta)) {
    if (key === '$type') continue;
    const value = valueAt(validated, key);
    if (value !== undefined) next[key] = value;
    for (const prefix of ancestorsOf(key)) covered.add(prefix);
  }
  for (const key of Object.keys(validated)) {
    if (key === '$type' || Object.hasOwn(next, key) || covered.has(key)) continue;
    if (!deepEqual(validated[key], before[key])) next[key] = validated[key];
  }
  return next;
};

module.exports = { project, unproject, foldSet };
