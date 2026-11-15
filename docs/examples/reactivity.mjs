// The Reactivity page (docs/guide/reactivity.md) shows the regions of this file.
// tests/package/docs-examples.test.js runs it from an empty temporary directory.
import assert from 'node:assert/strict';
import { createDatabase } from '@alexify/syncom/all';

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));
const board = await createDatabase({ path: 'board', schema: { entities: { Task: { index: ['done'] } } } });
await board.Task.insert({ title: 'Write the docs', done: false });

// #region to-store
import { toStore } from '@alexify/syncom/store';

const tasks = toStore(board.Task.select({ done: false }).order('title'));

const stop = tasks.subscribe((rows) => {
  console.log(rows === undefined ? 'loading' : rows.map((row) => row.title));
});
// loading                       (at once: the query has not answered yet)
// [ 'Write the docs' ]          (the first answer)
await board.Task.insert({ title: 'Ship it', done: false });
// [ 'Ship it', 'Write the docs' ]
stop(); // the last subscriber gone, the query stops running
// #endregion to-store
const seen = [];
const stopSeen = tasks.subscribe((rows) => seen.push(rows?.length));
await tick();
assert.equal(seen[0], 2, 'a subscriber after the first one gets the last value at once');
await board.Task.insert({ title: 'Answer issues', done: false });
await tick();
assert.equal(seen.at(-1), 3);
stopSeen();

// #region snapshot
const first = tasks.getSnapshot();
console.log(first === tasks.getSnapshot()); // true: the same array until the rows change
console.log(tasks.value === first); // true: `value` is the snapshot too
// #endregion snapshot
assert.equal(first, tasks.getSnapshot());
assert.equal(tasks.value, first);
assert.equal(tasks.error, null);

// #region ready
const loaded = toStore(board.Task.select({ done: false }), { initial: [] });
const unsubscribe = loaded.subscribe(() => {});
console.log(loaded.value); // []: the initial value, until the query answers
console.log((await loaded.ready).length); // 3
unsubscribe();
// #endregion ready
assert.equal((await loaded.ready).length, 3);

// #region record
const task = await board.Task.insert({ title: 'Review the guide', done: false });
const title = toStore(board, task.id, { path: 'title' }); // one field, as get() reads it
const document = toStore(task); // a live document's data, a new copy per change

const stopTitle = title.subscribe((value) => console.log('title:', value));
// title: undefined          (at once: the first read has not answered yet)
// title: Review the guide
await board.Task.update(task.id, { title: 'Review the whole guide' });
// title: Review the whole guide
// #endregion record
await tick();
stopTitle();
const titles = [];
const stopTitles = title.subscribe((value) => titles.push(value));
await tick();
await board.Task.update(task.id, { title: 'Review it all' });
await tick();
assert.deepEqual(titles.slice(-2), ['Review the whole guide', 'Review it all']);
stopTitles();
const copies = [];
const stopCopies = document.subscribe((data) => copies.push(data));
await tick();
await board.Task.update(task.id, { done: true });
await tick();
assert.equal(copies.at(-1).done, true);
assert.notEqual(copies.at(-1), copies.at(-2));
stopCopies();

// #region from-events
import { fromEvents } from '@alexify/syncom/store';

// The sync manager's peers, read again whenever a link comes, goes or syncs.
const peers = fromEvents(board.sync, ['peer', 'sync'], () => board.sync.peers());
// #endregion from-events
const peerValues = [];
const stopPeers = peers.subscribe((value) => peerValues.push(value));
await tick();
assert.deepEqual(peerValues.at(-1), []);
stopPeers();

// #region observable
import { toObservable } from '@alexify/syncom/store';

const subscription = toObservable(tasks).subscribe({
  next: (rows) => console.log('next:', rows?.length),
});
// next: 3   (the store's value at once, then one per change)
subscription.unsubscribe();
// #endregion observable
const nexts = [];
const sub = toObservable(tasks).subscribe((rows) => nexts.push(rows?.length));
await tick();
assert.equal(nexts.at(-1), 3);
sub.unsubscribe();
assert.equal(sub.closed, true);

await board.close();
