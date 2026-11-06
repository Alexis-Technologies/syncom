'use strict';

// Several instances over one database (@alexify/syncom/shared): one leads, the
// others follow and write through it; the leader gone, a follower takes its
// place with the same node and every live thing is made again. Over the
// memory engine with a fake Web Locks and an in-process port, over the
// IndexedDB engine with a fake BroadcastChannel; the heartbeat election on
// its own.

const test = require('node:test');
const assert = require('node:assert');
const { IDBFactory, IDBKeyRange } = require('fake-indexeddb');
const syncom = require('../src/all/all.js');
const { idbEngine } = require('../src/idb/idb.js');
const { openShared, Shared, MUTATORS, TX_WRITERS } = require('../src/shared/shared.js');
const { elect } = require('../src/shared/election.js');
const { describe, revive, answerOf, unwrap, isChannel } = require('../src/shared/channel.js');
const { createSharedChannel } = require('../src/wrpc/wrpc.js');
const { SyncomError } = require('../src/errors.js');
const { createFakeLocks } = require('./utils/fake-locks.js');
const { createLeaderPort, createBroadcastChannels } = require('./utils/fake-port.js');
const { waitUntil } = require('./utils/mesh.js');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const schema = { entities: { Task: {} } };

// One "browser profile": an engine, its locks, the port the leader serves on; `open(name)` is a tab.
const profile = (t, { engine = syncom.memoryEngine(), path = 'shared' } = {}) => {
  const locks = createFakeLocks();
  const port = createLeaderPort();
  const tabs = new Set();
  const open = async (options = {}) => {
    const shared = await openShared({
      createDatabase: syncom.createDatabase,
      engine,
      path,
      logger: false,
      defer: 0,
      schema,
      channel: port.dial,
      election: { locks },
      grace: 20,
      failover: 3000,
      ...options,
    });
    // What the application wires: the leader mounts its writers on the port; a leader that goes unmounts.
    const mount = () => port.mount(shared.serve());
    if (shared.leader) mount();
    shared.on('leader', mount);
    tabs.add(shared);
    t.after(() => shared.close().catch(() => {}));
    return shared;
  };
  const closeTab = async (shared) => {
    tabs.delete(shared);
    if (shared.leader) port.mount(null);
    await shared.close();
  };
  return { engine, locks, port, open, closeTab };
};

test('Shared database', async (t) => {
  await t.test(
    'the heartbeat election: a claim, a lead, a bye; two leaders settle by token; the options are checked',
    async () => {
      const Channel = createBroadcastChannels();
      const name = 'syncom:leader:beat';
      const a = elect({ name, channel: new Channel(name), heartbeat: 10, misses: 2, token: 'a' });
      assert.strictEqual(a.mode, 'heartbeat');
      await a.lead;
      assert.strictEqual(a.leader, true);
      const b = elect({ name, channel: new Channel(name), heartbeat: 10, misses: 2, token: 'b' });
      await sleep(80);
      assert.strictEqual(b.leader, false, 'a leader beats: B waits');
      // A says bye: B claims at the next beat.
      a.release();
      await b.lead;
      assert.strictEqual(b.leader, true);
      // Two leaders at once (a partition healed): the smaller token stays, the other yields.
      // A candidate hears B leading and never leads while B does.
      const c = elect({ name, channel: new Channel(name), heartbeat: 10, misses: 2, token: 'a2' });
      await sleep(60);
      assert.strictEqual(c.leader, false);
      b.release();
      c.release();
      const d = elect({ name, channel: new Channel(name), heartbeat: 10, misses: 2, token: 'd' });
      const e = elect({ name, channel: new Channel(name), heartbeat: 10, misses: 2, token: 'e' });
      await Promise.race([d.lead, e.lead]);
      await sleep(60);
      assert.strictEqual(d.leader && e.leader, false, 'one leader');
      assert.strictEqual(d.leader || e.leader, true);
      d.release();
      e.release();
      assert.throws(() => elect({}), { name: 'TypeError', message: /name/ });
      assert.throws(() => elect({ name, heartbeat: 0 }), { name: 'TypeError', message: /heartbeat/ });
      assert.throws(() => elect({ name, misses: 0 }), { name: 'TypeError', message: /misses/ });
      // Web Locks: released before it is granted, never leads.
      const locks = createFakeLocks();
      const first = elect({ name: 'l', locks });
      await first.lead;
      const second = elect({ name: 'l', locks });
      second.release();
      first.release();
      await sleep(10);
      assert.strictEqual(second.leader, false);
      assert.strictEqual(locks.held('l'), false);
    },
  );

  await t.test(
    'two instances over one engine: the first leads, the second follows and writes through it; both read what lands; the leader’s alone',
    async (t2) => {
      const { open, port, locks } = profile(t2);
      const a = await open();
      const b = await open();
      assert.strictEqual(a.leader, true);
      assert.strictEqual(a.mode, 'locks');
      assert.strictEqual(b.leader, false);
      assert.strictEqual(b.db.readOnly, true, 'a follower is a read-only database over the same engine');
      assert.strictEqual(a.nodeId, b.nodeId, 'one directory, one node');
      // A write made on the follower lands through the leader and is read on both.
      const id = await b.insert({ $type: 'Task', title: 'through the leader' });
      assert.deepStrictEqual(await a.get(id), { $type: 'Task', title: 'through the leader' });
      await waitUntil(async () => (await b.get(id)) !== null);
      assert.deepStrictEqual(await b.get(id), { $type: 'Task', title: 'through the leader' });
      assert.ok(port.calls.includes('insert'));
      await b.update(id, { done: true });
      await waitUntil(async () => (await b.get(id))?.done === true);
      assert.strictEqual((await a.get(id)).done, true);
      // The leader's own write reaches the follower through the engine's change stream.
      const own = await a.insert({ $type: 'Task', title: 'the leader’s' });
      await waitUntil(() => b.hasRecord(own));
      assert.strictEqual((await b.collection('Task').select({}).fetch()).length, 2);
      assert.strictEqual(await b.db.Task.count({ done: true }), 1);
      assert.throws(() => b.collection('Nope'), { name: 'TypeError' });
      // A recorded transaction: the writers noted here, run as one transaction there; insert refused.
      const inTx = await b.transact(async (tx) => {
        assert.deepStrictEqual((await tx.get(id)).title, 'through the leader');
        await tx.update(id, { n: 1 });
        await tx.inc(id, 'hits', 2);
        await assert.rejects(() => tx.insert({ $type: 'Task' }), { name: 'TypeError', message: /insert/ });
        return 'done';
      });
      assert.strictEqual(inTx, 'done');
      await waitUntil(async () => (await b.get(id))?.hits === 2);
      assert.deepStrictEqual(await a.get(id).then(({ n, hits }) => ({ n, hits })), { n: 1, hits: 2 });
      // A refusal round-trips as it was thrown: a SyncomError with its code, a TypeError with its data code.
      await assert.rejects(
        () => b.update('missing', { a: 1 }),
        (error) => {
          assert.strictEqual(error.name, 'SyncomError');
          assert.strictEqual(error.code, 'NOT_FOUND');
          assert.ok(error instanceof SyncomError);
          return true;
        },
      );
      await assert.rejects(() => b.set('bad id!', { a: 1 }), { name: 'TypeError', code: 'INVALID_ID' });
      await assert.rejects(
        () => b.transact(async (tx) => tx.update(id, 7)),
        (error) => error.name === 'TypeError' || error.code !== undefined,
      );
      // What is the leader's: sync, serve.
      assert.throws(() => b.sync, { code: 'NOT_LEADER' });
      assert.throws(() => b.serve(), { code: 'NOT_LEADER' });
      assert.ok(a.sync, 'the leader replicates');
      assert.deepStrictEqual(Object.keys(a.serve()).sort(), [...MUTATORS, 'transact'].sort());
      // A follower's live document hears the leader's writes (a follower raises no transaction event: no observe).
      const doc = b.document(id);
      const updates = [];
      doc.on('update', (data) => updates.push(data?.title));
      await a.update(id, { title: 'renamed' });
      await waitUntil(() => updates.length >= 1);
      assert.strictEqual(updates.at(-1), 'renamed');
      assert.strictEqual(typeof b.observe, 'undefined');
      assert.strictEqual((await doc.data()).title, 'renamed');
      assert.strictEqual(doc.id, id);
      assert.strictEqual(doc.document?.constructor?.name, 'Document');
      doc.close();
      assert.strictEqual(locks.held(`syncom:leader:shared`), true);
      await assert.rejects(() => b.waitForLeadership({ signal: AbortSignal.abort() }), { name: 'AbortError' });
    },
  );

  await t.test(
    'the leader closes: a follower takes the lock and leads with the same node id and vector; live things are made again once; a write in flight is tried again',
    async (t2) => {
      const { open, closeTab, port } = profile(t2, { path: 'failover' });
      const a = await open();
      const b = await open();
      const c = await open();
      const first = await a.insert({ $type: 'Task', title: 'before' });
      await waitUntil(() => b.hasRecord(first) && c.hasRecord(first));
      const nodeId = a.nodeId;
      const vector = { ...a.db.vector };
      // A live document and a live function on B, made again after the failover.
      const doc = b.document(first);
      const seen = [];
      doc.on('update', (data, delta) => seen.push([data?.title, delta]));
      let made = 0;
      const stopLive = b.live((db) => {
        made++;
        assert.ok(db);
        return () => {};
      });
      const events = [];
      b.on('leader', (event) => events.push(['leader', event.generation]));
      b.on('rebind', (event) => events.push(['rebind', event.generation]));
      c.on('leader', (event) => events.push(['c-leader', event.generation]));
      const leadership = b.waitForLeadership();
      // A goes. C writes while no leader answers: the write waits for one.
      await closeTab(a);
      const pending = c.set('late', { $type: 'Task', title: 'while the leader changed' });
      await leadership;
      assert.strictEqual(b.leader, true);
      assert.strictEqual(b.generation, 1);
      assert.strictEqual(b.nodeId, nodeId, 'the same node');
      assert.deepStrictEqual(b.db.vector, vector, 'the same log');
      assert.strictEqual(b.db.readOnly, false);
      await pending;
      assert.deepStrictEqual(await b.get('late'), { $type: 'Task', title: 'while the leader changed' });
      await waitUntil(async () => (await c.get('late')) !== null);
      assert.strictEqual(made, 2, 'the live function ran again over the new instance');
      await waitUntil(() => seen.some(([, delta]) => delta === null));
      assert.deepStrictEqual(seen.filter(([, delta]) => delta === null).length, 1, 're-read once');
      assert.strictEqual(seen.at(-1)[0], 'before');
      assert.deepStrictEqual(
        events.filter(([kind]) => kind !== 'c-leader'),
        [
          ['rebind', 1],
          ['leader', 1],
        ],
      );
      assert.strictEqual(c.leader, false, 'C still follows — the new leader');
      // The new leader writes on its own; the follower hears it.
      const second = await b.insert({ $type: 'Task', title: 'after' });
      await waitUntil(() => c.hasRecord(second));
      const viaC = await c.update(second, { done: true });
      assert.ok(viaC === undefined || viaC === null || typeof viaC === 'object');
      await waitUntil(async () => (await c.get(second))?.done === true);
      stopLive();
      doc.close();
      // The port unmounted for good: a follower's write past `failover` is LEADER_LOST.
      port.mount(null);
      const d = await open({ failover: 150 });
      assert.strictEqual(d.leader, false);
      await assert.rejects(() => d.set('never', { $type: 'Task' }), { code: 'LEADER_LOST' });
    },
  );

  await t.test('closing rejects the leadership waiters, refuses what follows; the options are checked', async (t2) => {
    const { open } = profile(t2, { path: 'closing' });
    const a = await open();
    const b = await open();
    const waiting = b.waitForLeadership();
    await b.close();
    await assert.rejects(waiting, { code: 'CLOSED' });
    assert.throws(() => b.db, { code: 'CLOSED' });
    await assert.rejects(() => b.set('x', {}), { code: 'CLOSED' });
    await b.close();
    await a.close();
    assert.throws(() => new Shared(null), { name: 'TypeError' });
    assert.throws(() => new Shared({ path: 'x' }), { name: 'TypeError', message: /createDatabase/ });
    assert.throws(() => new Shared({ createDatabase: syncom.createDatabase }), { name: 'TypeError', message: /path/ });
    assert.throws(() => new Shared({ createDatabase: syncom.createDatabase, path: 'x', channel: 1 }), {
      name: 'TypeError',
      message: /channel/,
    });
    assert.throws(() => new Shared({ createDatabase: syncom.createDatabase, path: 'x', election: null }), {
      name: 'TypeError',
      message: /election/,
    });
    assert.throws(() => new Shared({ createDatabase: syncom.createDatabase, path: 'x', grace: -1 }), {
      name: 'TypeError',
      message: /grace/,
    });
    assert.throws(() => new Shared({ createDatabase: syncom.createDatabase, path: 'x', failover: 'no' }), {
      name: 'TypeError',
      message: /failover/,
    });
    // Alone — nothing to elect with — leads at once; a follower without a channel cannot write.
    const alone = await openShared({
      createDatabase: syncom.createDatabase,
      engine: syncom.memoryEngine(),
      path: 'alone',
      logger: false,
      defer: 0,
    });
    t2.after(() => alone.close().catch(() => {}));
    assert.strictEqual(alone.leader, true);
    assert.strictEqual(alone.mode, 'alone');
    await alone.waitForLeadership();
    assert.strictEqual(await alone.insert({ title: 'mine' }).then((id) => typeof id), 'string');
    assert.throws(() => alone.live(1), { name: 'TypeError' });
    const engine = syncom.memoryEngine();
    const locks = createFakeLocks();
    const leader = await openShared({
      createDatabase: syncom.createDatabase,
      engine,
      path: 'nochan',
      logger: false,
      election: { locks },
    });
    t2.after(() => leader.close().catch(() => {}));
    const mute = await openShared({
      createDatabase: syncom.createDatabase,
      engine,
      path: 'nochan',
      logger: false,
      election: { locks },
      grace: 10,
    });
    t2.after(() => mute.close().catch(() => {}));
    assert.strictEqual(mute.leader, false);
    await assert.rejects(() => mute.set('x', {}), { code: 'NOT_LEADER' });
    // A channel that answers nothing readable is LEADER_LOST once the failover window passes; one that is no channel a TypeError.
    const odd = await openShared({
      createDatabase: syncom.createDatabase,
      engine,
      path: 'nochan',
      logger: false,
      election: { locks },
      grace: 10,
      failover: 60,
      channel: async () => ({ call: async () => 42 }),
    });
    t2.after(() => odd.close().catch(() => {}));
    await assert.rejects(() => odd.set('x', {}), { code: 'LEADER_LOST' });
    const wrong = await openShared({
      createDatabase: syncom.createDatabase,
      engine,
      path: 'nochan',
      logger: false,
      election: { locks },
      grace: 10,
      channel: async () => ({}),
    });
    t2.after(() => wrong.close().catch(() => {}));
    await assert.rejects(() => wrong.set('x', {}), { name: 'TypeError', message: /channel/ });
  });

  await t.test('over the IndexedDB engine: a follower hears the leader through the BroadcastChannel', async (t2) => {
    // Two tabs are two engine instances over one IndexedDB and one channel name: each with a token of its own.
    const Channel = createBroadcastChannels();
    const factory = new IDBFactory();
    const tab = () => idbEngine({ indexedDB: factory, IDBKeyRange, channel: Channel, name: 'tabs' });
    const { open } = profile(t2, { engine: tab(), path: 'idb' });
    const a = await open();
    const b = await open({ engine: tab() });
    assert.strictEqual(b.leader, false);
    const id = await b.insert({ $type: 'Task', title: 'in IndexedDB' });
    assert.deepStrictEqual(await a.get(id), { $type: 'Task', title: 'in IndexedDB' });
    await waitUntil(async () => (await b.get(id)) !== null, { timeout: 10_000 });
    const own = await a.insert({ $type: 'Task', title: 'the leader’s' });
    await waitUntil(() => b.hasRecord(own), { timeout: 10_000 });
    assert.strictEqual(await b.db.Task.count({}), 2);
  });

  await t.test(
    'the channel: an error described and revived keeps its name, code and fields; the wrpc channel names the unit',
    async () => {
      const error = new SyncomError('NOT_FOUND', 'no such record', { id: 'x', path: 'p' });
      const described = describe(error);
      assert.deepStrictEqual(described, {
        name: 'SyncomError',
        message: 'no such record',
        code: 'NOT_FOUND',
        fields: { id: 'x', path: 'p' },
      });
      const back = revive(JSON.parse(JSON.stringify(described)));
      assert.ok(back instanceof SyncomError);
      assert.strictEqual(back.code, 'NOT_FOUND');
      assert.strictEqual(back.id, 'x');
      const typed = revive(describe(Object.assign(new TypeError('bad'), { code: 'INVALID_ID' })));
      assert.strictEqual(typed.name, 'TypeError');
      assert.strictEqual(typed.code, 'INVALID_ID');
      assert.strictEqual(revive(describe('boom')).message, 'boom');
      assert.strictEqual(revive(undefined).message, 'The leader refused');
      assert.deepStrictEqual(await answerOf(() => 7), { ok: true, value: 7 });
      assert.strictEqual((await answerOf(() => Promise.reject(error))).ok, false);
      assert.strictEqual(unwrap({ ok: true, value: 'v' }, 'set'), 'v');
      assert.throws(() => unwrap(null, 'set'), { code: 'LEADER_LOST' });
      assert.throws(() => unwrap({ ok: false, error: described }, 'set'), { code: 'NOT_FOUND' });
      assert.strictEqual(isChannel({ call() {} }), true);
      assert.strictEqual(isChannel({}), false);
      const calls = [];
      const client = {
        call: async (method, args) => void calls.push([method, args]),
        close: () => calls.push('closed'),
      };
      const channel = createSharedChannel(client);
      await channel.call('set', ['x', {}]);
      channel.close();
      assert.deepStrictEqual(calls, [['syncom-db/set', ['x', {}]], 'closed']);
      assert.strictEqual(createSharedChannel(client, { unit: 'db' }).client, client);
      assert.throws(() => createSharedChannel({}), { name: 'TypeError' });
      assert.throws(() => createSharedChannel(client, { unit: '' }), { name: 'TypeError' });
      assert.deepStrictEqual(TX_WRITERS.includes('insert'), false);
    },
  );
});
