'use strict';

// The paths of a record composed for a reader, and a reading taken back to
// the paths — the two sides of ./paths.js the core and the undo block need
// (a reader's view, a diff's terms); the kind plugins do not. A list's
// elements and a tree's nodes are members: a path under one — `items/<element>/body`,
// `outline/<node>/title` — is composed into the element (over its value) or
// the node (as its `data`), through the plugin's `members`, `pick` and
// `nest`; a path under a member that is not shown is unreachable: kept,
// not composed, not in a diff. Requires ./paths.js alone.

const { ancestorsOf, under, valueAt } = require('./paths.js');

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

// The plugin whose block holds `field` of the entry, when its kind nests.
const nesting = (entry, plugins, field) => {
  const block = entry.meta.blocks && Object.hasOwn(entry.meta.blocks, field) ? entry.meta.blocks[field] : undefined;
  if (block === undefined || plugins === null) return null;
  const mod = Object.hasOwn(plugins.byCode, block.k) ? plugins.byCode[block.k] : undefined;
  if (mod === undefined || mod.nests === undefined) return null;
  return mod.nests[mod.codes[block.k]] === true ? mod : null;
};

// The flat keys `paths` (relative to `prefix`, each holding a `/`) composed
// into one object, over `base` (the register at the prefix: its object, or
// nothing).
const composeAt = (entry, plugins, prefix, data, paths, base) => {
  const out = isObject(base) ? { ...base } : {};
  const byHead = new Map();
  for (const path of paths) {
    const at = path.indexOf('/');
    const head = at === -1 ? path : path.slice(0, at);
    const rest = at === -1 ? '' : path.slice(at + 1);
    let group = byHead.get(head);
    if (group === undefined) byHead.set(head, (group = { own: undefined, deeper: [] }));
    if (rest === '') group.own = path;
    else group.deeper.push(rest);
  }
  for (const [head, group] of byHead) {
    const full = prefix === '' ? head : `${prefix}/${head}`;
    const own = group.own === undefined ? out[head] : data[prefix === '' ? group.own : `${prefix}/${group.own}`];
    if (group.deeper.length === 0) {
      out[head] = own;
      continue;
    }
    const mod = nesting(entry, plugins, full);
    if (mod !== null) {
      // Under a list or a tree: the next segment names a member.
      const byMember = new Map();
      for (const rest of group.deeper) {
        const at = rest.indexOf('/');
        const member = at === -1 ? rest : rest.slice(0, at);
        const tail = at === -1 ? '' : rest.slice(at + 1);
        let list = byMember.get(member);
        if (list === undefined) byMember.set(member, (list = []));
        list.push(tail);
      }
      const childrenOf = (member) => {
        const tails = byMember.get(member);
        if (tails === undefined) return undefined;
        const here = `${full}/${member}`;
        const ownValue = tails.includes('') ? data[here] : undefined;
        const deeper = tails.filter((tail) => tail !== '');
        return composeAt(entry, plugins, here, data, deeper, ownValue);
      };
      out[head] = mod.nest(entry, full, own ?? entry.data[full], childrenOf);
    } else out[head] = composeAt(entry, plugins, full, data, group.deeper, own);
  }
  return out;
};

/**
 * The flat data of an entry as the application reads it: every path nested
 * under its prefixes — a child laid over the register at its prefix (which
 * becomes an object where it was not one), a child of a list's element or
 * a tree's node inside it (the plugin's `nest`). The data itself, not a
 * copy, when it holds no path. `plugins` is the registry (null composes
 * registers alone).
 */
const compose = (entry, plugins = null) => {
  const { data } = entry;
  let paths = null;
  for (const key of Object.keys(data)) if (key.includes('/')) (paths ??= []).push(key);
  if (paths === null) return data;
  const plain = {};
  for (const key of Object.keys(data)) if (!key.includes('/')) plain[key] = data[key];
  return composeAt(entry, plugins, '', data, paths, plain);
};

/** The same over flat data alone (no blocks nest): what a scope function reads. */
const composeData = (data) => compose({ data, meta: { blocks: {} } }, null);

// The value `field` reads as in a composed `view`: by key, and through a
// list's or a tree's member where the path passes one (the plugin's `pick`).
const readAt = (entry, plugins, view, field) => {
  if (!field.includes('/')) return isObject(view) && Object.hasOwn(view, field) ? view[field] : undefined;
  const segments = field.split('/');
  let at = view;
  let prefix = '';
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    const mod = prefix === '' ? null : nesting(entry, plugins, prefix);
    if (mod !== null) at = mod.pick(entry, prefix, at, segment);
    else at = isObject(at) && Object.hasOwn(at, segment) ? at[segment] : undefined;
    if (at === undefined) return undefined;
    prefix = prefix === '' ? segment : `${prefix}/${segment}`;
  }
  return at;
};

/**
 * A composed view back as flat fields, in the terms of the op model —
 * what a diff, a compaction and an undo read: each path's value read by
 * path (a path under a member that is not shown is left out), a list or a
 * tree as the entry renders it, and a register at a prefix as its own
 * value — the leaves the paths under it laid over it taken out again (an
 * object left empty by that goes, as the composition made it). `plugins` is
 * the registry.
 */
const decompose = (view, entry, plugins = null) => {
  if (!isObject(view)) return view;
  const fields = Object.keys(entry.data);
  let any = false;
  for (const field of fields) if (field.includes('/')) any = true;
  if (!any) return view;
  const out = {};
  const prefixes = new Set();
  for (const field of fields) {
    const value = readAt(entry, plugins, view, field);
    if (value !== undefined) out[field] = value;
    for (const prefix of ancestorsOf(field)) prefixes.add(prefix);
  }
  // Keys of the view the fields do not name — a lens may have added them.
  for (const key of Object.keys(view)) if (!Object.hasOwn(out, key) && !prefixes.has(key)) out[key] = view[key];
  for (const prefix of prefixes) {
    if (!Object.hasOwn(out, prefix)) continue;
    // A list or a tree reads as the entry renders it, its children apart.
    if (nesting(entry, plugins, prefix) !== null) {
      out[prefix] = entry.data[prefix];
      continue;
    }
    if (!isObject(out[prefix])) continue;
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

module.exports = { compose, composeData, decompose, readAt, valueAt };
