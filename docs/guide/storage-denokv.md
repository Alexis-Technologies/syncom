---
title: DenoKV
description: Why syncom ships no Deno KV storage, what runs under Deno today, and how an engine of your own over Deno KV would plug in.
---

# DenoKV

<NotInSyncom page="rx-storage-denokv" />

RxDB's DenoKV storage keeps a database in Deno's built-in key-value store, the one Deno Deploy also offers as a
hosted service, so an RxDB app on Deno persists without a file system.

## Why syncom does not have it

syncom ships the storages its tests cover on the platforms it targets, Node.js and browsers. Deno runs the
package (CI opens a database there over the [memory engine](./storage-memory) and syncs two nodes), but no
engine of the package is built on a Deno-only API, and none has been run against Deno KV.

## Get the same result

An engine is a contract any store with keys, values and transactions can meet: small texts by namespace and
key, records by id, the op log's medium, and one write set at a time, landed whole where the store has atomic
commits (Deno KV's `atomic()` does). [Engines and backends](../reference/engines) specifies it, and
`tests/suites/engine.js` in the repository is the test an engine of your own must pass. Until then, a Deno
process can keep its database in memory and [replicate](./replication) it to a node with durable storage.

<<< @/examples/storage-memory.mjs#engine

## Coming from RxDB

An RxDB app on Deno that used DenoKV for persistence needs a durable node elsewhere, or an engine of your own,
before it moves to syncom.

<FromRxdb page="rx-storage-denokv" :rows="['denokv', 'deno', 'customBackend']" />
