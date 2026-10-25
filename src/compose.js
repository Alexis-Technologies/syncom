'use strict';

// The paths of a record composed for a reader, and a reading taken back to
// the paths — the two sides of ./paths.js the core and the undo block need
// (a reader's view, a diff's terms); the kind plugins do not. Requires
// ./paths.js alone.

const { ancestorsOf, under, valueAt } = require('./paths.js');

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The flat data of an entry as the application reads it: every path nested
 * under its prefixes, a child laid over the register at its prefix (which
 * becomes an object where it was not one). The data itself, not a copy,
 * when it holds no path.
 */
const compose = (data) => {
  let paths = null;
  for (const key of Object.keys(data)) {
    if (key.includes('/')) (paths ??= []).push(key);
  }
  if (paths === null) return data;
  const out = {};
  for (const key of Object.keys(data)) if (!key.includes('/')) out[key] = data[key];
  // Shallow paths first: a deeper one lands inside what a shallower made.
  paths.sort((a, b) => a.length - b.length);
  for (const path of paths) {
    const segments = path.split('/');
    let at = out;
    for (let i = 0; i < segments.length - 1; i++) {
      const segment = segments[i];
      const held = Object.hasOwn(at, segment) ? at[segment] : undefined;
      // A register under a child: its object copied, so the composition
      // never writes into the data; anything else gives way.
      at[segment] = isObject(held) ? (held === data[segments.slice(0, i + 1).join('/')] ? { ...held } : held) : {};
      at = at[segment];
    }
    at[segments[segments.length - 1]] = data[path];
  }
  return out;
};

/**
 * A composed view back as flat fields, by the record's own `fields` (its
 * paths): each path's value read by path, and a register at a prefix as its
 * own value — the leaves the paths under it laid over it taken out again
 * (an object left empty by that goes, as the composition made it). What a
 * diff, a compaction and an undo read, in the terms of the op model.
 */
const decompose = (view, fields) => {
  if (!isObject(view)) return view;
  let any = false;
  for (const field of fields) if (field.includes('/')) any = true;
  if (!any) return view;
  const out = {};
  const prefixes = new Set();
  for (const field of fields) {
    if (field.includes('/')) {
      const value = valueAt(view, field);
      if (value !== undefined) out[field] = value;
      for (const prefix of ancestorsOf(field)) prefixes.add(prefix);
    } else if (Object.hasOwn(view, field)) out[field] = view[field];
  }
  // Keys of the view the fields do not name — a lens may have added them.
  for (const key of Object.keys(view)) if (!Object.hasOwn(out, key) && !prefixes.has(key)) out[key] = view[key];
  for (const prefix of prefixes) {
    if (prefix.includes('/') || !Object.hasOwn(out, prefix) || !isObject(out[prefix])) continue;
    const own = structuredClone(out[prefix]);
    for (const field of fields) {
      if (!under(field, prefix)) continue;
      const segments = field.slice(prefix.length + 1).split('/');
      const trail = [own];
      let at = own;
      for (let i = 0; i < segments.length - 1 && isObject(at); i++) {
        at = Object.hasOwn(at, segments[i]) ? at[segments[i]] : undefined;
        trail.push(at);
      }
      if (!isObject(at)) continue;
      delete at[segments[segments.length - 1]];
      // An object emptied on the way up was the composition's own.
      for (let i = trail.length - 1; i > 0; i--) {
        if (isObject(trail[i]) && Object.keys(trail[i]).length === 0) delete trail[i - 1][segments[i - 1]];
        else break;
      }
    }
    out[prefix] = own;
  }
  return out;
};

module.exports = { compose, decompose };
