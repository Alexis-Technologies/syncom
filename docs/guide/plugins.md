---
title: Plugins
description: How syncom splits into a core and plugins, how to pick the plugins a database runs, and how to add methods of your own with a plugin.
---

# Plugins

The core of syncom keeps records whose fields are registers, counters and sets, the operation log, and the sync of
ops between nodes. Everything else is a plugin: the list, text and tree field kinds, queries, schemas, versions,
replication, signing, encryption and more. You choose the plugins when you open a database, and they apply to that
database alone. A plugin you do not import is not in your bundle.

## Pick the plugins a database runs

Import the core from `@alexify/syncom` and each plugin from its subpath, then pass them in `plugins`:

<<< @/examples/plugins.mjs#lean

`db.plugins` lists the plugins the database runs, in the order given, and `db.kinds` the ones among them that
bring field kinds. The order matters only where one plugin needs another: a plugin names those in `requires`, and
they must come before it.

## Start with everything

`@alexify/syncom/all` is the core with every plugin the package ships registered ahead of yours. It is the
easiest way to start, and what most examples in this guide use:

<<< @/examples/plugins.mjs#all

Two plugins are not in `/all` because they take options: `attachments({ compression })` from
`@alexify/syncom/attachments` ([Attachments](./attachments)), which you add to `plugins` yourself, and full-text
search, which is the `search` option of `createDatabase()` rather than a plugin ([Full-text search](./fulltext-search)).
[Installation](./install#pick-only-the-plugins-you-need) shows how much each choice weighs in a browser bundle.

| Plugin       | Import                       | What it adds                                                                                         |
| ------------ | ---------------------------- | ---------------------------------------------------------------------------------------------------- |
| `text`       | `@alexify/syncom/text`       | The [list](./lists) and [text](./text) field kinds, with marks and embeds                            |
| `tree`       | `@alexify/syncom/tree`       | The [tree](./trees) field kind                                                                       |
| `query`      | `@alexify/syncom/query`      | [Queries](./query): `select()`, `count()`, `watch()`                                                 |
| `schema`     | `@alexify/syncom/schema`     | The `schema` option: [collections](./collection), [validators](./schema-validation), schema versions |
| `versions`   | `@alexify/syncom/versions`   | [History, diffs and tags](./versions)                                                                |
| `sync`       | `@alexify/syncom/sync`       | [Replication](./replication): `db.sync`                                                              |
| `signing`    | `@alexify/syncom/signing`    | [Signed ops](./signing), the node id as a key                                                        |
| `chain`      | `@alexify/syncom/chain`      | The [hash chain](./chain) over record files                                                          |
| `encryption` | `@alexify/syncom/encryption` | [Encrypted records](./encryption)                                                                    |
| `telemetry`  | `@alexify/syncom/telemetry`  | [Spans and metrics](./telemetry) through OpenTelemetry                                               |
| `local`      | `@alexify/syncom/local`      | [Local documents](./local) that never replicate                                                      |

## Plugins belong to one database

Nothing is registered for the whole process. Two databases in one process can run different plugins, and a call
into a plugin the database was not opened with rejects with a `TypeError` whose `code` is `ALX_ERR_PLUGIN_MISSING` and
whose message names the import that fixes it:

<<< @/examples/plugins.mjs#per-instance

This is also why tests can open a lean database and a full one side by side, and why a library built on syncom can
open its own database without touching the application's.

## Kinds and features

There are two sorts of plugin, and they differ in how they affect sync.

A **kind plugin** (`text`, `tree`) brings field kinds: how their ops apply, how they merge and how they read. Every
node that should read those fields needs the plugin. A node without it still accepts a peer's op of that kind,
keeps it in its log and relays it to the peers behind it, so a hub does not have to run every kind its clients use;
it does not apply the op, and reports it on its `error` event as `ALX_ERR_OP_REFUSED` with `reason: 'kind'`. Once a
directory has run with a kind, opening it without that plugin is refused, and a node never joins a snapshot from a
host that lacks one of its kinds (`ALX_ERR_KINDS_MISMATCH`), since the snapshot would leave those fields out.

When two nodes write one field as different kinds at the same time, every node keeps the same one, decided by a fixed
order of the kinds: register, counter, set, then the plugins' kinds by their rank. `createPlugins()` builds the
registry a database builds from its plugins, which shows that order and checks a list of plugins without opening
anything:

<<< @/examples/plugins.mjs#registry

A **feature plugin** (everything else) adds methods and behavior over the core: `query` the cursor, `schema` the
validators, `sync` the sync manager, `signing` the node's key. A feature plugin does not change what an op means,
so nodes with different feature plugins still sync; each accepts what its own options allow (a node that requires
signatures refuses unsigned ops). What the options ask for is checked when the database opens: the `schema` option
without the `schema` plugin, `chain: true` without `chain`, or `sync.signatures: 'require'` without `signing` fails
`createDatabase()` with `ALX_ERR_PLUGIN_MISSING` rather than running without it.

## Add methods with a plugin of your own

A plugin is a plain object with a `name`. To add methods to a database, give it `methods` and a `setup` (which may
do nothing). Each method receives syncom's write core first and your arguments after it, and the database calls it
for you as `db.<name>(...)`, and as `tx.<name>(...)` inside a [transaction](./transactions-conflicts), where its
writes join the transaction:

<<< @/examples/plugins.mjs#own-methods

`core.commit(type, id, payload)` makes a write the way the database's own methods do, through hooks, validation and
the log; `'set'` with `{ data }` is what `update()` makes. The `core` is the seam syncom's own plugins are written
against. It is not yet a documented, stable API, so a plugin of yours should keep to `commit` and expect changes
before the first release. A method named like a member of the database (`insert`, `sync`) or `then` is refused when
the database opens.

A plugin that only needs to watch the database uses `open` instead, which syncom calls once the database is open,
with the database as `storage`. From there it uses the public API like any other code:

<<< @/examples/plugins.mjs#own-open

A plugin may also have `setup(ctx)`, which runs earlier, before the log opens. The shipped security plugins use it
to hand the core their hooks (the identity, the sealing of records, the chain); the reference lists what `ctx`
carries and the hooks the core reads ([Plugins](../reference/api#plugins)). An application cannot add a new hook
there, and it cannot add a field kind of its own either: a kind's ops must use the op types of the sync protocol,
and the shipped `text` and `tree` plugins claim all of the types a new kind could use.

In TypeScript, `Plugin<Api>` types the methods a plugin adds to the database, so that `createDatabase()` with it
returns a database that has them. Declare your plugin's type next to it:

```ts
import type { Plugin } from '@alexify/syncom';

export declare const archive: Plugin<{ archive(id: string): Promise<void> }>;
```

## Third-party plugins

There is no list of community plugins yet: syncom has not had its first release and is not on npm. If you write a
plugin worth sharing, publish it as a package that exports the plugin object, or a function that makes one when the
plugin takes options (as `attachments({ compression })` does). Declare `@alexify/syncom` as a peer dependency so
the application's copy is the one your plugin runs against, and keep your own runtime dependencies to none if you
can: syncom has none, and its users may count on that. Keep to the public API and `core.commit`, and say which
version of syncom you tested with, since the `core` may change before the first release.

<FromRxdb page="third-party-plugins" :rows="['thirdPartyPlugins', 'community']" />

## Coming from RxDB

An RxDB plugin is added once with `addRxPlugin()` and patches the prototypes of every database and collection in
the process; it cannot be removed. A syncom plugin is given to one `createDatabase()` call and adds methods to that
database alone, called with the write core rather than with `this`. RxDB lets a plugin hook into many internal
steps; syncom offers a plugin `setup`, `open` and methods, and keeps write interception in
[hooks](./hooks), which the application configures.

::: code-group

<<< @/examples/plugins.mjs#own-methods [syncom]

<<< @/examples/rxdb/plugins.mjs#own-methods [RxDB]

:::

<FromRxdb page="plugins" :rows="['plugins', 'size']" />

The registry and the plugin contract in full: [Plugins](../reference/api#plugins) in the API reference.
