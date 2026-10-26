# Frameworks

`@alexify/syncom/store` turns a source of syncom's into one store object
that a UI framework reads: a query, a live record, a record as `get()`
reads it, a presence room, or anything that emits. It imports no
framework. The object keeps two contracts at once, so React and Svelte
take it as it is, and Vue and Solid wrap it in a line.

```js
const { open } = require('@alexify/syncom/all');
const { toStore } = require('@alexify/syncom/store');

const storage = await open({ path: 'data', schema: { entities: { Task: { index: ['done'] } } } });
const tasks = toStore(storage.Task.select({ done: false }).order('title'));
```

## The store

| Member | What it is |
| --- | --- |
| `subscribe(run)` | Calls `run(value)` at once and on every change; returns the function that stops it — Svelte's store contract |
| `getSnapshot()` | The value now; the same object until the source changes — what React's `useSyncExternalStore` compares |
| `value` | The same as `getSnapshot()` |
| `error` | The source's last failure, cleared by its next value |
| `ready` | Resolves with the first value the source gives |

The source is watched from the first subscriber to the last: a query
re-runs, a record is observed, a room is listened to only while something
shows it. A store with no subscriber answers the last value it saw.
`toStore(source, { initial, onError })` sets what the store holds before
the source gave anything (`undefined` by default) and hears a failure — a
filter that threw, a read that rejected; the value stays as it was.

## Sources

| Source | The value |
| --- | --- |
| `toStore(cursor)` | The query's rows, as `watch()` gives them — the query runs again after every change to its collection, coalesced |
| `toStore(record)` | A live `Record`'s data, a new copy per change; `null` once deleted |
| `toStore(storage, id)` | The record as `get()` reads it — the lens and the read hooks applied — read again after every turn that changed it |
| `toStore(storage, id, { path: 'profile/city' })` | One field of it; a write to the field, under it or above it reads it again |
| `toStore(presence)` | A [presence](./presence) room's states, a `Map` by node |
| `fromEvents(emitter, events, read)` | `read()` — a value or a promise of one — at the start and after each of `events` |

`fromEvents` covers what has no source of its own. The sync manager's
peers, say:

```js
const { fromEvents } = require('@alexify/syncom/store');

const peers = fromEvents(storage.sync, ['peer', 'sync'], () => storage.sync.peers());
```

When two reads race, the newest wins, and a read that resolves after the
last subscriber left is dropped.

## React

```jsx
import { useSyncExternalStore } from 'react';

function Tasks() {
  const rows = useSyncExternalStore(tasks.subscribe, tasks.getSnapshot) ?? [];
  return rows.map((row) => <li key={row.id}>{row.title}</li>);
}
```

Make the store once — at module level, or with `useMemo` over the query's
arguments — so `subscribe` keeps its identity across renders. The snapshot
is a new array only when the rows changed, which is what
`useSyncExternalStore` needs to skip a render.

## Svelte

A store is a Svelte store; `$tasks` subscribes and unsubscribes with the
component:

```svelte
<script>
  export let tasks;
</script>

{#each $tasks ?? [] as row (row.id)}
  <li>{row.title}</li>
{/each}
```

## Vue

```js
import { shallowRef, onScopeDispose } from 'vue';

const useStore = (store) => {
  const value = shallowRef(store.getSnapshot());
  onScopeDispose(store.subscribe((next) => (value.value = next)));
  return value;
};

// in setup():
const rows = useStore(tasks);
```

`shallowRef` because the value is replaced whole on every change, never
edited in place.

## Solid

```js
import { from } from 'solid-js';

const rows = from(tasks);
```

`from` takes anything with a `subscribe` that returns the stop function.

## Checked how

The two contracts are checked by `tests/store.test.js`: a subscriber is
called at once and on every change, a snapshot keeps its identity between
changes, the source is watched only while subscribed, as React and Svelte
read them. The Vue recipe above was run against Vue 3.5's reactivity
(`effectScope`, `watchEffect`). React, Svelte and Solid are not
dependencies of this repository, so their recipes follow each framework's
documented store contract and were not run here.
