---
title: FoundationDB
description: Why syncom ships no FoundationDB storage, which engine covers a server today, and what an engine of your own over FoundationDB would implement.
---

# FoundationDB

<NotInSyncom page="rx-storage-foundationdb" />

RxDB's FoundationDB storage keeps a database in a FoundationDB cluster, a distributed, transactional key-value
store, through its native Node.js client.

## Why syncom does not have it

syncom ships the engines its test suite runs against. An engine over FoundationDB could take the native client
from your application, the way the MongoDB engine takes the driver, but no FoundationDB cluster runs in the
package's tests, so none ships. A server that needs a shared, transactional store has the
[MongoDB engine](./storage-mongodb), which takes the driver your application already uses and keeps one writer
per database with a lease.

## Get the same result

For a server today, open the database over MongoDB or [SQLite](./storage-sqlite). For FoundationDB itself, an
engine of your own implements the contract: small texts by namespace and key, records by id, the op log's
medium, and write sets landed whole in one transaction (`capabilities.atomicBatch`). Where instances on several
machines share the cluster, it would hold each database with a lease of its own (`capabilities.lock: 'native'`),
as the MongoDB engine does. [Engines and backends](../reference/engines) specifies every store, and `tests/suites/engine.js` in the
repository is the test it must pass.

<<< @/examples/storage.mjs#wrap

The example above wraps an engine that exists; a FoundationDB engine would implement the same `open()` and
`write()` over the cluster.

## Coming from RxDB

Moving off RxDB's FoundationDB storage means choosing MongoDB or SQLite for the server, or writing the engine.

<FromRxdb page="rx-storage-foundationdb" :rows="['foundationdb', 'mongodbStorage', 'customBackend']" />
