'use strict';

// What the schema plugin does over the core beyond the definitions: the
// version file a directory remembers (`loadVersion`, at setup), and the
// storage's methods — `migrate()` and `check()` — over the `core` Storage
// lends (src/storage.js #lend). The core applies the definitions; nothing
// here reaches the storage's state but through `core`.

const { SyncomError } = require('../errors.js');
const { isPlainObject } = require('../shape.js');
const { project } = require('../entity.js');

const SCHEMA_FILE = 'schema.json';

// `schema.json` remembers the version (and the snapshot's hash) this
// directory last ran: a change since is `previous` — a fact the caller reads
// after open (`schemaInfo`), where an event at open would find no listener
// yet. The hash is of the snapshot's JSON; metaschema's `model.toJSON()` is
// deterministic, a hand-written one is as stable as its author keeps it.
// A downgrade under `ahead: 'hold'` is refused: its own records are of the
// version it ran. Resolves to `{ hash, previous }`.
const loadVersion = async ({ fsi, path, logger, hash: sha256 }, { version, snapshot, ahead }) => {
  const hash = snapshot === undefined ? null : await sha256(snapshot);
  let stored = null;
  if (await fsi.exists(path, SCHEMA_FILE)) {
    let raw;
    try {
      raw = JSON.parse(await fsi.read(path, SCHEMA_FILE));
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
  await fsi.write(path, SCHEMA_FILE, JSON.stringify({ version, migrated, hash }), { atomic: true });
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

/**
 * Rewrites every record of an older version as this one, through the lens:
 * a whole-record write of the view, then the counters and the sets added
 * back (a write resets them), a plugin's field as the ops its module lays.
 * One designated node runs it; peers receive ordinary ops. Idempotent — a
 * record already of this version is left alone. `entities` limits it to
 * those collections; `batch` is how many records go between turns of the
 * event loop.
 */
const migrate = async (core, { entities = null, batch = 100, actor } = {}) => {
  if (core.version === null) throw new TypeError('migrate() needs open({ schema })');
  const names = entityNames(entities);
  if (names === undefined) throw new TypeError('migrate({ entities }) takes an array of entity names');
  if (!Number.isInteger(batch) || batch < 1) throw new TypeError('migrate({ batch }) takes a positive integer');
  const result = { migrated: 0, counters: 0, sets: 0, lists: 0, texts: 0, trees: 0 };
  let since = 0;
  for (const id of core.catalog.ids()) {
    const entry = await core.entries.load(id);
    if (!entry || entry.encrypted || (entry.meta.v ?? 1) >= core.version) continue;
    if (names !== null && !names.has(entry.data.$type)) continue;
    const view = await core.view(id, entry);
    const data = {};
    const kinds = {};
    for (const key of Object.keys(view)) {
      const kind = core.kindOf(entry, key);
      if (kind === undefined || kind === 'register') data[key] = view[key];
      else kinds[key] = kind;
    }
    await core.commit('write', id, { data }, { actor });
    for (const key of Object.keys(kinds)) {
      const kind = kinds[key];
      const value = entry.data[key];
      if (kind === 'counter') {
        await core.commit('inc', id, { key, value }, { actor });
        result.counters++;
      } else if (kind === 'set') {
        // A set with nothing live has nothing to add back: it is dropped.
        if (value.length === 0) continue;
        await core.commit('add', id, { key, value }, { actor });
        result.sets++;
      } else {
        // A plugin's field comes back as the ops its module lays — a list
        // or a text as one run, a tree as one move per node, parents first
        // — and one with nothing to read is dropped.
        const ops = core.plugins.byName[kind].migrate(kind, key, value);
        if (ops.length === 0) continue;
        for (let i = 0; i < ops.length; i++) await core.commit(ops[i][0], id, ops[i][1], { actor });
        result[`${kind}s`] = (result[`${kind}s`] ?? 0) + 1;
      }
    }
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

module.exports = { SCHEMA_FILE, loadVersion, migrate, check };
