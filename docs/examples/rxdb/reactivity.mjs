// RxDB's side of the "Coming from RxDB" code group of docs/guide/reactivity.md, run by
// `pnpm docs:examples:rxdb` against the rxdb of bench/compare.
import assert from 'node:assert/strict';
import { createRxDatabase } from 'rxdb';
import { getRxStorageMemory } from 'rxdb/plugins/storage-memory';

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

// #region signal
// A reactivity factory turns every observable RxDB hands out into your library's type (here a minimal box).
const reactivity = {
  fromObservable(observable, initialValue) {
    const box = { value: initialValue };
    observable.subscribe((next) => (box.value = next));
    return box;
  },
};
const board = await createRxDatabase({ name: 'board', storage: getRxStorageMemory(), reactivity });
// #endregion signal
await board.addCollections({
  tasks: {
    schema: {
      version: 0,
      primaryKey: 'id',
      type: 'object',
      properties: { id: { type: 'string', maxLength: 100 }, title: { type: 'string' }, done: { type: 'boolean' } },
      required: ['id'],
    },
  },
});
await board.tasks.insert({ id: 'write-docs', title: 'Write the docs', done: false });

const seen = [];
// #region observable
const subscription = board.tasks
  .find({ selector: { done: false }, sort: [{ title: 'asc' }] })
  .$.subscribe((docs) => console.log(docs.map((doc) => doc.title))); // the result now, then after every change
await board.tasks.insert({ id: 'ship-it', title: 'Ship it', done: false });
// #endregion observable
const check = board.tasks.find({ selector: { done: false } }).$.subscribe((docs) => seen.push(docs.length));
await tick();
assert.equal(seen.at(-1), 2);
check.unsubscribe();
subscription.unsubscribe();

const open = board.tasks.find({ selector: { done: false } }).$$;
await tick();
assert.equal(open.value.length, 2);
await board.close();
