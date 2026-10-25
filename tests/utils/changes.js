'use strict';

// A shadow of a record's reading kept by its change reports alone (EVT-1):
// `applyChanges(reading, changes)` is the reading after the op when the
// changes say what the op did. In the op model's terms — flat, every path a
// field — as `getCachedData()` hands the reading out. A tree's moves are
// not replayed: the field is marked STALE and read from the storage at the
// comparison.

const STALE = Symbol('stale');

const applyChange = (reading, change) => {
  const { action, field } = change;
  if (action === 'delete' || action === 'purge') return null;
  const next = { ...(reading ?? {}) };
  if (action === 'put' || action === 'reset') next[field] = change.value;
  else if (action === 'unset') delete next[field];
  else if (action === 'inc') next[field] = (next[field] ?? 0) + change.value;
  else if (action === 'add' || action === 'remove') {
    const keyOf = (element) => JSON.stringify(element);
    const gone = new Set(action === 'remove' ? change.elements.map(keyOf) : []);
    const kept = (next[field] ?? []).filter((element) => !gone.has(keyOf(element)));
    next[field] = action === 'add' ? [...kept, ...change.elements] : kept;
  } else if (action === 'splice') {
    const held = next[field];
    if (typeof held === 'string' || typeof change.content === 'string') {
      const text = typeof held === 'string' ? held : '';
      next[field] = text.slice(0, change.index) + (change.content ?? '') + text.slice(change.index + change.count);
    } else {
      const list = Array.isArray(held) ? [...held] : [];
      list.splice(change.index, change.count, ...(change.content ?? []));
      next[field] = list;
    }
  } else if (action === 'setAt') {
    if (Array.isArray(next[field])) {
      const list = [...next[field]];
      list[change.index] = change.value;
      next[field] = list;
    }
  } else if (action === 'move') {
    const list = [...next[field]];
    const [element] = list.splice(change.from, 1);
    list.splice(change.to, 0, element);
    next[field] = list;
  } else if (action === 'treeMove' || action === 'treeRemove') next[field] = STALE;
  // A mark changes no reading.
  return next;
};

const applyChanges = (reading, changes) => {
  let out = reading;
  for (const change of changes) out = applyChange(out, change);
  return out;
};

// The shadow and the reading compared: a set in either order, a stale tree
// field taken from the reading.
const comparable = (shadow, reading) => {
  if (shadow === null || reading === null) return [shadow, reading];
  const a = { ...shadow };
  const b = { ...reading };
  for (const field of Object.keys(a)) {
    if (a[field] === STALE) a[field] = b[field];
    if (Array.isArray(a[field]) && Array.isArray(b[field]) && a[field].every((x) => typeof x !== 'object')) {
      // A set reads sorted; a list keeps its order — sorting both tells a set apart from nothing.
      if (JSON.stringify([...a[field]].sort()) === JSON.stringify([...b[field]].sort())) a[field] = b[field];
    }
  }
  return [a, b];
};

module.exports = { STALE, applyChange, applyChanges, comparable };
