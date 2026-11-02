# Dumps, backups and imports

`@alexify/syncom/dump` turns a database into JSON and back.

## Export

```js
const { exportJSON, exportPages } = require('@alexify/syncom/dump');

const dump = await exportJSON(db);
// { format: 1, node, schema: { version, hash }, kinds, eventId, vector, meta: true, records: [...] }
```

The records are every record a snapshot would hand a peer — live ones and tombstones, each with its
meta, in id order — so another node joins them exactly. `{ collections: ['Post'] }` keeps to those
collections, `{ scopes }` to the records in those scopes, and `{ meta: false }` hands the live records
as they read, data alone, for a reader that is no syncom. `exportPages(db, options)` is the same a page
at a time (`limit` records, 500 by default), an async iterator.

## Import

```js
const { importJSON } = require('@alexify/syncom/dump');

await importJSON(other, dump);                      // { mode: 'merge', records: 5 }
await importJSON(other, dump, { mode: 'insert' }); // new ops under the same ids
```

- **`merge`** (the default) joins the records with their meta as a bootstrap does: one `merge` op per
  record, this node's own, exact to the source — tombstones and purges included; peers that resume from
  this node's log receive them too. It needs a dump made with meta.
- **`insert`** writes each record's data under its id as a plain write — new ops, new stamps, the
  importing node's; a record whose meta holds a tombstone is deleted. A foreign dump —
  `{ records: [{ id, data }] }` from any other database — imports the same way.

A dump made under another schema hash than the database runs is refused with `SCHEMA_MISMATCH`
(`expected`, `given`) unless `{ force: true }`: a reader that lenses records by version would otherwise
read them wrong.

## Backup

A backup is the dump written to a file, and the file imported back:

```js
const { writeFile, readFile } = require('node:fs/promises');
await writeFile('backup.json', JSON.stringify(await exportJSON(db)));
await importJSON(db, JSON.parse(await readFile('backup.json', 'utf8')));
```

A live backup follows the `transaction` event — its `changes` name the records of every turn — and
exports those records with `exportPages(db, { collections })`, or copies the whole dump on a timer.
The chain, the log and the identity are not in a dump: a restored node is a new node holding the same
records (`merge`) — to move a node whole, move the engine.

## Moving between engines

```js
const { migrateStorage } = require('@alexify/syncom/dump');
const { sqliteEngine } = require('@alexify/syncom/sqlite');

await migrateStorage({ from: filesEngine(fsi), to: sqliteEngine({ file: 'data.db' }), path: 'data' });
```

`copy` (the default) is `copyEngine` of `@alexify/syncom/engines`: the same node on the new engine — its
identity, its log and vector, every record with its pieces, the tags, the chain — over closed databases,
held by their locks while it runs. `{ mode: 'merge' }` takes two open databases instead and merges an
export of the first into the second: a new node that holds what the old one held.
