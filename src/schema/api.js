'use strict';

// What the schema plugin does over the core beyond the definitions: the
// version file a directory remembers (`loadVersion`, at setup), and the
// storage's methods — `migrate()` and `check()` — over the `core` Storage
// lends (src/database.js #lend). The core applies the definitions; nothing
// here reaches the storage's state but through `core`.

const { SyncomError } = require('../errors.js');
const { isPlainObject, deepEqual } = require('../shape.js');
const { compose } = require('../compose.js');
const { project } = require('./entity.js');

const SCHEMA_FILE = 'schema.json';

// `schema.json` remembers the version (and the snapshot's hash) this
// directory last ran: a change since is `previous` — a fact the caller reads
// after open (`schemaInfo`), where an event at open would find no listener
// yet. The hash is of the snapshot's JSON; metaschema's `model.toJSON()` is
// deterministic, a hand-written one is as stable as its author keeps it.
// A downgrade under `ahead: 'hold'` is refused: its own records are of the
// version it ran. Resolves to `{ hash, previous }`.
const loadVersion = async ({ db, logger, hash: sha256 }, { version, snapshot, ahead }) => {
  const hash = snapshot === undefined ? null : await sha256(snapshot);
  let stored = null;
  const text = await db.kv.get('', SCHEMA_FILE);
  if (text !== null) {
    let raw;
    try {
      raw = JSON.parse(text);
    } catch (error) {
      const message = `${SCHEMA_FILE} is unreadable (${error.message}); restore it or remove the directory`;
      throw new SyncomError('CORRUPT', message, { cause: error });
    }
    if (isPlainObject(raw) && Number.isInteger(raw.version)) {
      stored = { version: raw.version, hash: typeof raw.hash === 'string' ? raw.hash : null, migrated: raw.migrated };
    }
  }
  if (stored && stored.version === version && stored.hash === hash) return { hash, previous: null };
  let previous = null;
  if (stored) {
    previous = { version: stored.version, hash: stored.hash };
    const event = stored.version === version ? 'schema.changed' : 'schema.upgrade';
    logger[stored.version > version ? 'warn' : 'info']({ event, from: stored.version, to: version });
    if (stored.version > version && ahead === 'hold') {
      throw new SyncomError(
        'DOWNGRADE',
        `Schema version ${version} is below the ${stored.version} this directory ran; ahead 'hold' cannot downgrade`,
      );
    }
  }
  // `migrated`: when this version first ran here — kept across a snapshot
  // change of the same version.
  const migrated = stored?.version === version && Number.isInteger(stored.migrated) ? stored.migrated : Date.now();
  await db.kv.put('', SCHEMA_FILE, JSON.stringify({ version, migrated, hash }), { atomic: true });
  return { hash, previous };
};

// The entity names `migrate({ entities })` keeps to: null for all of them,
// undefined for anything but an array of strings.
const entityNames = (entities) => {
  if (entities === null) return null;
  if (!Array.isArray(entities)) return undefined;
  const names = new Set();
  for (let i = 0; i < entities.length; i++) {
    if (typeof entities[i] !== 'string') return undefined;
    names.add(entities[i]);
  }
  return names;
};

// Whether the lens left a value as it read.
const same = (a, b) => a === b || deepEqual(a, b);

// Whether `value` is what a field reading `held` could read as: a number where a counter was, a string a text,
// an array a set, a list or a tree. A value of another type is laid as a register.
const fits = (held, value) =>
  typeof value === typeof held &&
  Array.isArray(value) === Array.isArray(held) &&
  (typeof value !== 'number' || Number.isFinite(value));

// The ops that lay `value` under `key` as a field of `kind` made from nothing: a counter as one `inc`, a set as
// one `add`, a plugin's kind as its module lays it (a list or a text as one run, a tree as one move per node,
// parents first) — none for a set, a list, a text or a tree that reads empty, which no op makes. `from` is the
// entry and the field the value was read from, for a rename: a text's marks and embeds come along.
const layOf = (plugins, kind, key, value, from) => {
  if (kind === 'counter') return [['inc', { key, value }]];
  if (kind === 'set') return value.length === 0 ? [] : [['add', { key, value }]];
  return plugins.byName[kind].migrate(kind, key, value, from);
};

/**
 * One record of an older version moved to this one: ONE `version` op — the record is of this version from its
 * stamp on — carrying what the lens changed of it, and nothing else: the names the lens removed (`value`), the
 * registers it wrote (`data`). The record is compared as it reads, name by name (a name with everything under
 * it), raw against lensed: a name the lens left as it read is not written at all, whatever its kind — a text
 * keeps its runs, its marks and every stamp, a counter its slots, a set its tags, and a peer's concurrent edit of
 * it lands as on any record. A counter, a set, a list, a text or a tree the lens DID change is laid again from
 * its new reading, after the op and over an unset of its name in it (so two migrations do not lay it twice): as
 * its kind where the value is still one of that kind, and under a new name where a name the lens removed read
 * exactly so (a rename: a text's marks and embeds come along) — left out where that reading is empty, which no
 * op makes; as a register otherwise, and where something hangs under the name (a path, a list's element's
 * field). Each through `core.commit` with `options`. What migrate() does per record, and what a local write to
 * such a record runs first, inside its transaction (src/commit.js `commitIn`, the core's `upgrade`: the view of
 * a lens that ran over the record AND the write would read the write's fields over). Counts the fields of each
 * kind it laid again into `result`, when given.
 */
const migrateRecord = async (core, id, entry, options, result = null) => {
  const { plugins } = core;
  const view = await core.view(id, entry);
  const raw = compose(entry, plugins);
  // The names something hangs under: such a field is one reading with what hangs there, laid as a register.
  const parents = new Set();
  const fields = Object.keys(entry.data);
  for (let i = 0; i < fields.length; i++) {
    const at = fields[i].indexOf('/');
    if (at !== -1) parents.add(fields[i].slice(0, at));
  }
  const unset = [];
  // The names the lens removed that held a field of another kind than a register: what a rename is told by.
  const renamable = [];
  const names = Object.keys(raw);
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    if (Object.hasOwn(view, name) && view[name] !== undefined) continue;
    unset.push(name);
    const kind = core.kindOf(entry, name);
    if (kind !== undefined && kind !== 'register' && !parents.has(name)) renamable.push([name, kind]);
  }
  const data = {};
  let wrote = false;
  const laid = [];
  const keys = Object.keys(view);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const value = view[key];
    if (value === undefined) continue;
    const held = Object.hasOwn(raw, key);
    if (held && same(raw[key], value)) continue;
    let kind = 'register';
    let from = null;
    if (held) {
      const was = core.kindOf(entry, key);
      if (was !== undefined && was !== 'register' && !parents.has(key) && fits(raw[key], value)) kind = was;
    } else {
      // A new name that reads exactly as a removed one did is that field renamed: its kind comes along.
      for (let j = 0; j < renamable.length; j++) {
        if (renamable[j] === null || !same(raw[renamable[j][0]], value)) continue;
        kind = renamable[j][1];
        from = { entry, field: renamable[j][0] };
        renamable[j] = null;
        break;
      }
    }
    if (kind === 'register') {
      data[key] = value;
      wrote = true;
      continue;
    }
    // A set, a list, a text or a tree that reads empty is laid by no op: the field is left out, as one never
    // written (a register in its place would refuse the kind's next op on this record alone).
    const ops = layOf(plugins, kind, key, value, from);
    if (held || ops.length > 0) unset.push(key);
    for (let j = 0; j < ops.length; j++) laid.push(ops[j]);
    if (ops.length > 0 && result !== null) result[`${kind}s`] = (result[`${kind}s`] ?? 0) + 1;
  }
  const payload = {};
  if (unset.length > 0) payload.value = unset;
  if (wrote) payload.data = data;
  await core.commit('version', id, payload, options);
  for (let i = 0; i < laid.length; i++) await core.commit(laid[i][0], id, laid[i][1], options);
};

/**
 * Moves every record of an older version to this one, through the lens (`migrateRecord`: what the lens changed
 * and nothing else), each record a transaction of its own. One designated node runs it; peers receive ordinary
 * ops. Idempotent — a record already of this version is left alone, and so is one a local write or a peer
 * migrated meanwhile (read again inside the queue). `entities` limits it to those collections; `batch` is how
 * many records go between turns of the event loop. Resolves to the records migrated and, per kind, the fields
 * laid again.
 */
const migrate = async (core, { entities = null, batch = 100, actor } = {}) => {
  if (core.version === null) throw new TypeError('migrate() needs createDatabase({ schema })');
  const names = entityNames(entities);
  if (names === undefined) throw new TypeError('migrate({ entities }) takes an array of entity names');
  if (!Number.isInteger(batch) || batch < 1) throw new TypeError('migrate({ batch }) takes a positive integer');
  const result = { migrated: 0, counters: 0, sets: 0, lists: 0, texts: 0, trees: 0 };
  const due = (entry) =>
    entry !== null &&
    entry !== undefined &&
    !entry.encrypted &&
    core.alive(entry) &&
    (entry.meta.v ?? 1) < core.version &&
    (names === null || names.has(entry.data.$type));
  let since = 0;
  for (const id of core.catalog.ids()) {
    if (!due(await core.entries.load(id))) continue;
    const { result: moved, done } = await core.transact(
      async (tx) => {
        const entry = await tx.current(id);
        if (!due(entry)) return false;
        await migrateRecord(tx, id, entry, { actor }, result);
        return true;
      },
      { actor },
    );
    if (done !== null) await done;
    if (!moved) continue;
    result.migrated++;
    if (++since >= batch) {
      since = 0;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  return result;
};

/** Runs an entity's validator as a write would and resolves to its value; writes nothing. */
const check = async (core, entity, data) => {
  const def = core.entities.get(entity);
  if (!def) throw new TypeError(`Unknown entity ${entity}`);
  if (!isPlainObject(data)) throw new TypeError('check() takes a plain object');
  if (!def.validator) return data;
  const id = def.idField !== false && typeof data[def.idField] === 'string' ? data[def.idField] : null;
  return def.validator(project(def, id, data));
};

module.exports = { SCHEMA_FILE, loadVersion, migrate, migrateRecord, check };
