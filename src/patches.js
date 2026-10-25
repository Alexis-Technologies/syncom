'use strict';

// The present, and the patches that change it — the core's: what a record
// reads as (`reading`, the way `get()` hands it out), `applyPatches` (the
// vocabulary of src/patch.js realized as ops of this node's own, in one
// turn of the mutation queue, rehearsed first) and `compact` (a record
// rewritten as the ops its reading takes today). The undo subpath stands on
// `applyPatches` and the `commit` event alone; the versions plugin
// (src/versions/) reads the past and restores it through these.

const { commit, rehearse } = require('./commit.js');
const { isAlive, kindsOf } = require('./ops.js');
const { diffViews, realize } = require('./patch.js');
const { traced } = require('./telemetry.js');
const { asJson, isRecordId, invalidId } = require('./shape.js');
const { SyncomError } = require('./errors.js');

const sealed = (id, rest = '') => new SyncomError('ENCRYPTED', `Record ${id} is encrypted here${rest}`);

// What an entry reads as, the way `get()` hands a record out: an encrypted
// one as its data, a live one through the lens, a tombstone or none as null.
const reading = async (core, id, entry) => {
  if (entry === null) return null;
  if (entry.encrypted) return asJson(entry.data);
  return isAlive(entry) ? asJson(await core.view(id, entry)) : null;
};

/**
 * Realizes `patches` on record `id` as ops of this node's own, in one turn
 * of the mutation queue — `put` a `set`, `write`, `inc`, `add`, `remove`
 * (`elements` as observed, or exactly the `removals` named), `splice`,
 * `treeMove`/`treeRemove`, `delete`, `purge`. `source` rides on the
 * `commit` events the ops raise, so a listener can tell its own. Resolves
 * to how many ops it took; a patch of the wrong shape is a TypeError and
 * nothing is written.
 */
const applyPatches = async (core, id, patches, { actor, source = null } = {}) => {
  if (!isRecordId(id)) throw invalidId(id);
  if (!Array.isArray(patches)) throw new TypeError('applyPatches() takes an array of patches');
  const ops = patches.map((patch) => realize(patch, core.plugins));
  const apply = async () => {
    // Every op resolved and applied over a scratch record first — an index
    // out of range, a kind clash, a cycle, a type change — so nothing is
    // appended unless all of them can be: a restore lands whole or not at
    // all. A hook or a validator that throws on a later op still leaves
    // the earlier ones committed (see applyPatches in the reference).
    await rehearse(core, id, ops);
    let count = 0;
    for (const [type, payload] of ops) {
      const op = await commit(core, type, id, payload, { actor, source });
      if (op === null) continue;
      count++;
      if (type === 'purge') await core.scrub(id);
    }
    if (ops.some(([type]) => type === 'delete' || type === 'purge')) core.forget(id);
    return count;
  };
  const { otel } = core;
  if (!otel.enabled) return core.run(apply);
  const attributes = { 'syncom.ops.count': ops.length };
  return core.run(() =>
    traced(otel, 'syncom.patches', attributes, apply, (count) => ({ 'syncom.ops.applied': count })),
  );
};

/**
 * Rewrites record `id` as the ops its reading takes today — a `write` of
 * the registers, then one op per field of another kind: an `inc`, an
 * `add`, one `splice` (a text or a list becomes one run), one `tree` move
 * per node, and the marks of a text laid again — so what lies under it
 * goes by the reset rule, here and on every peer alike: a text of ten
 * thousand runs is one (a run per MAX_RUN elements), a tree's move log is
 * one move per node, and the record reads the same — but a list, a text, a
 * set or a tree that reads empty, which no op makes again, and the names of
 * the elements: a cursor taken before reads null, a stacking mark has a new
 * id. A peer's op stamped
 * before the rewrite and arriving after it is dropped by the reset, as
 * with any whole-record write. Resolves to how many ops it took; `0` for
 * a record that is not there, `ENCRYPTED` for an encrypted one.
 */
const compact = async (core, id, { actor, source = null } = {}) => {
  if (!isRecordId(id)) throw invalidId(id);
  const entry = await core.entries.load(id);
  if (entry?.encrypted) throw sealed(id);
  if (entry === null || !isAlive(entry)) return 0;
  const view = await core.view(id, entry);
  const kinds = kindsOf(entry, core.plugins);
  const patches = diffViews(null, {}, view, kinds, { plugins: core.plugins });
  // What a plugin lays after the field is made again (a text's marks).
  for (const field of Object.keys(kinds)) {
    const mod = core.plugins.byName[kinds[field]];
    if (mod !== undefined) patches.push(...mod.compact(entry, field, kinds[field]));
  }
  return applyPatches(core, id, patches, { actor, source });
};

module.exports = { sealed, reading, applyPatches, compact };
