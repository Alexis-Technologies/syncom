---
title: Faster open
description: Why syncom has no meta optimizer like RxDB's, what opening a database loads, which options make it faster, and how to measure an open.
---

# Faster open

<NotInSyncom page="rx-storage-localstorage-meta-optimizer" />

RxDB's meta optimizer keeps the small internal metadata RxDB reads to create a database and its collections in
localStorage, so that a browser app with many collections starts sooner. It is a wrapper around the real storage
and applies to browsers only.

## Why syncom does not do this

A syncom collection is a definition over one store, not a storage instance of its own, so there is no metadata per
collection to fetch at open. What an open loads is the database itself: the lock, the node's identity and keys, the
operation log the database retains (read whole), and the catalog of every record's id, collection and indexed
values. The catalog is saved at `close()` and every so often while the database runs; an open reads it back and
re-reads only the records the log changed since it was saved. When it cannot (a first open, an index set that
changed, a save older than what the log retains), it rebuilds the catalog by reading every record once. Moving a few
small keys to localStorage would change none of that.

## Make an open faster

Measure first. Time `createDatabase()` and give it a logger that keeps `debug` lines: `catalog.rebuild` says an open
read every record, and why.

<<< @/examples/open-cost.mjs#measure

- **Close the database.** `close()` saves the catalog for the next open. A node stopped without it catches up from
  the log as long as the last save is still in the retained log; `catalog.flushEvery` sets how often it saves
  meanwhile ([Database](./database)).
- **Keep the index set stable.** A new or dropped index rebuilds the catalog once, at the next open.
- **Retain the log you need.** An open reads the retained log whole; `sync.retention` keeps 10 000 ops by default
  ([Retention](./retention)).
- **Skip what a rebuild checks.** A rebuild verifies each record against the [chain](./chain) block that committed
  it; `integrity: 'lazy'` trusts the files instead, and `chain: false` keeps no chain at all.
- **Register only the plugins you use.** With `@alexify/syncom/all`, the first open of a path makes an RSA key pair
  for sealed records and an Ed25519 pair for signing ([Installation](./install#pick-only-the-plugins-you-need)).

With telemetry on, a rebuild is also a `syncom.catalog.rebuild` span carrying the number of records it read
([Telemetry](./telemetry)).

## Coming from RxDB

There is no per-collection setup to cache, and no browser-only wrapper to add: the open cost is the catalog and
the retained log, the same on every engine, and the options above are where you tune it.

<FromRxdb page="rx-storage-localstorage-meta-optimizer" :rows="['openCost', 'crashRecovery', 'collectionLimit']" />
