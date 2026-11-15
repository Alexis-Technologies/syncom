---
title: Other frameworks
description: Read live syncom queries and records from Vue, Svelte, Solid, Angular and Preact signals, each through the same store in a line or two of code.
---

# Other frameworks

A syncom [store](./reactivity) keeps two contracts at once: Svelte's store contract and the
`subscribe`/`getSnapshot` pair [React](./react) reads. Svelte takes a store as it is, and every other
framework wraps it in a line or two. The recipes below all read one store, the open tasks of the board:

<<< @/examples/react.mjs#board

Make stores once, at module level or memoized per set of arguments, so a framework never subscribes to a
new store on every render. Each recipe below lets go of the store when the component goes away, and the
store stops its query when its last subscriber has left.

## Vue

<<< @/examples/frameworks.mjs#vue

`useStore()` returns a ref that follows the store while the component lives: `onScopeDispose` stops the
subscription when the component unmounts (or when the effect scope that called it stops). The ref is a
`shallowRef` because the store replaces its value whole on every change and never edits it in place, so
Vue has no reason to make the rows deeply reactive.

## Svelte

A store is a Svelte store, so `$openTasks` in a component subscribes when the component mounts and
unsubscribes when it is destroyed:

<<< @/examples/frameworks-svelte.svelte

`derived()` and `get()` of `svelte/store` take it as well, since they accept any object with a
`subscribe` that returns a stop function.

## Solid

<<< @/examples/frameworks.mjs#solid

Solid's `from()` takes anything with a `subscribe` method that returns the stop function, and turns it
into a signal. Call it inside a component or a root so its cleanup runs.

## Angular

Angular reads Observables, so hand it one with `toObservable()`:

<<< @/examples/frameworks-angular.ts

`toSignal()` subscribes once and unsubscribes when the component is destroyed. `requireSync: true` is
safe because the observable emits the store's value at once on subscribe. In a template you can also
write `toObservable(openTasks)` into a field and read it with the `async` pipe. The observable never
errors or completes; a failure of the query stays on `openTasks.error`.

## Preact signals

<<< @/examples/frameworks.mjs#preact

A signal set from the store follows it until you call the function `subscribe()` returned. The same
three steps fit any signal library (MobX, Vue's `ref` outside a component, a state manager of your own):
create the reactive value from `store.value`, set it in `subscribe()`, and keep the stop function for
when the value is no longer needed.

## What these recipes rely on

Each recipe uses only the store contract: `subscribe(run)` calls `run` at once and on every change and
returns the stop function, `getSnapshot()` and `value` return the same object until the value changes,
and the source runs from the first subscriber to the last. syncom does not install or import any of these
frameworks, so check the recipe against the version you use; the contract itself is described on
[Reactivity](./reactivity#the-store-contract).
