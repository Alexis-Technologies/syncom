---
title: Schema migration
description: Change the shape of your records without a migration step at startup, read old records through the lens, and keep nodes on different versions in sync.
---

# Schema migration

Your app ships version 1, where a task has a `title`. Version 2 calls it `name`. On a server you would run a
migration before the new code starts. A local-first app cannot: thousands of devices upgrade on their own
schedule, some stay on version 1 for weeks, and all of them keep syncing with each other the whole time.

syncom handles this without a migration step at startup. Every node stamps its schema version on each op it
writes, every record remembers the version it was written under, and a node reads a record of an older version
through a **lens** that turns it into the current shape as it is read. Nothing on disk changes until you decide to
rewrite it, and a node on an older version keeps working with the records a newer one writes.

## Read old records in the new shape

Give the schema a `version` and, for the step to it, a migration. A migration is keyed by the version it migrates
**to**: `2` takes a record from version 1 to version 2.

<<< @/examples/migration-schema.mjs#v1

<<< @/examples/migration-schema.mjs#v2

The record on disk still has `title`: `getCachedData()` shows it as stored. Every read that returns a record
(`get()`, a query, a [document](./document), the record a write is validated against) goes through the lens and
sees `name`. `schemaInfo.previous` tells you that this database ran another version before this open; it is
`null` when nothing changed.

<FigLens />

`up(data, context)` receives the record without `$type` and returns it as it is under the next version. The
`context` carries `entity`, `id`, `from` and `to`. A migration may be `async`. The chain runs from the record's
version up to the current one, so a version 1 record read by version 4 goes through `2`, `3` and `4` in order. A
migration keyed by version alone (`{ 2: { up } }` instead of `{ 2: { Task: { up } } }`) applies to every record.

Queries match the view, not the stored data:

<<< @/examples/migration-schema.mjs#query

The lens result is computed once per cached record, so reading old records costs a migration call the first time
and nothing after.

## Let the validator do the renaming

If the entity has a [Standard Schema](./schema-validation) validator, the lens runs it after the migrations, and
whatever the validator transforms is part of the view. With metaschema, an alias is a rename and a default is a
new field filled in, so the step from version 1 to 2 needs no migration at all:

<<< @/examples/migration-schema.mjs#aliases

A validator that refuses an old record leaves the migrations' result as the view (and logs at debug level).
`schema.lens` picks the steps: `'both'` (the default), `'migrations'` alone, or `'validate'` alone, which refuses a
schema that also has `migrations`.

## Rewrite the old records

The lens means you never have to rewrite anything. When you do want the stored data in the new shape (to drop the
migration code later, or so that older tools read the new names), run `migrate()` once on one node:

<<< @/examples/migration-schema.mjs#migrate

Each record of an older version becomes a whole-record write of its view, under the current version. Fields of
other kinds are written again after it, because a whole-record write resets them: an `inc` per counter, an `add`
per set, one splice per list or text, one move per tree node. The result counts the records and the fields of
each kind. The writes are ordinary ops, so the other nodes receive them through sync. `migrate()` skips records
that are already current, so running it twice does nothing the second time. `{ entities: ['Task'] }` limits it to
some collections and `{ batch }` sets how many records go between turns of the event loop.

Run it on one node, after the nodes that write have upgraded. A node still on version 1 reads the rewritten
records as they are (with `name`), as the next section explains.

## Keep nodes on different versions in sync

Two nodes on two versions sync like any other two nodes. Here the server runs version 2 and the phone version 1:

<<< @/examples/migration-schema.mjs#peers

Each side reads the other's records its own way. The server reads the phone's version 1 record through its lens.
The phone has no idea what version 2 looks like, so it applies the server's op as it is, unvalidated, and emits a
`schema` event with `kind: 'ahead'`. Field writes travel as fields: an update made on the server carries only
the fields it changed, so the phone sees those fields next to the ones it already had.

If applying ops from a newer version is wrong for your app, hold them instead:

<<< @/examples/migration-schema.mjs#hold

With `ahead: 'hold'` the phone keeps the newer ops in its log, relays them to its own peers, and applies them on
the first open that runs that version. `schemaInfo.held` reports how many were applied (`replayed`) and how many
the log had already dropped before the upgrade (`lost`). Holding needs a log that keeps ops long enough, so
`sync.retention.ops` must be 1000 or more, or `0` to keep everything; anything else is a `TypeError` at open. A
database that ran a newer version cannot be reopened on an older one with `'hold'` (`DOWNGRADE`).

## Catch two builds that disagree

The version number is yours to bump, and forgetting to bump it is easy. `schema.snapshot` is any JSON describing
the schema, such as metaschema's `model.toJSON()`. syncom hashes it and compares hashes when nodes connect. Two
nodes that claim the same version with different hashes run two different schemas under one number, and both
emit a `schema` event with `kind: 'drift'`:

<<< @/examples/migration-schema.mjs#drift

The link stays up: drift is a warning, not a refusal. Fix it by bumping the version on the build that changed. If
the entity's validator rejects unknown fields (metaschema does unless the schema says `unknown: 'ignore'`), a
drifted peer's new field fails validation here and its op is skipped. metaschema's `diff()` and `compatibility()`
can catch the change in CI before it ships.

## Limitations

- There is no down-migration. A node on an older version reads newer records as written; plan renames so that
  older code survives the new field names, or hold newer ops.
- The lens applies to reads that return records. `snapshot()`, `getCachedData()`, a [JSON export](./import-export)
  and replication carry the raw stored data, so a peer on another version receives exactly what was written.
- A migration runs on read, so it must be fast and must not throw for a record it does not expect. A migration
  that returns something other than an object is a `TypeError`.
- Encrypted records are not migrated by `migrate()`.

## Coming from RxDB

RxDB migrates at startup: when a collection opens with a higher `version`, its `migrationStrategies` rewrite every
stored document, and the old documents are not readable until that finishes. syncom reads old records through the
lens at once and rewrites only when you call `migrate()`. RxDB also expects every replica to run the same
migration before syncing; here the version travels with each op, and nodes on different versions keep syncing.

::: code-group

<<< @/examples/migration-schema.mjs#v2 [syncom]

<<< @/examples/rxdb/migration-schema.mjs#v2 [RxDB]

:::

<FromRxdb page="migration-schema" :rows="['schemaVersion', 'migration', 'readOld', 'peerVersions', 'schemaHandshake']" />

`migrate()` and `schemaInfo` are in the [API reference](../reference/api#database), the `schema` event in
[Events and hooks](../reference/events#database-events).
