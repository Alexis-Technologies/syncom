'use strict';

// Dumps (@alexify/syncom/dump): a database as JSON and back. `exportJSON`
// is every record a snapshot would hand a peer — live ones and tombstones,
// each with its meta, so another node joins it exactly — under a header
// (the node, the schema's version and hash, the kinds, the log position);
// `meta: false` is the live records as they read, data alone, for a reader
// that is no syncom. `exportPages` is the same a page at a time.
// `importJSON` takes a dump back: `merge` joins the records with their meta
// as a bootstrap does (one op per record, this node's own, so peers that
// resume from this node's log receive them too); `insert` writes the data
// under the same ids as plain writes — new ops, new stamps — and takes a
// foreign dump (`{ records: [{ id, data }] }`) the same way. A dump made under
// another schema is refused (SCHEMA_MISMATCH) unless forced. `migrateStorage`
// moves a database between engines: `copy` is `copyEngine` — the same node on
// the new engine — `merge` an export of one open database imported into
// another, a new node that holds what the old one held. Requires symbols.js,
// shape.js, errors.js and the engines' copy.js only.

const { SOURCE } = require('../symbols.js');
const { isPlainObject, isRecordId } = require('../shape.js');
const { SyncomError } = require('../errors.js');
const { copyEngine } = require('../engines/copy.js');

const FORMAT = 1;
const PAGE = 500;

const isDatabase = (value) =>
  value !== null &&
  typeof value === 'object' &&
  typeof value.snapshot === 'function' &&
  typeof value.mergeSnapshot === 'function' &&
  typeof value.transact === 'function';

// The collections a dump keeps to: a Set of names, or null for every record.
const collectionSet = (collections) => {
  if (collections === undefined || collections === null) return null;
  if (!Array.isArray(collections)) throw new TypeError('collections must be an array of names');
  const set = new Set();
  for (let i = 0; i < collections.length; i++) {
    if (typeof collections[i] !== 'string') throw new TypeError('collections must be an array of names');
    set.add(collections[i]);
  }
  return set;
};

/**
 * The records of `db` a page at a time, in id order: each `{ id, data,
 * meta }` as a snapshot hands it (tombstones included), or — `meta: false`
 * — `{ id, data }` of the live records as they read. `collections` keeps
 * to those (by the catalog's row), `scopes` to the records in them.
 */
async function* exportPages(db, { collections, scopes = null, meta = true, limit = PAGE } = {}) {
  if (!isDatabase(db)) throw new TypeError('exportPages() takes a database');
  if (!Number.isInteger(limit) || limit < 1) throw new TypeError('exportPages(): limit must be a positive integer');
  const only = collectionSet(collections);
  const source = db[SOURCE];
  let cursor = null;
  for (;;) {
    const page = await db.snapshot({ cursor, limit, scopes });
    const records = [];
    for (let i = 0; i < page.records.length; i++) {
      const record = page.records[i];
      if (only !== null) {
        const type = source.row(record.id)?.type ?? record.data?.$type;
        if (!only.has(type)) continue;
      }
      if (meta) records.push(record);
      else {
        const data = await source.load(record.id);
        if (data !== null) records.push({ id: record.id, data });
      }
    }
    if (records.length > 0) yield records;
    if (page.cursor === null) return;
    cursor = page.cursor;
  }
}

/**
 * The whole database as one JSON value: `{ format, node, schema, kinds,
 * eventId, vector, records }` — the records as `exportPages` hands them.
 */
const exportJSON = async (db, options = {}) => {
  if (!isDatabase(db)) throw new TypeError('exportJSON() takes a database');
  const records = [];
  for await (const page of exportPages(db, options)) for (let i = 0; i < page.length; i++) records.push(page[i]);
  const info = db.schemaInfo;
  return {
    format: FORMAT,
    node: db.nodeId,
    schema: info === null ? null : { version: info.version, hash: info.hash },
    kinds: db.kinds.slice(),
    eventId: db.log.lastEventId,
    vector: JSON.parse(JSON.stringify(db.vector)),
    meta: options.meta !== false,
    records,
  };
};

// The dump's records, checked: an array of `{ id, data }`, the id an id.
const recordsOf = (dump) => {
  if (!isPlainObject(dump) || !Array.isArray(dump.records)) {
    throw new TypeError('importJSON() takes a dump: { records }');
  }
  for (let i = 0; i < dump.records.length; i++) {
    const record = dump.records[i];
    if (!isPlainObject(record) || !isRecordId(record.id) || !isPlainObject(record.data)) {
      throw new TypeError(`importJSON(): record ${i} is not { id, data }`);
    }
  }
  return dump.records;
};

/**
 * A dump into `db`: `merge` joins the records with their meta as a
 * bootstrap does (every record needs its meta: a `meta: true` dump) —
 * what the source held, tombstones included, converged; `insert` writes
 * each record's data under its id as a plain write (a record with a
 * tombstone in its meta is deleted) — new ops of this node — and takes a
 * foreign dump the same way. A dump made under another schema hash is
 * SCHEMA_MISMATCH unless `force`. Resolves to `{ mode, records }`.
 */
const importJSON = async (db, dump, { mode = 'merge', force = false, batch = PAGE } = {}) => {
  if (!isDatabase(db)) throw new TypeError('importJSON() takes a database');
  if (mode !== 'merge' && mode !== 'insert') throw new TypeError("importJSON(): mode is 'merge' or 'insert'");
  if (!Number.isInteger(batch) || batch < 1) throw new TypeError('importJSON(): batch must be a positive integer');
  const records = recordsOf(dump);
  const given = isPlainObject(dump.schema) ? dump.schema : null;
  const mine = db.schemaInfo;
  if (!force && given !== null && mine !== null && given.hash !== mine.hash) {
    throw new SyncomError(
      'SCHEMA_MISMATCH',
      'The dump was made under another schema; importJSON({ force: true }) takes it',
      {
        expected: mine.hash,
        given: given.hash,
      },
    );
  }
  if (mode === 'merge') {
    for (let i = 0; i < records.length; i++) {
      if (!isPlainObject(records[i].meta)) {
        throw new TypeError(`importJSON(): record ${records[i].id} has no meta to merge`);
      }
    }
    for (let i = 0; i < records.length; i += batch) await db.mergeSnapshot(records.slice(i, i + batch));
    return { mode, records: records.length };
  }
  for (let i = 0; i < records.length; i += batch) {
    const page = records.slice(i, i + batch);
    await db.transact(async (tx) => {
      for (let k = 0; k < page.length; k++) {
        const { id, data, meta } = page[k];
        if (isPlainObject(meta) && meta.deleted) await tx.delete(id);
        else await tx.set(id, data);
      }
    });
  }
  return { mode, records: records.length };
};

/**
 * A database moved between engines: `copy` (`from`, `to` engines, `path`)
 * is `copyEngine` — the same node, its identity, log and vector, on the new
 * engine; `merge` (`from`, `to` open databases) exports `from` and merges
 * it into `to` — a new node that holds what the old one held. Resolves to
 * what the copy counted, or `{ mode, records }`.
 */
const migrateStorage = async ({ from, to, path, mode = 'copy', batch = PAGE } = {}) => {
  if (mode === 'copy') return copyEngine(from, to, { path, batch });
  if (mode !== 'merge') throw new TypeError("migrateStorage(): mode is 'copy' or 'merge'");
  if (!isDatabase(from) || !isDatabase(to)) {
    throw new TypeError('migrateStorage({ mode: "merge" }) takes two open databases');
  }
  let records = 0;
  for await (const page of exportPages(from, { limit: batch })) {
    await to.mergeSnapshot(page);
    records += page.length;
  }
  return { mode, records };
};

module.exports = { exportPages, exportJSON, importJSON, migrateStorage, FORMAT };
