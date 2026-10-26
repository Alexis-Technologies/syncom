'use strict';

// Branches — the `@alexify/syncom/branch` subpath. A branch is a storage
// forked from another: a new directory, a new identity (its own keys, its
// own log), standing at the parent's state or at a tag of it. It is a
// storage like any other — it dials, hosts, tags, has a history — and it
// is merged back, or the parent into it, as ops: what one log has that the
// other lacks, by the other's version vector, handed over through
// `applyRemote` the way a peer's push lands (src/outbound.js picks them,
// as a push does). A source that compacted past what the other holds is
// joined as state instead — its snapshot pages, then its vector adopted.
// Nothing here requires storage.js: a branch is opened through the
// parent's own constructor, so this subpath bundles no engine.

const { outbound, unreachable } = require('../outbound.js');
const { asJson } = require('../shape.js');
const { DEFAULT_PAGE_SIZE } = require('../protocol.js');
const { SyncomError } = require('../errors.js');
const { PLUGINS } = require('../symbols.js');

const FILE = 'branch.json';
const FORMAT = 1;

const isStorage = (value) =>
  value !== null &&
  typeof value === 'object' &&
  typeof value.snapshot === 'function' &&
  typeof value.mergeSnapshot === 'function' &&
  typeof value.applyRemote === 'function' &&
  typeof value.nodeId === 'string' &&
  value.log !== undefined;

// Every page of `pages(cursor)` joined into `into`, as the node `from`'s state.
const join = async (into, pages, from) => {
  let cursor = null;
  let count = 0;
  do {
    const page = await pages(cursor);
    if (page.records.length > 0) await into.mergeSnapshot(asJson(page.records), { from });
    cursor = page.cursor;
    count++;
  } while (cursor !== null);
  return count;
};

/**
 * Hands `into` everything `source` has that it lacks. `{ ops, pages,
 * joined }`: the ops applied and the pages they went in, or — when the
 * source's log no longer holds what `into` would need — `joined: true`
 * for a join of the source's state and vector.
 */
const merge = async (source, { into } = {}) => {
  if (!isStorage(source) || !isStorage(into)) {
    throw new TypeError('merge() takes two storages: merge(source, { into })');
  }
  if (source === into) throw new TypeError('merge(): a storage does not merge into itself');
  const vector = into.vector;
  // Every stream, not the source's own alone: a merge is the receiver's one
  // way to a third node's ops the source holds, so a stream the source
  // compacted past what the receiver has is joined as state, never skipped.
  const selection = { exclude: into.nodeId, vector, own: source.nodeId, allStreams: true };
  const { ops, first } = outbound(source.log, selection);
  const from = source.nodeId;
  if (Object.keys(unreachable(first, vector)).length > 0) {
    const pages = await join(into, (cursor) => source.snapshot({ cursor }), from);
    await into.adoptVector(source.vector, { from });
    return { ops: 0, pages, joined: true };
  }
  let applied = 0;
  let pages = 0;
  for (let index = 0; index < ops.length; index += DEFAULT_PAGE_SIZE) {
    const page = asJson(ops.slice(index, index + DEFAULT_PAGE_SIZE));
    const result = await into.applyRemote(page, { via: { url: null, node: from }, adoptFrom: from });
    applied += result.applied;
    pages++;
  }
  return { ops: applied, pages, joined: false };
};

/**
 * A storage forked from `parent` at `path` — a new identity standing at the
 * parent's state, or at tag `from.tag` — opened with `options` (the
 * schema, the hooks, the logger it should run with; `sync` is given
 * `retention: { ops: 0 }` and `autoStart: false`, so every op stays for
 * the merge back and no node is dialed before the caller says so). Writes
 * `branch.json` there; rejects with `BRANCH_EXISTS` when one is there
 * already.
 */
const branch = async (parent, { path, from = null, ...options } = {}) => {
  if (!isStorage(parent) || typeof parent.constructor !== 'function') throw new TypeError('branch() takes a storage');
  if (typeof path !== 'string' || path.length === 0) throw new TypeError('branch() takes a path for the branch');
  if (from !== null && (typeof from !== 'object' || (typeof from.tag !== 'string' && from.at === undefined))) {
    throw new TypeError('branch(): from is { tag } or { at }');
  }
  const fsi = options.fsi ?? parent.fsi;
  if (await fsi.exists(path, FILE)) throw new SyncomError('BRANCH_EXISTS', `${path} holds a branch already`, { path });
  // A branch opens in a directory of its own: one that holds files already
  // — another storage, say — is not taken over and merged into.
  let present = [];
  try {
    present = await fsi.list(path);
  } catch {
    present = [];
  }
  if (present.length > 0) {
    const message = `${path} holds files already; a branch opens in a new directory`;
    throw new SyncomError('BRANCH_EXISTS', message, { path });
  }
  const sync = { ...options.sync, retention: { ...options.sync?.retention, ops: 0 }, autoStart: false };
  const Storage = parent.constructor;
  const plugins = options.plugins ?? parent[PLUGINS].modules;
  const child = await new Storage({ ...options, fsi, path, sync, plugins });
  const origin = parent.nodeId;
  let forkedAt;
  try {
    if (from !== null) {
      // At a tag, or at any version the parent's log can still give exactly.
      const view = typeof from.tag === 'string' ? parent.at(from.tag) : parent.atVersion(from.at);
      await join(child, (cursor) => view.snapshot({ cursor }), origin);
      await child.adoptVector(view.vector, { from: origin });
      const tag = typeof from.tag === 'string' ? from.tag : null;
      forkedAt = { eventId: view.eventId, vector: view.vector, ts: view.ts, tag, at: tag === null ? from.at : null };
    } else {
      // The parent's position before paging; what lands while the pages go
      // out is caught up as ops, so the branch stands at one cut.
      const vector = parent.vector;
      await join(child, (cursor) => parent.snapshot({ cursor }), origin);
      await child.adoptVector(vector, { from: origin });
      await merge(parent, { into: child });
      forkedAt = {
        eventId: parent.log.lastEventId,
        vector: parent.vector,
        ts: parent.log.latestTs,
        tag: null,
        at: null,
      };
    }
    const info = { format: FORMAT, parent: origin, forkedAt, createdAt: Date.now() };
    await fsi.write(path, FILE, JSON.stringify(info), { atomic: true });
  } catch (error) {
    // Nothing half-made stays: a retry opens a new identity, not this one.
    await sweep(child).catch(() => {});
    throw error;
  }
  return child;
};

/** `{ parent, forkedAt, createdAt }` of a storage opened on a branch's directory, or null for one that is no branch. */
const branchInfo = async (storage) => {
  if (!isStorage(storage) || typeof storage.path !== 'string') throw new TypeError('branchInfo() takes a storage');
  if (!(await storage.fsi.exists(storage.path, FILE))) return null;
  let parsed = null;
  try {
    parsed = JSON.parse(await storage.fsi.read(storage.path, FILE));
  } catch (error) {
    throw new SyncomError('CORRUPT', `${FILE} is unreadable`, { cause: error });
  }
  if (!parsed || parsed.format !== FORMAT || typeof parsed.parent !== 'string') {
    throw new SyncomError('CORRUPT', `${FILE} is not a branch file`);
  }
  const { parent, forkedAt, createdAt } = parsed;
  return { parent, forkedAt, createdAt };
};

// The directories a storage writes under its path; fsi lists files, not
// directories, so the tags' are named from the storage before it closes.
const DIRS = ['', 'keys', 'blockchain', 'index', 'data', 'log', 'log/open', 'remote', 'tags/.pending/data'];

// The tags a storage holds — none without the versions plugin, which keeps
// them (a branch opened without it has no tags of its own to sweep).
const tagsOf = (storage) => {
  try {
    return storage.tags();
  } catch {
    return [];
  }
};

// Closes a storage and removes its files — every file of the known layout,
// the tags' included. The empty directories stay: no backend has rmdir.
// `branch.json` goes last: a sweep cut short leaves a directory `drop()`
// still takes, to finish it.
const sweep = async (storage) => {
  const { fsi, path } = storage;
  const dirs = [...DIRS];
  const tags = tagsOf(storage);
  for (let i = 0; i < tags.length; i++) dirs.push(`tags/${tags[i].name}/data`, `tags/${tags[i].name}/index`);
  // Closed first — whatever else fails — so its lock goes with it.
  await storage.close();
  for (const dir of dirs) {
    const full = dir === '' ? path : `${path}/${dir}`;
    let names = [];
    try {
      names = await fsi.list(full);
    } catch {
      continue;
    }
    for (const name of names) if (dir !== '' || name !== FILE) await fsi.remove(full, name);
  }
  if (await fsi.exists(path, FILE)) await fsi.remove(path, FILE);
};

/**
 * Closes a branch and removes its files — every file of the known layout,
 * the tags' included; the empty directories stay (no backend has rmdir).
 * A storage that is no branch (no `branch.json`) is refused: this is the
 * one call that deletes data, and it takes only what `branch()` made.
 */
const drop = async (storage) => {
  if (!isStorage(storage) || typeof storage.path !== 'string') throw new TypeError('drop() takes a storage');
  if ((await branchInfo(storage)) === null) {
    throw new TypeError(`drop() takes a branch: ${storage.path} holds no ${FILE}`);
  }
  await sweep(storage);
};

module.exports = { branch, merge, branchInfo, drop };
