'use strict';

// The connector zone's one notion of "the same reading": two values equal by
// their canonical JSON — every object's keys sorted, `undefined` left out as
// JSON leaves it. The adapters compare what a backend holds with what a push
// assumed of it; the connector, a pulled document with the record. Kept apart
// from the `canonical` of src/shape.js (the digests' and the signatures', 10 KB
// with what it carries) so that an adapter weighs nothing of the core. No
// requires.

const canonical = (value) => {
  if (value === null || typeof value !== 'object') return value === undefined ? undefined : JSON.stringify(value);
  if (Array.isArray(value)) {
    let out = '[';
    for (let i = 0; i < value.length; i++) out += `${i > 0 ? ',' : ''}${canonical(value[i]) ?? 'null'}`;
    return `${out}]`;
  }
  const keys = Object.keys(value).sort();
  let out = '{';
  for (let i = 0; i < keys.length; i++) {
    const item = canonical(value[keys[i]]);
    if (item === undefined) continue;
    out += `${out.length > 1 ? ',' : ''}${JSON.stringify(keys[i])}:${item}`;
  }
  return `${out}}`;
};

/** Two readings the same — `null` and `undefined` alike, the keys in any order. */
const same = (a, b) => canonical(a ?? null) === canonical(b ?? null);

module.exports = { canonical, same };
