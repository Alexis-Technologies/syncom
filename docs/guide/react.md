---
title: React
description: Show live syncom queries and records in React components with useSyncExternalStore over a store, with no adapter package and no provider to set up.
---

# React

React reads outside data through `useSyncExternalStore(subscribe, getSnapshot)`, and a syncom
[store](./reactivity) has exactly those two members. A component can therefore show a live query or a
live record with React's own hook: no adapter package, no provider, nothing to install beside syncom.
This page builds a task list that updates as tasks change, here or on another node.

The components on this page call `createElement` (imported as `h`) so they run without a build step. In
JSX, `h('li', { key: row.id }, row.title)` is `<li key={row.id}>{row.title}</li>`.

## Make the stores once

Open the database and make the stores in a module of their own, so every component shares them:

<<< @/examples/react.mjs#board

React calls `subscribe` again whenever it receives a new function, so a store must keep its identity
across renders. A store made at module level does. `initial: []` lets the list render empty before the
query answers, instead of `undefined`.

## Show a live list of tasks

<<< @/examples/react-tasks.mjs#component

The component renders the rows the store holds and renders again when they change. `getSnapshot()`
returns the same array until a write changes the result, so React skips the render when a write leaves
the rows as they were (a field set to the value it already held, a task of another query). The checkbox
writes through the database; the store hears the change and the list follows, and a change replicated
from another node reaches it the same way.

The store runs its query only while a component is subscribed. When the last component that reads it
unmounts, the query stops; the next one to mount gets the last rows at once while the query starts again.

## Pick the query from props

When the query depends on props or state, make the store inside the component with `useMemo`, keyed by
the arguments:

<<< @/examples/react-tasks.mjs#hook

`useMemo` makes a new store only when `done` changes, so `subscribe` keeps its identity between renders.
The third argument of `useSyncExternalStore` is the snapshot to use while rendering on the server; the
store's `getSnapshot` answers its `initial` value there.

## Show one record

`toStore(db, id)` follows one record as `get()` reads it. Wrap it in a function in the same module:

<<< @/examples/react.mjs#record

and read it in a component:

<<< @/examples/react-tasks.mjs#task

The value is `undefined` until the first read answers and `null` once the record is deleted, so the
component can tell "loading" from "gone". `toStore(db, id, { path: 'title' })` follows one field instead.

## Limitations

syncom ships no React package, so there is no provider, no context and no Suspense integration: pass the
database through a module, as above, or through a context of your own. A store made during render without
`useMemo` is a new store every render, which makes React subscribe again each time; keep every store at
module level or memoized. A store renders whole rows, so a component that needs one field of many records
should select that field with a [projection](./query) rather than read whole records.

## Coming from RxDB

RxDB ships `rxdb/plugins/react` with a database provider and hooks such as `useRxQuery`,
`useLiveRxQuery` and `useRxDocument`. syncom has no React-specific API: React's own
`useSyncExternalStore` reads a syncom store, and the same store serves Svelte, Vue, Solid and Angular
([Other frameworks](./frameworks)). What RxDB's hooks give you on top is the provider and a loading flag
per query; with syncom the loading state is the store's `initial` value or `undefined`.

<FromRxdb page="react" :rows="['react', 'reactivityPrimitive', 'documentObservable']" />

The store and its sources: [Reactivity](./reactivity) and the [API reference](../reference/api#store-subpath).
