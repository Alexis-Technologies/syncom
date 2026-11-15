// docs-examples: browser-only (Vue, Solid and Preact are not dependencies of this repository; reactivity.mjs runs the store contract they read)
// The Other frameworks page (docs/guide/frameworks.md) shows the regions of this file. `openTasks` is the store of
// docs/examples/react.mjs's board.js: toStore(board.Task.select({ done: false }).order('title'), { initial: [] }).
import { openTasks } from './board.js';

// #region vue
import { shallowRef, onScopeDispose } from 'vue';

// A ref that follows a store for as long as the component (or effect scope) that called it lives.
export const useStore = (store) => {
  const value = shallowRef(store.getSnapshot());
  onScopeDispose(store.subscribe((next) => (value.value = next)));
  return value;
};

// in a component's setup():
//   const rows = useStore(openTasks);
// #endregion vue

// #region solid
import { from } from 'solid-js';

// Inside a component or a root: the signal follows the store and lets it go on cleanup.
export const useOpenTasks = () => from(openTasks);
// #endregion solid

// #region preact
import { signal } from '@preact/signals-core';

export const rows = signal(openTasks.value);
export const stopRows = openTasks.subscribe((value) => (rows.value = value)); // call stopRows() to let go
// #endregion preact
