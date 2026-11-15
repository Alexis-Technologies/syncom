---
title: App state
description: Keep app settings and UI state by name and path with createState(), synced across a user's devices or kept on one device only.
---

# App state

Not everything an app remembers is a collection of records. The theme, the open filters, the width of a sidebar,
the last board a user looked at: these are a handful of values that belong to the app, not to a task. `createState()`
gives you one object per name that you read and write by path. By default it syncs to every node like a record;
with `{ local: true }` it stays on this device.

## Read and write by path

<<< @/examples/state.mjs#create

A path is segments joined by `/`. `set(path, value)` writes one value, `get(path)` reads it (`undefined` when
there is none), and `get()` without a path returns the whole state as an object. `set(object)` replaces the whole
state.

<<< @/examples/state.mjs#update

`set(path, fn)` computes the value from the current one inside a transaction, so two such updates made at once do
not lose each other. `delete(path)` removes a path, and `delete()` empties the whole state.

## React to changes

<<< @/examples/state.mjs#observe

`observe(path, listener)` calls the listener with the new value after every change of that path, whether the write
was made here or arrived from another device, and returns a function that stops it. `observe(listener)` watches
the whole state. For a UI framework, `toStore(state, path)` from `@alexify/syncom/store` wraps a path in a store
that Svelte, React's `useSyncExternalStore` and others read directly (see [Reactivity](./reactivity)).

## Sync it across devices

A state is the record `state.<name>`, readable with `db.get()` like any other:

<<< @/examples/state.mjs#record

Every path is a field of its own, so two devices that change different settings at the same time both keep their
change, and two that change the same path end up with the later write on both (see
[Transactions and conflicts](./transactions-conflicts)):

<<< @/examples/state.mjs#peers

The very first write makes the record with that one path, the way every later write changes one. Two devices
that create the same state at the same time, before either has synced the other's, keep both first writes, and a
new device that sets one setting before its first sync wipes none of the settings the others made long before.
`delete()` empties the state rather than leaving a [tombstone](./glossary#tombstone), so a setting made after it,
on any device, lands. Only `set(object)` writes the whole state at once, replacing what every device had set.

## Keep it on this device only

Some state should never leave the device: window sizes, a draft, which panel is collapsed. Pass `{ local: true }`:

<<< @/examples/state.mjs#local

A local state is a [local document](./local): stored next to the records, never written to the log, never synced,
and written whole on every `set`. It needs the `local` plugin, which `@alexify/syncom/all` includes.

## Limitations

- A state is one record, so it suits settings and small UI state. A list that grows with use (recent searches,
  notifications) belongs in a collection.
- Reads are asynchronous: `get()` reads from the database each time, with the record cache in front of it. Keep a
  value your UI reads on every frame in memory and update it from `observe()`.
- A synced state is visible to every node that syncs the record. Use [scopes](./partial-sync) to keep one user's
  state away from another's.

## Coming from RxDB

RxDB's RxState is the same idea: named state, written by path, persisted and observable. RxDB reads it at once from
memory and writes every change through a function; syncom reads asynchronously and takes a value or a function.
Concurrent changes merge per path in syncom; in RxDB they go through the collection's conflict handler.

::: code-group

<<< @/examples/state.mjs#create [syncom]

<<< @/examples/rxdb/state.mjs#create [RxDB]

:::

<FromRxdb page="rx-state" :rows="['rxState', 'localDocs']" />

Every member is in the [reference](../reference/api#state-subpath).
