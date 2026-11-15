// The React page (docs/guide/react.md) shows the regions of this file and of react-tasks.mjs. React is not a
// dependency of this repository, so this file runs the store half: it drives the store the way React's
// useSyncExternalStore does (subscribe, then getSnapshot compared with Object.is) and checks what the page says.
// tests/package/docs-examples.test.js runs it from an empty temporary directory.
import assert from 'node:assert/strict';

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

// #region board
// board.js: the database and the stores, made once when the module loads
import { createDatabase } from '@alexify/syncom/all';
import { toStore } from '@alexify/syncom/store';

export const board = await createDatabase({
  path: 'board',
  schema: { entities: { Task: { index: ['done'] } } },
});

export const openTasks = toStore(board.Task.select({ done: false }).order('title'), { initial: [] });
// #endregion board

// What useSyncExternalStore(openTasks.subscribe, openTasks.getSnapshot) does: subscribe once, and on every
// notification read the snapshot again and render only when it is another object.
let rendered = openTasks.getSnapshot();
const renders = [rendered];
const unsubscribe = openTasks.subscribe(() => {
  const next = openTasks.getSnapshot();
  if (!Object.is(next, rendered)) {
    rendered = next;
    renders.push(next);
  }
});
assert.deepEqual(rendered, [], 'the initial value renders first');

const first = await board.Task.insert({ title: 'Write the docs', done: false });
await board.Task.insert({ title: 'Ship it', done: false });
await tick();
assert.deepEqual(
  rendered.map((row) => row.title),
  ['Ship it', 'Write the docs'],
);
const before = renders.length;

// A write that leaves the rows as they read changes nothing: no new snapshot, no render.
await board.Task.update(first.id, { done: false });
await tick();
assert.equal(renders.length, before);
assert.equal(openTasks.getSnapshot(), rendered);

// #region toggle
// In a click handler: write, and every component that reads the query renders again.
await board.Task.update(first.id, { done: true });
// #endregion toggle
await tick();
assert.equal(renders.length, before + 1);
assert.deepEqual(
  rendered.map((row) => row.title),
  ['Ship it'],
);

// #region record
// One record, as get() reads it; null once it is deleted.
export const taskStore = (id) => toStore(board, id);
// #endregion record
const one = taskStore(first.id);
const stopOne = one.subscribe(() => {});
assert.equal((await one.ready).title, 'Write the docs');
stopOne();

unsubscribe();
await board.close();
