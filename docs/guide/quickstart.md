---
title: Quickstart
description: Build a task board with syncom in a few minutes, from the first record to two nodes that stay in sync.
---

# Quickstart

This page builds a small shared task board. You open a database, add a collection, write and query tasks,
watch a query change, and then connect a second node that gets every task and sends its own back. Every
snippet is part of one script that runs as written; the [Installation](./install) page covers the setup
details this page skips.

<div class="sc-steps">

### Install the package

syncom has no runtime dependencies and runs on Node.js 24 or newer and in modern browsers. It is not on npm
yet, so depend on the repository (a git dependency or a workspace link) until the first release. Once it is
published:

```bash
npm install @alexify/syncom
```

### Open a database

`createDatabase()` opens (or creates) a database in a directory and resolves once it is ready to use.
`@alexify/syncom/all` is the core with every plugin the package ships, which is the easiest way to start;
[Installation](./install#pick-only-the-plugins-you-need) shows how to import only what you use.

<<< @/examples/quickstart.mjs#open

In Node.js the data lives in the `board` directory. In a browser the same call stores it in the
[Origin Private File System](./storage-opfs), and other [storages](./storage) are one option away.

### Add a collection

A collection groups records of one kind and lets you query them. Declare it in the `schema` option. The
`index` makes queries on `done` fast; a schema can also validate every record, which the
[Schema](./schema) page shows.

<<< @/examples/quickstart.mjs#collection

### Insert a task

`insert()` stores a record and returns a live [document](./document) for it, with an `id` that syncom
generates unless you pass one.

<<< @/examples/quickstart.mjs#insert

### Query tasks

`select()` takes a MongoDB-style query and returns a cursor. `fetch()` reads the matching rows as plain
objects.

<<< @/examples/quickstart.mjs#query

[Query](./query) covers sorting, paging and counting, and [Query examples](./query-examples) lists the
operators.

### Update fields

A field written with `update()` keeps the last value written. Some fields should merge instead: `inc()`
makes a counter, so votes cast on two devices at the same time add up, and `add()` makes a set, so tags
added on two devices are all kept. You pick the behavior per field by the call that first writes it.

<<< @/examples/quickstart.mjs#update

[Fields that merge](./fields) explains each kind and when to use it.

### Watch a query

`watch()` calls your listener with the current rows right away and again whenever a write changes the
result, whether the write was made here or arrived from another node. Call the returned function to stop.

<<< @/examples/quickstart.mjs#observe

### Delete a task

<<< @/examples/quickstart.mjs#delete

A deleted record leaves a small marker behind so that the deletion reaches every other node;
[Cleanup](./cleanup) removes those markers once everyone has seen them.

### Sync with another node

Every write is also an operation in a log that other nodes replicate. To sync, one node hosts the sync
protocol and another dials it. syncom does not ship a network stack of its own: it plugs into
[wrpc](./replication-websocket), which you install next to it (`npm install @alexify/wrpc`).

The server mounts the database's sync unit on a wrpc router:

<<< @/examples/quickstart.mjs#host

The laptop dials the server, receives every task it has, and sends its own writes back:

<<< @/examples/quickstart.mjs#dial

The laptop keeps working when the connection drops. Its writes wait in its log, and when the link comes
back the two nodes exchange what the other is missing. When both edited the same task, each field
resolves the same way on both nodes, so they end up identical without asking you to resolve a conflict.
[Sync engine](./replication) explains how.

</div>

## Next steps

- [Database](./database): every option of `createDatabase()`, transactions and closing.
- [Fields that merge](./fields): registers, counters, sets, lists and text.
- [Sync engine](./replication): how nodes converge, and what happens offline.
- [Partial sync](./partial-sync): give each node only the records it may see.
- [Storage overview](./storage): IndexedDB, SQLite, MongoDB and memory.

## Coming from RxDB

The steps map one to one: a database, a collection, inserts, queries and live queries. The differences
show up in what you leave out. A collection needs no JSON schema and no primary key definition, there is
no `_rev` field and no conflict handler, and the second node does not need a server written against a
replication protocol: any syncom node can host one.

::: code-group

<<< @/examples/quickstart.mjs#collection [syncom]

<<< @/examples/rxdb/quickstart.mjs#collection [RxDB]

:::

<FromRxdb page="quickstart" :rows="['schemaless', 'primaryKey', 'conflictResolve', 'serverProduct']" />
