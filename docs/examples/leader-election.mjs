// The Leader election page (docs/guide/leader-election.md) shows the regions of this file. Node.js has Web Locks
// (`navigator.locks`) and BroadcastChannel, so the "tabs" here are elections and databases in one process.
// tests/package/docs-examples.test.js runs it from an empty temporary directory.
import assert from 'node:assert/strict';
import { waitUntil } from '@alexify/syncom/testing';

const log = [];
const say = console.log;
console.log = (...args) => {
  log.push(args.join(' '));
  say(...args);
};
const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

// #region elect
import { elect } from '@alexify/syncom/shared';

// What every tab runs: whichever tab holds the lock sends the reminders.
const joinElection = (tab) => {
  const election = elect({ name: 'board:reminders', locks: navigator.locks });
  const lead = () => console.log(`${tab} sends the reminders`);
  election.onLead(lead); // at every grant from now on
  if (election.leader) lead(); // the lock may be granted before elect() returns
  return election;
};

const tabs = [joinElection('tab 1'), joinElection('tab 2'), joinElection('tab 3')];
// tab 1 sends the reminders
// #endregion elect
await tick();
assert.deepEqual(log, ['tab 1 sends the reminders']);
assert.deepEqual(
  tabs.map((election) => election.leader),
  [true, false, false],
);
assert.equal(tabs[0].mode, 'locks');

// #region release
tabs[0].release(); // tab 1 closes: a closed or crashed tab lets go of the lock the same way
// tab 2 sends the reminders
// #endregion release
await tick();
assert.deepEqual(log, ['tab 1 sends the reminders', 'tab 2 sends the reminders']);
assert.equal(tabs[1].leader, true);
tabs[1].release();
await tick();
assert.equal(tabs[2].leader, true);
tabs[2].release();

// #region heartbeat
const channel = new BroadcastChannel('board:reminders');
const election = elect({ name: 'board:reminders', channel, heartbeat: 250 });
console.log(election.mode); // 'heartbeat'
// #endregion heartbeat
const rival = new BroadcastChannel('board:reminders');
const other = elect({ name: 'board:reminders', channel: rival, heartbeat: 250 });
await waitUntil(() => election.leader || other.leader, { timeout: 3000 });
await tick(600);
assert.equal(election.mode, 'heartbeat');
assert.equal(Number(election.leader) + Number(other.leader), 1);
election.release();
other.release();
channel.close();
rival.close();
log.length = 0;

// #region shared
import { createDatabase, memoryEngine } from '@alexify/syncom/all';
import { openShared } from '@alexify/syncom/shared';

const engine = memoryEngine(); // in a browser: idbEngine({ name: 'board' }), opened by every tab

const openTab = () =>
  openShared({
    createDatabase,
    engine,
    path: 'board',
    schema: { entities: { Task: { index: ['done'] } } },
    election: { locks: navigator.locks },
  });

const first = await openTab();
const second = await openTab();
const third = await openTab();
console.log(first.isLeader(), second.isLeader(), third.isLeader()); // true false false

const id = await first.insert({ $type: 'Task', title: 'Write the docs', done: false });
// the followers read what the leader wrote, from the same engine
// #endregion shared
await waitUntil(() => third.hasRecord(id), { timeout: 3000 });
assert.deepEqual(await third.get(id), { $type: 'Task', title: 'Write the docs', done: false });
assert.deepEqual(log, ['true false false']);
await assert.rejects(second.insert({ $type: 'Task', title: 'x' }), { code: 'NOT_LEADER' });
assert.throws(() => second.sync, { code: 'NOT_LEADER' });

// #region failover
second.onLeader(({ generation }) => console.log('the second tab leads, generation', generation));

await first.close(); // the leading tab goes away
await second.waitForLeadership();
// the second tab leads, generation 1
await second.update(id, { done: true }); // the new leader writes
// #endregion failover
assert.equal(second.isLeader(), true);
assert.equal(second.generation, 1);
assert.equal(log.at(-1), 'the second tab leads, generation 1');
await waitUntil(async () => (await third.get(id))?.done === true, { timeout: 3000 });
assert.equal(third.isLeader(), false);

await second.close();
await third.close();
console.log = say;
