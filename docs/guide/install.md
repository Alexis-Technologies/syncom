---
title: Installation
description: Install syncom, check the Node.js and browser requirements, import only the plugins you use, and load it from ESM, CommonJS or a bundler.
---

# Installation

syncom is one package with no runtime dependencies. It runs on Node.js 24 or newer and in current
browsers, ships its own TypeScript types, and needs no build step, polyfill or bundler plugin. This page
covers getting it into a project and choosing how much of it to load; the [Quickstart](./quickstart)
builds a first app.

## Install the package

syncom is a pre-release (`0.0.1`) and is not on npm yet. Until the first release, depend on the
repository: a git dependency, or a workspace link if you keep it next to your app. Once it is published:

```bash
npm install @alexify/syncom
```

Replication runs over [wrpc](./replication-websocket), which you install beside it when you sync
[nodes](./glossary#node) (databases on different devices) over the network. syncom never requires it:
you hand the client to syncom yourself.

```bash
npm install @alexify/wrpc
```

## Check the requirements

On the server syncom needs **Node.js 24 or newer** (the `engines` field of its `package.json`). It
stores data with `node:fs` and hashes and signs with `node:crypto`, so there is nothing native to compile.
Deno and Bun run a smoke test in CI (a database in memory, two nodes syncing in-process), but the test
suite itself runs under Node.js only.

In the browser it needs a **secure context** (HTTPS or `localhost`) and two platform APIs:

- the [Origin Private File System](./storage-opfs), where a database lives by default. Where you would
  rather not use it, the [IndexedDB engine](./storage-indexeddb) or the [memory engine](./storage-memory)
  takes its place;
- Web Crypto: SHA-256 for the core, Ed25519 for the `signing` plugin, and RSA-OAEP with AES-GCM for the
  `encryption` plugin.

Current Chrome, Edge, Firefox and Safari have both. The SQLite and MongoDB engines are Node.js only, and
the IndexedDB one is browser only.

## Pick only the plugins you need

The easiest start is `@alexify/syncom/all`: the core with every plugin the package ships, already
registered.

<<< @/examples/install-all.mjs#all

Everything beyond the core is a plugin, and a plugin works only on the database you open with it. The
core alone keeps records with [registers, counters and sets](./fields), the
[operation log](./operation-log), transactions and the explicit API by id. A local-first app that wants
collections and queries adds two plugins:

<<< @/examples/install-lean.mjs#lean

`db.Task.insert()` resolves to a [document](./document) of the new record, an object that carries its
`id`; the database's own `db.insert()`, which the CommonJS example below uses, resolves to the id alone.

Nothing is registered for the whole process: two databases in one process can run with different
plugins. Calling a method whose plugin the database was not opened with rejects with a `TypeError` whose
`code` is `PLUGIN_MISSING`, and the message names the subpath to import:

<<< @/examples/install-lean.mjs#missing

Add the plugin and open the database again. The data is untouched, because a plugin changes what the
database can do, not what it stored:

<<< @/examples/install-lean.mjs#add-text

These are the plugins `/all` registers, and what each one adds:

| Plugin | Import it from | What it adds |
| --- | --- | --- |
| `schema` | `@alexify/syncom/schema` | Collections, validation, indexes and schema versions ([Schema](./schema)) |
| `query` | `@alexify/syncom/query` | `select()`, `count()` and live queries on a collection ([Query](./query)) |
| `sync` | `@alexify/syncom/sync` | Replication with other nodes ([Sync engine](./replication)); to dial over wrpc, add `createWrpcLink` from `@alexify/syncom/wrpc` ([below](#sync-a-lean-database)) |
| `text` | `@alexify/syncom/text` | List and text fields ([Lists](./lists), [Text](./text)) |
| `tree` | `@alexify/syncom/tree` | Tree fields ([Trees](./trees)) |
| `versions` | `@alexify/syncom/versions` | A record's past, tags, diff and restore ([Versions](./versions)) |
| `local` | `@alexify/syncom/local` | Local documents that never replicate ([Local documents](./local)) |
| `telemetry` | `@alexify/syncom/telemetry` | OpenTelemetry spans and metrics ([Telemetry](./telemetry)) |
| `signing` | `@alexify/syncom/signing` | An Ed25519 node identity and signed operations ([Signing](./signing)) |
| `chain` | `@alexify/syncom/chain` | A hash-linked chain of every write ([Audit chain](./chain)) |
| `encryption` | `@alexify/syncom/encryption` | Records sealed for this node, and `atRest()` to encrypt a whole database ([Encryption](./encryption)) |

The last three change what opening costs. With `signing` and `encryption` a new database generates two
key pairs on its first open, and with `chain` every write also adds a block. The core alone has none of
that: its node id is a UUID, and its [ops](./glossary#op) go out unsigned. Leave those plugins out when
you do not need them, or keep `/all` and pass `chain: false` to skip the chain alone.

The other subpaths are not plugins. Storage engines (`/memory`, `/idb`, `/sqlite`, `/mongodb`) go in the
`engine` option, `/wrpc` makes the link replication runs over, and tools such as `/dump`, `/pipeline`,
`/connector` or `/undo` are functions you call with a database. [Entry points](../reference/entry-points)
lists every subpath, and [Plugins](./plugins) explains how a plugin hooks into the core.

## Sync a lean database

A lean database syncs once it has the `sync` plugin and a `connect` function. `connect` returns the link
to another node, and `createWrpcLink()` from `@alexify/syncom/wrpc` makes one from a wrpc client. That
subpath is not a plugin, so it stays out of `plugins`:

<<< @/examples/install-sync.mjs#sync

The node it dials is a server like the one the [Quickstart](./quickstart#sync-with-another-node) hosts,
which needs the `sync` plugin too for `db.sync.unit()`. Give every node the plugins of the field kinds
your app writes: a node without `text` keeps a peer's list and text ops in its log and passes them on,
but does not apply them.

## Use it from ESM or CommonJS

The package is CommonJS with no build step, and every entry spells its exports so that Node.js hands an
ES module importer the same names. Both styles work without a bundler:

```js
import { createDatabase } from '@alexify/syncom';
```

<<< @/examples/install-cjs.js#cjs

## Bundle it for the browser

A bundler that follows `package.json` `exports` (Vite, esbuild, webpack, Rollup) picks the browser build
through the `browser` condition, with no configuration. The browser build swaps a few modules for their
browser twins: the file backend becomes OPFS, ids come from `crypto.randomUUID()`, and hashing, signing
and sealing go through Web Crypto. Everything else, from the operation log to replication, is the same code
on both platforms.

One consequence of Web Crypto shows in your code: the hashing, signing and encryption functions that
`@alexify/syncom/signing` and `@alexify/syncom/encryption` export return promises in the browser, where they
return values in Node.js. Their browser types say so.

Every entry is measured on each CI run against a size budget, and the build fails when one grows past
it. Today the core is about 78 KB minified and gzipped, and `/all` about 182 KB; what you import is what
you ship, and a block shares the core modules it stands on, so the numbers do not add up. The same check
fails on any bare import that reaches a browser bundle, so syncom cannot pick up a dependency unnoticed.

## Coming from RxDB

There is no peer dependency to install, no polyfill for `global` and no RxJS. Plugins are not added to
the whole process with `addRxPlugin()`: each database lists the plugins it runs with, so a test can open
a lean database next to a full one.

::: code-group

<<< @/examples/install-lean.mjs#lean [syncom]

<<< @/examples/rxdb/install.mjs#plugins [RxDB]

:::

<FromRxdb page="install" :rows="['deps', 'entryPoints', 'plugins', 'node', 'browserReq', 'sizeGate']" />
