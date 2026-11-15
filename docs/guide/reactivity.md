---
title: Reactivity
description: Turn queries, records and events into stores that UI frameworks and signal libraries read, through one small contract with no framework inside.
---

# Reactivity

A user interface shows data that changes: the open tasks, the title of the task being edited, the peers
that are online. `@alexify/syncom/store` turns each of these into a **store**, one small object that most
UI frameworks read as it is and the rest wrap in a line. The subpath imports no framework and adds no
dependency.

## Turn a query into a store

Pass a query to `toStore()` and subscribe:

<<< @/examples/reactivity.mjs#to-store

`subscribe(run)` calls `run` at once with the value the store holds and again after every change, and
returns the function that stops it. Until the query has answered for the first time the value is
`undefined`, which is why the listener above says "loading" first. The rows are what
[`watch()`](./query) gives: the query is kept up to date as records change, whether the change was made
here or arrived from another node.

A store runs its source only while something is subscribed. The first subscriber starts the query and the
last one to leave stops it. A store with no subscriber keeps answering the last value it saw, and the
next subscriber gets that value at once while the query starts again.

## Read the current value

<<< @/examples/reactivity.mjs#snapshot

`getSnapshot()` returns the same object until the source changes, so a framework can tell "nothing
changed" by comparing references. That is the contract React's `useSyncExternalStore` needs
([React](./react) shows it). `value` is the same snapshot as a property, and `error` holds the source's
last failure (a query that threw, a read that rejected) until the next value clears it. To hear failures
as they happen, pass `onError` in the options.

## Wait for the first value

<<< @/examples/reactivity.mjs#ready

`initial` sets what the store holds before the source answers, so a list can start empty instead of
`undefined`. `ready` is a promise of the first value the source gives, which helps in tests and in code
that renders on the server once.

## Follow one record or one field

`toStore()` takes more than queries. Given the database and an id it reads the record as `get()` does,
with your [read hooks](./hooks#shape-what-get-returns) and the schema's lens applied, and reads it again
after every change; a `path` narrows it to one field. Given a live [document](./document) it hands out a
new copy of the document's data on every change, and `null` once the record is deleted:

<<< @/examples/reactivity.mjs#record

The same call accepts a few other sources. `toStore(db.local, key)` follows a
[local document](./local), `toStore(state, path)` a value of [app state](./state), and `toStore(presence)`
the states of a [presence](./presence) room as a `Map` by node.

## Make a store from any emitter

For anything else that emits events, `fromEvents()` builds a store from an emitter, the events that mean
"read again", and a function that reads the value (or a promise of it):

<<< @/examples/reactivity.mjs#from-events

When two reads overlap, the newer one wins, and a read that resolves after the last subscriber left is
dropped.

## Hand a store to RxJS or Angular

`toObservable()` wraps a store in an interop Observable, the shape RxJS's `from()`, Angular's `async` pipe
and `toSignal()` accept:

<<< @/examples/reactivity.mjs#observable

The observable emits the store's value at once and then one value per change. It never errors and never
completes, because the source is live and a failure stays on `store.error`. `unsubscribe()` leaves the
store, and the store lets its source go once its last subscriber has left.

## Use signals and other reactive libraries

Any library that can set a value from a callback can follow a store: create its reactive value from
`store.value`, set it inside `subscribe()`, and call the function `subscribe()` returned when the
component goes away. [Other frameworks](./frameworks) has that recipe for Preact signals, Vue, Solid,
Svelte and Angular, and [React](./react) covers `useSyncExternalStore`.

## The store contract

If you write an adapter of your own, these are the guarantees a store keeps:

- `subscribe(run)` calls `run(value)` at once and after every change, and returns a function that stops
  it. This is Svelte's store contract as written.
- `getSnapshot()` returns the same object until the value changes. This is what React compares.
- `value` is the snapshot, `error` the last failure or `null`, and `ready` a promise of the first value.
- The source runs from the first subscriber to the last; without subscribers the store answers the last
  value it saw.

## Coming from RxDB

RxDB hands out RxJS Observables everywhere (the `$` properties), and its `reactivity` option turns them
into your library's type (the `$$` properties). syncom's core reports changes through callbacks (`watch()`,
`observe()`, `on()`), and `/store` wraps any of them in one store type, without RxJS. When a library wants
an Observable, `toObservable()` gives it one.

::: code-group

<<< @/examples/reactivity.mjs#to-store [syncom]

<<< @/examples/rxdb/reactivity.mjs#observable [RxDB]

:::

<FromRxdb page="reactivity" :rows="['reactivityPrimitive', 'signals', 'documentObservable']" />

Every source `toStore()` accepts and its options: [API reference](../reference/api#store-subpath).
