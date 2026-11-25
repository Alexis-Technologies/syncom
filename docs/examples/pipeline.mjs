// The Pipelines page (docs/guide/pipeline.md) shows the regions of this file.
// tests/package/docs-examples.test.js runs it from an empty temporary directory.
import assert from 'node:assert/strict';
import { createDatabase } from '@alexify/syncom/all';
import { waitUntil } from '@alexify/syncom/testing';

const schema = { entities: { Task: {}, Activity: {} } };

// #region create
import { createPipeline } from '@alexify/syncom/pipeline';

const board = await createDatabase({ path: 'board', schema });

// Every task that is done gets an Activity record; reopening or deleting the task takes it away.
const activity = (db) =>
  createPipeline(db, {
    name: 'activity',
    source: 'Task',
    async handler({ ids }, tx) {
      for (const id of ids) {
        const task = await tx.get(id);
        if (task?.done) await tx.set(`done.${id}`, { $type: 'Activity', task: id, title: task.title });
        else if (await tx.has(`done.${id}`)) await tx.delete(`done.${id}`);
      }
    },
  });

const pipeline = activity(board);
await pipeline.start();
// #endregion create

// #region write
const task = await board.Task.insert({ title: 'Write the docs', done: false });
await board.Task.update(task.id, { done: true });
await pipeline.awaitIdle(); // the handler has caught up with every write so far

console.log(await board.Activity.select({}).fetch());
// [ { $type: 'Activity', task: '…', title: 'Write the docs', id: 'done.…' } ]
// #endregion write
assert.deepEqual(await board.Activity.select({}).fetch(), [
  { id: `done.${task.id}`, task: task.id, title: 'Write the docs', $type: 'Activity' },
]);

// #region batch
const seen = [];
const logger = createPipeline(board, {
  name: 'log',
  source: 'Task',
  handler: ({ ids, changes, replay, rebuilt, eventId }) => {
    seen.push({ ids, replay, rebuilt, eventId, changes: changes?.length ?? null });
  },
});
await logger.start(); // no checkpoint yet: every task is handed over once, rebuilt: true
await board.Task.update(task.id, { title: 'Write the guide' });
await logger.awaitIdle();
console.log(seen);
// [ { ids: [ '…' ], replay: true, rebuilt: true, eventId: '…', changes: null },
//   { ids: [ '…' ], replay: false, rebuilt: false, eventId: '…', changes: 1 } ]
// #endregion batch
assert.equal(seen.length, 2);
assert.deepEqual(
  seen.map(({ replay, rebuilt, changes }) => ({ replay, rebuilt, changes })),
  [
    { replay: true, rebuilt: true, changes: null },
    { replay: false, rebuilt: false, changes: 1 },
  ],
);
logger.stop();

// #region restart
pipeline.stop();
await board.close();

// Written while no pipeline runs: another process, a sync from a peer, a crash before start().
const offline = await createDatabase({ path: 'board', schema });
await offline.Task.insert({ title: 'Ship it', done: true });
await offline.close();

const reopened = await createDatabase({ path: 'board', schema });
const resumed = activity(reopened);
await resumed.start(); // reads its checkpoint and replays the turns the log holds since it
await resumed.awaitIdle();
console.log(await reopened.Activity.select({}).count()); // 2
// #endregion restart
assert.equal(await reopened.Activity.select({}).count(), 2);

// #region failure
let failNext = true;
const failures = [];
reopened.on('error', (error) => failures.push(error.code));
const flaky = createPipeline(reopened, {
  name: 'flaky',
  source: 'Task',
  handler: () => {
    if (failNext) throw new Error('search service down');
  },
});
reopened.on('error', (error) => console.log(error.code, error.cause.message)); // ALX_ERR_PIPELINE_FAILED search service down
await flaky.start(); // the rebuild hands every task over: the handler throws
await flaky.awaitIdle();
console.log(flaky.stopped, flaky.checkpoint); // true null: stopped, and the checkpoint did not move

failNext = false;
await flaky.start(); // the same turn handed over again
await flaky.awaitIdle();
console.log(flaky.stopped, flaky.errors.length); // false 1
// #endregion failure
assert.equal(flaky.stopped, false);
assert.deepEqual(failures, ['ALX_ERR_PIPELINE_FAILED']);
assert.equal(flaky.errors.length, 1);
assert.notEqual(flaky.checkpoint, null);
flaky.stop();
resumed.stop();
await reopened.close();

const said = [];
const print = console.log;
console.log = (...args) => {
  said.push(args.join(' '));
  print(...args);
};

// #region leader
import { openShared } from '@alexify/syncom/shared';
import { memoryEngine } from '@alexify/syncom/all';

const engine = memoryEngine(); // in a browser: idbEngine({ name: 'board' }), opened by every tab

// What every tab runs: the pipeline is started everywhere and runs in the tab that leads.
const openTab = async (name) => {
  const tab = await openShared({ createDatabase, engine, path: 'tabs', schema, election: { locks: navigator.locks } });
  const feed = createPipeline(tab.db, {
    name: 'feed',
    source: 'Task',
    leader: tab,
    handler: ({ ids, replay }) => console.log(`${name} handles ${ids.length} task(s)${replay ? ', replayed' : ''}`),
  });
  await feed.start();
  return { tab, feed };
};

const first = await openTab('tab 1');
const second = await openTab('tab 2');
await first.tab.insert({ $type: 'Task', title: 'Plan the release', done: false });
await first.feed.awaitIdle(); // tab 1 handles 1 task(s)

first.feed.stop();
await first.tab.insert({ $type: 'Task', title: 'Write the notes', done: false }); // nobody handles it yet
await first.tab.close(); // the leading tab goes away
await second.tab.waitForLeadership();
// tab 2 handles 1 task(s), replayed: from the checkpoint tab 1 wrote, not every task again
// #endregion leader
await waitUntil(() => said.length === 2, { timeout: 3000 });
await second.feed.awaitIdle();
assert.deepEqual(said, ['tab 1 handles 1 task(s)', 'tab 2 handles 1 task(s), replayed']);
assert.equal(second.feed.rebuilt, false);
await second.tab.close();
console.log = print;
