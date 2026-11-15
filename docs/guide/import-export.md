---
title: JSON import and export
description: Export a database or some collections as JSON with exportJSON() and exportPages(), and import it back with importJSON() as a merge or as new writes.
---

# JSON import and export

`@alexify/syncom/dump` turns a database into one JSON value and back. Use it to copy data into another database,
to seed a test or a demo, to hand records to a tool that is not syncom, or to [back up](./backup) a database to a
file. Imports come in two kinds: a **merge**, which brings records over with their full sync state, and an
**insert**, which writes their data as new writes.

## Export a database

<<< @/examples/import-export.mjs#export

A dump holds every record a [snapshot](./sync-protocol) would hand a peer: live records and tombstones, each with
the metadata that lets another node merge it exactly, in id order. Beside the records it names the node that made
it, its schema version and hash, the field kinds it holds, and its position in the log (`eventId` and `vector`).

To export some collections, or plain data for a reader that is not syncom, narrow it down:

<<< @/examples/import-export.mjs#plain

`collections` keeps to those collections and `scopes` to the records in those [scopes](./partial-sync).
`meta: false` exports the live records as they read, data alone: no tombstones, nothing to merge with, the JSON a
spreadsheet or a script expects.

## Export a large database a page at a time

`exportJSON()` builds the whole dump in memory. `exportPages()` yields the same records a page at a time
(`limit` records, 500 by default), so you can stream them into a file or a request:

<<< @/examples/import-export.mjs#pages

## Import as a merge

<<< @/examples/import-export.mjs#merge

The default mode, `merge`, joins each record with its metadata the way a node joins a snapshot when it bootstraps.
The result is exact: a counter stays a counter (the copy above can keep counting votes), a set stays a set,
tombstones stay deleted, and merging the same dump twice changes nothing. Each record becomes one op of the
importing node, so the node's peers receive the records through sync. A merge needs a dump made with metadata.

## Import as new writes

<<< @/examples/import-export.mjs#insert

`mode: 'insert'` writes each record's data under its id as an ordinary write of the importing node, with new
timestamps. A record that is deleted in the dump is deleted here. The record's data is written whole, so field
kinds are not kept: a counter or a set in the dump becomes a plain value. Use it when the imported data should
win over what the database holds, or when the dump has no metadata.

The same mode imports records from anywhere. A dump is only `{ records: [{ id, data }] }` as far as an insert is
concerned, so data exported from another database imports once you shape it that way:

<<< @/examples/import-export.mjs#foreign

Put the collection in `data.$type`, and mark records to delete with `deleted: true`. Ids must be valid syncom ids
(letters, digits, `_`, `@`, `-` and `.`, up to 128 characters).

## Import under another schema

<<< @/examples/import-export.mjs#mismatch

A dump records the hash of the schema it was made under. Importing it into a database that runs another schema
hash rejects with `SCHEMA_MISMATCH`, because records of one shape would be read as another. Pass `force: true` when
you know the records read the same under both, for example after a change that only added an optional field. A
database without `schema.snapshot` has no hash, so dumps between such databases always import.

## Limitations

- A dump holds records, not the operation log, the [audit chain](./chain) or the node's identity. A database
  restored from a dump is a new node that holds the same records. To move a node whole, use
  [storage migration](./migration-storage).
- [Encrypted](./encryption) records are not in a dump.
- [Attachments](./attachments) travel as their entries on the record, not as bytes.
- A dump of another `format` is refused with a `TypeError`.

## Coming from RxDB

RxDB's `exportJSON()` holds the live documents and imports them as new inserts into a database with the same
schemas. syncom's dump also carries tombstones and the merge state, so the default import merges, exactly, into a
database that already has data. The insert mode is the closer match to RxDB's import.

::: code-group

<<< @/examples/import-export.mjs#export [syncom]

<<< @/examples/rxdb/import-export.mjs#export [RxDB]

:::

<FromRxdb page="json-import-export" :rows="['jsonDump', 'importFromOtherDbs', 'encExport']" />

Every option is in the [reference](../reference/api#dump-subpath).
