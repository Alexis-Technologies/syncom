'use strict';

// The present, and the patches that change it — the core's: what a record
// reads as (`reading`, the way `get()` hands it out), `applyPatches` (the
// vocabulary of src/patch.js realized as ops of this node's own, in one
// turn of the mutation queue, rehearsed first) and `compact` (a record
// rewritten as the ops its reading takes today). The undo subpath stands on
// `applyPatches` and the `commit` event alone; the versions plugin
// (src/versions/) reads the past and restores it through these.

const { transact, rehearse } = require('./commit.js');
const { isAlive, kindsOf } = require('./ops.js');
const { decompose } = require('./compose.js');
const { ancestorsOf, under } = require('./paths.js');
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
// A batch of realized ops, inside the mutation queue, as one transaction
// (src/commit.js transact): every op resolved and applied over a scratch
// record first — an index out of range, a kind clash, a cycle, a type change
// — and then made for real, the hooks and the validator running on each,
// and appended together once all of them are made: a restore lands whole or
// not at all, a hook or a validator that throws on a later op leaves
// nothing written. The batch is done when it has landed.
const runOps = async (core, id, ops, { actor, source, message }) => {
  await rehearse(core, id, ops);
  const { result: count, done } = await transact(
    core,
    async (tx) => {
      let made = 0;
      for (const [type, payload] of ops) if ((await tx.commit(type, id, payload, { actor })) !== null) made++;
      return made;
    },
    { actor, source, message },
  );
  if (done !== null) await done;
  if (ops.some(([type]) => type === 'purge')) await core.scrub(id);
  if (ops.some(([type]) => type === 'delete' || type === 'purge')) core.forget(id);
  return count;
};

const applyPatches = async (core, id, patches, { actor, source = null, message } = {}) => {
  if (!isRecordId(id)) throw invalidId(id);
  if (!Array.isArray(patches)) throw new TypeError('applyPatches() takes an array of patches');
  const ops = patches.map((patch) => realize(patch, core.plugins));
  const apply = () => runOps(core, id, ops, { actor, source, message });
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
 * `add`, one `splice` (a text or a list becomes one run, a text's embed
 * markers riding on it), one `tree` move per node, and the marks of a text
 * laid again — so what lies under it
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
const compact = async (core, id, { actor, source = null, message } = {}) => {
  if (!isRecordId(id)) throw invalidId(id);
  const entry = await core.entries.load(id);
  if (entry?.encrypted) throw sealed(id);
  if (entry === null || !isAlive(entry)) return 0;
  const { plugins } = core;
  const kinds = kindsOf(entry, plugins);
  // The reading in the op model's terms: flat, every path a field; a field
  // under a member that is not shown is unreachable and goes with the rewrite.
  const view = decompose(await core.view(id, entry), entry, plugins);
  for (const field of Object.keys(kinds)) if (!Object.hasOwn(view, field)) delete kinds[field];
  const patches = diffViews(null, {}, view, kinds, { plugins, context: { to: { entry } } });
  // What a plugin lays after the field is made again (a text's marks).
  for (const field of Object.keys(kinds)) {
    const mod = plugins.byName[kinds[field]];
    if (mod !== undefined) patches.push(...mod.compact(entry, field, kinds[field]));
  }
  // A list made again names its elements anew, so what hangs under them is
  // written once the new names are known: the patches go in rounds, by the
  // members their field passes through, each round renaming the next.
  const nests = (field) => {
    const kind = kinds[field];
    return kind !== undefined && plugins.byName[kind]?.nests?.[kind] === true;
  };
  const depthOf = (field) => {
    if (field === undefined) return 0;
    let depth = 0;
    let member = false;
    for (const prefix of ancestorsOf(field)) {
      if (member) member = false;
      else if (nests(prefix)) {
        member = true;
        depth++;
      }
    }
    return depth;
  };
  const rounds = [];
  for (const patch of patches) (rounds[depthOf(patch.field)] ??= []).push(patch);
  const options = { actor, source, message };
  return core.run(async () => {
    const renames = [];
    const rename = (field) => {
      for (const [from, to] of renames) {
        if (field === from) return to;
        if (under(field, from)) return `${to}${field.slice(from.length)}`;
      }
      return field;
    };
    let count = 0;
    for (const round of rounds) {
      if (round === undefined || round.length === 0) continue;
      const renamed = round.map((patch) =>
        patch.field === undefined ? patch : { ...patch, field: rename(patch.field) },
      );
      count += await runOps(
        core,
        id,
        renamed.map((patch) => realize(patch, plugins)),
        options,
      );
      // The lists this round made again: their elements' new names, by position.
      const now = await core.current(id);
      for (const patch of round) {
        if (patch.field === undefined || !nests(patch.field)) continue;
        const mod = plugins.byName[kinds[patch.field]];
        const at = rename(patch.field);
        const was = mod.members(entry, patch.field);
        const is = mod.members(now, at);
        for (let i = 0; i < was.length && i < is.length; i++) {
          if (was[i] !== is[i]) renames.unshift([`${at}/${was[i]}`, `${at}/${is[i]}`]);
        }
      }
    }
    return count;
  });
};

module.exports = { sealed, reading, applyPatches, compact };
