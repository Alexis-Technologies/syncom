---
title: Local documents
description: Keep values on one device beside the records with db.local and collection.local, never logged, never synced, never seen by a peer.
---

# Local documents

Some values belong to one device: the window layout, a half-written draft, the filter a user last picked, the
time of the last sync shown in a status bar. Writing them as records would put them in the log and send them to
every peer. A local document is stored next to the records but is never an op: not logged, not synced, not in a
snapshot, never seen by another node.

## Read and write a local document

<<< @/examples/local.mjs#basics

`db.local` is a small key-value store. A value is any JSON value; a key is text of up to 255 characters without
`/`. `get()` returns `null` for a key that is not there, and `list()` returns the keys, sorted.

The `local` plugin provides `db.local`. `@alexify/syncom/all` includes it; with the core alone, add it:

<<< @/examples/local.mjs#plugin

## Keep values per collection

<<< @/examples/local.mjs#collection

`collection.local` is the same store under the collection's name as a prefix: the collection's key `filter` is
the database's key `Task.filter`. Use it to keep a collection's view settings next to the collection.

## Update a value from its current one

<<< @/examples/local.mjs#function

`set(key, fn)` writes what the function returns for the current value (`null` when there is none). Writes to one key
run one at a time, so two updates made at once both count. Return `undefined` to leave the value as it is.

## React to changes

<<< @/examples/local.mjs#observe

`observe(key, listener)` calls the listener after every `set` and `delete` of that key (with `null` once deleted)
and returns a function that stops it. The database also emits a `local` event with the full key and the value on
every local write. For a UI framework, `toStore(db.local, key)` from `@alexify/syncom/store` turns a key into a
store (see [Reactivity](./reactivity)).

Only this instance hears these: another instance over the same storage (another tab, say) gets no event.

## What a local document is not

A local document never reaches another node:

<<< @/examples/local.mjs#peers

It is kept across restarts, removed with the database by `dropDatabase()`, and carried along by a
[storage migration](./migration-storage). It has no schema, no validation, no version history and no conflict
handling, because nothing else ever writes it. For a value that several devices should share, use a record, or
[app state](./state) over one.

A local write is refused where any write would be: after `close()` with `CLOSED`, and on a database that cannot
write (a follower tab, or one whose lease was lost) with `READ_ONLY`. Reads keep working.

<<< @/examples/local.mjs#closed

## Coming from RxDB

The same idea as RxDB's local documents, with less ceremony: no opt-in flag per database or collection, no
document object to fetch before you read it, and keys scoped to a collection by prefix. A local value is plain
JSON, so there is no `get('field')` on it; read the value and use it.

::: code-group

<<< @/examples/local.mjs#basics [syncom]

<<< @/examples/rxdb/local.mjs#basics [RxDB]

:::

<FromRxdb page="rx-local-document" :rows="['localDocs', 'rxState']" />

Every member is in the [reference](../reference/api#local-subpath).
