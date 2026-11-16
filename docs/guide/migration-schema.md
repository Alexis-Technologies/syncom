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
through a **lens** that turns it into the current shape as it is read. Nothing on disk changes until you write to the
record or decide to migrate them all, and a node on an older version keeps working with the records a newer one
writes.

## Read old records in the new shape

Give the schema a `version` and, for the step to it, a migration. A migration is keyed by the version it migrates
**to**: `2` takes a record from version 1 to version 2.

<<< @/examples/migration-schema.mjs#v1

<<< @/examples/migration-schema.mjs#v2

The record on disk still has `title`: `getCachedData()` shows it as stored. Every read that returns a record
(`get()`, a query, a [document](./document)) goes through the lens and sees `name`, until a write
[migrates the record](#write-to-a-record-not-yet-migrated) to the new shape. `schemaInfo.previous` tells you
that this database ran another version before this open; it is `null` when nothing changed.

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

## Write to a record not yet migrated

A write to a field of a record still of an older version (an `update()`, an `inc()`, an `add()`, a `modify()`, a
list or text edit, a write inside a transaction) migrates that record first. syncom writes what the lens changed
and nothing else, as one op that also marks the record as being of the current version, then your write. Both go
in one transaction, so nothing reads the record in between:

<<< @/examples/migration-schema.mjs#write-old

Without that step the record would stay of version 1 with a version 2 field in it, and the lens, which runs over
the whole record, would read `name: title` over the `name` you just wrote. The migration is the one `migrate()`
makes for that record (below). The validator checks it together with your write, so an update that brings an old
record a field it was missing lands, and one that leaves it invalid is refused whole. A write that makes nothing,
such as a `swap()` whose expectation no longer holds, migrates nothing either (inside a transaction of yours, the
migration stays). A whole-record write (`set()`, `upsert()`) needs no such step: it writes the record under the
current version.

### What a migration writes

syncom compares the record as it is stored with the record as the lens reads it, field by field. A field the lens
left alone is not written at all, whatever its [kind](./fields). In the example above `done` is not in the
migration's op. A text keeps every character with its author and its marks, a counter keeps each node's count, and
a set, a list and a tree keep their elements. An edit another node made to such a field without knowing of the
migration merges as it would on any record; the [two nodes below](#keep-nodes-on-different-versions-in-sync) show
it.

A field the lens did change is written by its kind. A register (a plain value) gets its new value and a name the
lens removed is unset, both in the migration's op. A counter, a set, a list, a text or a tree is laid again from
what it reads as now: a counter as one increment, a set as its elements, a list or a text as one run of content, a
tree as one move per node. That happens when the lens rewrites such a field, and when it renames one: a new name
that reads exactly as a removed one did takes over its kind. A field laid again starts over. It keeps what it
reads as, and a renamed text keeps its marks and embeds too. It loses its history: who wrote which part, the
cursors into it, and any edit another node made to the old field at the same time. A text whose content the lens
rewrote also loses its marks and the values of its embeds.

Where the lens gives such a field a value of another type (a string where the counter was), or the field has
[paths](./fields#edit-part-of-an-object) under it, it becomes a register. A set, a list, a text or a tree that
reads empty after the lens is left out, as on a record that never had it. syncom tells a rename by the value
alone, since a migration has no other way to say it: a new name whose value equals that of a removed counter,
set, list, text or tree is taken for that field.

## Migrate the old records

The lens means you never have to migrate anything. When you do want the stored data in the new shape (to drop the
migration code later, or so that older tools read the new names), run `migrate()` once on one node:

<<< @/examples/migration-schema.mjs#migrate

Each record of an older version gets the migration described above, in a transaction of its own: one op that
marks it as being of the current version and carries what the lens changed. The result counts the records
migrated and, for each kind, the fields that were laid again. Those are all `0` when the lens only touches plain
values, as here. The writes are ordinary ops, so the other nodes receive them through sync. `migrate()` skips
records that are already current (a record a write or another node migrated first among them), so running it
twice does nothing the second time. `{ entities: ['Task'] }` limits it to some collections and `{ batch }` sets
how many records go between turns of the event loop.

Run it on one node, after the nodes that write have upgraded. A node still on version 1 reads the migrated
records as they are (with `name`), as the next section explains.

## Keep nodes on different versions in sync

Two nodes on two versions sync like any other two nodes. Here the server runs version 2 and the phone version 1:

<<< @/examples/migration-schema.mjs#peers

Each side reads the other's records its own way. The server reads the phone's version 1 record through its lens.
The phone has no idea what version 2 looks like, so it applies the server's op as it is, unvalidated, and emits a
`schema` event with `kind: 'ahead'`. A write the server makes to a record of version 1 migrates it first, so the
phone receives the fields the lens changed (`name` in place of `title`) and reads the record as version 2 wrote it
from then on. An update the server makes to a record already of version 2 carries only the fields it changed.
`createMesh` and its links are a test stand-in from `@alexify/syncom/testing`; an app opens each database where it
runs and connects them with a [transport](./replication).

A migration does not get in the way of what the phone is doing to the rest of the record. Here the phone types
into the task's notes while it is offline, and the server migrates the task in the meantime:

<<< @/examples/migration-schema.mjs#keep-text

The record's version is decided by its newest whole-record write or migration, by their
[stamps](./glossary#stamp). If the phone, still on version 1, writes the whole record (`set()`, `upsert()`) after
the server migrated it, the record is a version 1 record again, in the phone's shape, and the server reads it
through the lens again. If the phone's write is the older of the two, the migration stands over it. Either way
every node ends up with the same record of the same version, whatever order the two arrive in.

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
- Encrypted records are not migrated by `migrate()`, nor by a write.
- A counter, a set, a list, a text or a tree that the lens renames or rewrites is laid again from what it reads
  as. Its history and the cursors into it are gone, a rewritten text loses its marks, and an edit another node
  made to the old field at the same time is lost. Two nodes that migrate the same record within the same few milliseconds may each lay
  such a field, and a text or a counter then comes out doubled. Fields the lens leaves alone are not affected.
  Rename or reshape such a field once the nodes that write have upgraded, and run `migrate()` on one node.
- A node still on the older version that edits a field the migration removed brings that field back beside the new
  one, and its whole-record write makes the record one of its version again. Upgrade the nodes that write before
  old records are edited from both sides at once.
- An editor's text handle (`openText()`) edits a record as it is: its keystrokes do not migrate an old record
  first. Write to the record once, or run `migrate()`, before you hand it to an editor.

## Coming from RxDB

RxDB migrates at startup: when a collection opens with a higher `version`, its `migrationStrategies` rewrite every
stored document, and the old documents are not readable until that finishes. syncom reads old records through the
lens at once and migrates a record only when you write to it or call `migrate()`. RxDB also expects every replica to run the same
migration before syncing; here the version travels with each op, and nodes on different versions keep syncing.

::: code-group

<<< @/examples/migration-schema.mjs#v2 [syncom]

<<< @/examples/rxdb/migration-schema.mjs#v2 [RxDB]

:::

<FromRxdb page="migration-schema" :rows="['schemaVersion', 'migration', 'readOld', 'peerVersions', 'schemaHandshake']" />

`migrate()` and `schemaInfo` are in the [API reference](../reference/api#database), the `schema` event in
[Events and hooks](../reference/events#database-events).
