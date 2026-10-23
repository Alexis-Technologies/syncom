'use strict';

// `__proto__` is never a field: a JSON-parsed delta can carry it as an own
// key, and assigning it would replace the result's prototype instead.
const isField = (key) => key !== '__proto__';

const diff = (source, target) => {
  if (typeof source !== 'object') source = {};
  if (typeof target !== 'object') target = {};
  const delta = {};
  const sourceKeys = new Set(Object.keys(source));
  const targetKeys = new Set(Object.keys(target));

  for (const key of targetKeys) {
    if (!isField(key)) continue;
    if (!sourceKeys.has(key)) {
      delta[key] = target[key];
    } else if (Array.isArray(target[key]) || target[key] instanceof Set) {
      const sourceArr = source[key];
      const targetArr = target[key];
      const sourceSet = new Set(sourceArr);
      const targetSet = new Set(targetArr);
      const diffSet = new Set([...targetSet].filter((x) => !sourceSet.has(x)));
      if (diffSet.size > 0) {
        delta[key] = Array.from(diffSet);
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

    if (Array.isArray(delta[key]) || delta[key] instanceof Set) {
      const sourceSet = new Set(result[key] || []);
      const deltaSet = new Set(Array.isArray(delta[key]) ? delta[key] : delta[key]);
      result[key] = Array.from(new Set([...sourceSet, ...deltaSet]));
    } else if (typeof delta[key] === 'object' && delta[key] !== null) {
      if (typeof result[key] === 'object' && result[key] !== null) {
        result[key] = merge(result[key], delta[key]);
      } else {
        result[key] = delta[key];
      }
    } else if (typeof delta[key] === 'number' && typeof result[key] === 'number') {
      result[key] += delta[key];
    } else {
      result[key] = delta[key];
    }
  }

  return result;
};

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
