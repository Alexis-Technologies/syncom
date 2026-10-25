'use strict';

// Field paths: a field of a record may be a path of stable segments —
// `profile/city`, `stats/views` — each segment a name, `/` the separator
// (reserved: a plain name never holds one). The op model keeps every path
// as a field of its own (its own kind, its own clock), so two nodes that
// write different children of one prefix both keep theirs; a reader is
// handed the paths composed into nested objects (./compose.js). What a path
// may be, the prefixes above it, the read of a composed view by a path, and
// the bounds — here, with no requires: every block that checks a field
// name ships with it.

const MAX_PATH_DEPTH = 16;
const MAX_PATH = 512;
// How many fields (paths) one record holds at most — what a peer can make
// a node hold and compose.
const MAX_PATHS = 4096;

const hasControl = (value) => {
  for (let i = 0; i < value.length; i++) if (value.charCodeAt(i) < 32) return true;
  return false;
};

// A segment: a non-empty name without `/` or a control character, never
// `__proto__` (a key assigned under it would replace a prototype).
const isSegment = (value) => value.length > 0 && value !== '__proto__' && !hasControl(value);

/** Whether `key` is a field path: segments of at most MAX_PATH_DEPTH, MAX_PATH characters in all. */
const isPath = (key) => {
  if (typeof key !== 'string' || key.length === 0 || key.length > MAX_PATH) return false;
  if (!key.includes('/')) return isSegment(key);
  const segments = key.split('/');
  if (segments.length > MAX_PATH_DEPTH) return false;
  for (const segment of segments) if (!isSegment(segment)) return false;
  return true;
};

/** The proper prefixes of `path`, shortest first: `a`, `a/b` for `a/b/c`; none for a plain name. */
const ancestorsOf = (path) => {
  const out = [];
  for (let at = path.indexOf('/'); at !== -1; at = path.indexOf('/', at + 1)) out.push(path.slice(0, at));
  return out;
};

/** Whether `path` lies under `prefix`. */
const under = (path, prefix) => path.length > prefix.length && path.startsWith(prefix) && path[prefix.length] === '/';

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The value at `path` of a composed view, or undefined. */
const valueAt = (view, path) => {
  if (!isObject(view)) return undefined;
  if (!path.includes('/')) return Object.hasOwn(view, path) ? view[path] : undefined;
  let at = view;
  for (const segment of path.split('/')) {
    if (!isObject(at) || !Object.hasOwn(at, segment)) return undefined;
    at = at[segment];
  }
  return at;
};

module.exports = { MAX_PATH_DEPTH, MAX_PATH, MAX_PATHS, isPath, ancestorsOf, under, valueAt };
