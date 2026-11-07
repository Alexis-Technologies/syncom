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
const { openShared, Shared, SharedDocument, MUTATORS, TX_WRITERS } = require('../src/shared/shared.js');
const { elect } = require('../src/shared/election.js');
const { describe, revive, answerOf, unwrap, isChannel } = require('../src/shared/channel.js');
const { createSharedChannel } = require('../src/wrpc/wrpc.js');
const { SyncomError } = require('../src/errors.js');
const { createFakeLocks } = require('./utils/fake-locks.js');
const { createLeaderPort, createBroadcastChannels } = require('./utils/fake-port.js');
const { waitUntil } = require('./utils/mesh.js');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const schema = { entities: { Task: {} } };
// Resolves once the election leads (at once where it does already).
const led = (election) =>
  new Promise((resolve) => {
    if (election.leader) return void resolve();
    const off = election.onLead(() => {
      off();
      resolve();
    });
  });

// One "browser profile": an engine, its locks, the port the leader serves on; `open(name)` is a tab.
const profile = (
  t,
  { engine = syncom.memoryEngine(), path = 'shared', createDatabase = syncom.createDatabase } = {},
) => {
  const locks = createFakeLocks();
  const port = createLeaderPort();
  const tabs = new Set();
  const open = async (options = {}) => {
    const shared = await openShared({
      createDatabase,
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
      await led(a);
      assert.strictEqual(a.leader, true);
      const b = elect({ name, channel: new Channel(name), heartbeat: 10, misses: 2, token: 'b' });
      await sleep(80);
      assert.strictEqual(b.leader, false, 'a leader beats: B waits');
      // A says bye: B claims at the next beat.
      a.release();
      await led(b);
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
      await Promise.race([led(d), led(e)]);
      await sleep(60);
      assert.strictEqual(d.leader && e.leader, false, 'one leader');
      assert.strictEqual(d.leader || e.leader, true);
      d.release();
      e.release();
      assert.throws(() => elect({}), { name: 'TypeError', message: /name/ });
      assert.throws(() => elect({ name, heartbeat: 0 }), { name: 'TypeError', message: /heartbeat/ });
      assert.throws(() => elect({ name, misses: 0 }), { name: 'TypeError', message: /misses/ });
      assert.throws(() => elect({ name, follower: 1 }), { name: 'TypeError', message: /follower/ });
      // Web Locks: released before it is granted, never leads.
      const locks = createFakeLocks();
      const first = elect({ name: 'l', locks });
      await led(first);
      const second = elect({ name: 'l', locks });
      second.release();
      first.release();
      await sleep(10);
      assert.strictEqual(second.leader, false);
      assert.strictEqual(locks.held('l'), false);
      // A follower never leads, whatever it asks.
      const never = elect({ name: 'l', follower: true, locks });
      assert.strictEqual(never.mode, 'follower');
      never.request();
      await sleep(10);
      assert.strictEqual(never.leader, false);
      assert.strictEqual(locks.held('l'), false);
      never.release();
    },
  );

  await t.test(
    'the heartbeat election is re-armed: a leader that yielded claims again when the other says bye; a stolen lock is a loss',
    async () => {
      const Channel = createBroadcastChannels();
      const name = 'syncom:leader:rearm';
      const a = elect({ name, channel: new Channel(name), heartbeat: 10, misses: 2, token: 'b' });
      const leads = [];
      const losses = [];
      a.onLead(() => leads.push(Date.now()));
      a.onLost(() => losses.push(Date.now()));
      await led(a);
      // A smaller token leads too (a partition healed): A yields — once, told once.
      const rival = new Channel(name);
      rival.postMessage({ syncom: name, t: 'lead', token: 'a' });
      await waitUntil(() => losses.length === 1);
      assert.strictEqual(a.leader, false);
      // The rival says bye: A claims again at the next beat — the election is not one shot.
      rival.postMessage({ syncom: name, t: 'bye', token: 'a' });
      await waitUntil(() => leads.length === 2);
      assert.strictEqual(a.leader, true);
      // yield() steps aside and claims nothing until request(); then it leads once nobody beats.
      a.yield();
      assert.strictEqual(a.leader, false);
      await sleep(60);
      assert.strictEqual(a.leader, false, 'suspended: no claim');
      a.request();
      await waitUntil(() => a.leader);
      assert.strictEqual(leads.length, 3);
      a.release();
      rival.close();
      // Web Locks: yield() lets the lock go to the next in line, request() asks again; a lock stolen is a loss.
      const locks = createFakeLocks();
      const first = elect({ name: 'w', locks, token: 'first' });
      const second = elect({ name: 'w', locks, token: 'second' });
      await led(first);
      assert.strictEqual(second.leader, false);
      let granted = 0;
      first.onLead(() => granted++);
      first.yield();
      await led(second);
      assert.strictEqual(first.leader, false);
      first.request();
      await sleep(10);
      assert.strictEqual(first.leader, false, 'queued behind the holder');
      second.release();
      await waitUntil(() => first.leader);
      assert.strictEqual(granted, 1);
      const lost = [];
      first.onLost(() => lost.push(1));
      await locks.request('w', { mode: 'exclusive', steal: true }, async () => 'stolen');
      await waitUntil(() => lost.length === 1);
      assert.strictEqual(first.leader, false);
      first.release();
      // A yield before the grant lets the lock go the moment it comes.
      const holder = elect({ name: 'y', locks });
      await led(holder);
      const early = elect({ name: 'y', locks });
      early.yield();
      holder.release();
      await sleep(10);
      assert.strictEqual(early.leader, false);
      assert.strictEqual(locks.held('y'), false);
      early.release();
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

  await t.test(
    'an elected instance that cannot open yields the lock, says PROMOTE_FAILED and leads once the database frees; openShared rejects and releases when the first open fails',
    async (t2) => {
      // A createDatabase that fails the next open as a writer: a disk on fire, a stale lock past LOCKED_RETRIES.
      let failNext = false;
      let opens = 0;
      const createDatabase = async (options) => {
        if (options.readOnly !== true) {
          opens++;
          if (failNext) {
            failNext = false;
            throw Object.assign(new Error('disk on fire'), { code: 'EIO' });
          }
        }
        return syncom.createDatabase(options);
      };
      const { open, closeTab, locks } = profile(t2, { path: 'promote', createDatabase });
      const a = await open();
      const b = await open();
      const c = await open();
      const errors = [];
      b.on('error', (error) => errors.push(error));
      const cLeads = c.waitForLeadership();
      failNext = true;
      await closeTab(a);
      // B was next in line and could not open: PROMOTE_FAILED, the lock yielded — C leads in its place.
      await cLeads;
      assert.strictEqual(c.leader, true);
      assert.strictEqual(b.leader, false);
      assert.strictEqual(errors.length, 1);
      assert.strictEqual(errors[0].code, 'PROMOTE_FAILED');
      assert.strictEqual(errors[0].attempt, 0);
      assert.strictEqual(errors[0].cause?.code, 'EIO');
      assert.strictEqual(errors[0].path, 'promote');
      assert.ok(b.db, 'the follower stands: never null');
      // B's writes go through C meanwhile.
      const id = await b.insert({ $type: 'Task', title: 'through C' });
      assert.deepStrictEqual(await c.get(id), { $type: 'Task', title: 'through C' });
      // C goes: B asked for the lock again after its backoff, is granted it and leads this time.
      const bLeads = b.waitForLeadership();
      await closeTab(c);
      await bLeads;
      assert.strictEqual(b.leader, true);
      assert.strictEqual((await b.get(id)).title, 'through C');
      assert.strictEqual(locks.held('syncom:leader:promote'), true);
      assert.ok(opens >= 3, `the writer opened ${opens} times`);
      // The first open fails: openShared rejects with it, and the election is released — the next instance leads.
      const fresh = createFakeLocks();
      let first = true;
      const failing = async (options) => {
        if (first) {
          first = false;
          throw new Error('no such flavour');
        }
        return syncom.createDatabase(options);
      };
      const engine = syncom.memoryEngine();
      await assert.rejects(
        () => openShared({ createDatabase: failing, engine, path: 'first', logger: false, election: { locks: fresh } }),
        { message: 'no such flavour' },
      );
      assert.strictEqual(fresh.held('syncom:leader:first'), false, 'the lock let go');
      const next = await openShared({
        createDatabase: syncom.createDatabase,
        engine,
        path: 'first',
        logger: false,
        election: { locks: fresh },
      });
      t2.after(() => next.close().catch(() => {}));
      assert.strictEqual(next.leader, true);
    },
  );

  await t.test(
    'a fresh path in heartbeat mode: the first instance waits the election out and leads; a second one follows once node.json is there',
    async (t2) => {
      const Channel = createBroadcastChannels();
      const engine = syncom.memoryEngine();
      const port = createLeaderPort();
      const name = 'syncom:leader:beats';
      const open = async () => {
        const shared = await openShared({
          createDatabase: syncom.createDatabase,
          engine,
          path: 'beats',
          logger: false,
          defer: 0,
          schema,
          channel: port.dial,
          election: { channel: new Channel(name), heartbeat: 10, misses: 2 },
          grace: 5,
          failover: 3000,
        });
        t2.after(() => shared.close().catch(() => {}));
        if (shared.leader) port.mount(shared.serve());
        shared.on('leader', () => port.mount(shared.serve()));
        return shared;
      };
      // Two fresh instances at once: the election settles one leader, the other waits for its identity and follows.
      const [a, b] = await Promise.all([open(), open()]);
      assert.strictEqual(a.mode, 'heartbeat');
      assert.strictEqual(a.leader !== b.leader, true, 'one leader');
      const leader = a.leader ? a : b;
      const follower = a.leader ? b : a;
      assert.strictEqual(follower.db.readOnly, true);
      assert.strictEqual(leader.nodeId, follower.nodeId);
      const id = await follower.insert({ $type: 'Task', title: 'beaten' });
      assert.deepStrictEqual(await leader.get(id), { $type: 'Task', title: 'beaten' });
      // A third, later: follows at once.
      const c = await open();
      assert.strictEqual(c.leader, false);
      // The leader goes with a bye: the next claims and leads.
      const next = follower.waitForLeadership();
      await leader.close();
      await next;
      assert.strictEqual(follower.leader, true);
    },
  );

  await t.test(
    'close() closes the database before it lets the election go; concurrent follower writes share one dial; a transport’s TypeError and a CLOSED answer are tried again; serve() is session by default',
    async (t2) => {
      // The leader's close is slow; the next leader is granted the lock only once it is done.
      let closing = null;
      let granted = null;
      const createDatabase = async (options) => {
        const db = await syncom.createDatabase(options);
        if (options.readOnly === true) return db;
        if (closing === null) {
          closing = { done: false };
          const close = db.close.bind(db);
          db.close = async () => {
            await sleep(80);
            await close();
            closing.done = true;
          };
        } else granted = closing.done;
        return db;
      };
      const { open, closeTab, port } = profile(t2, { path: 'order', createDatabase });
      const a = await open();
      assert.strictEqual(a.serve().set.access, 'session');
      assert.strictEqual(a.serve({ access: 'public' }).set.access, 'public');
      const b = await open();
      const leads = b.waitForLeadership();
      await closeTab(a);
      await leads;
      assert.strictEqual(granted, true, 'the lock went to B after A’s database was closed');
      // Concurrent writes of a follower without a channel yet: one dial for all of them.
      let dials = 0;
      const c = await open({
        channel: async (info) => {
          dials++;
          return port.dial(info);
        },
      });
      const writes = [];
      for (let i = 0; i < 5; i++) writes.push(c.set(`c${i}`, { $type: 'Task', n: i }));
      await Promise.all(writes);
      assert.strictEqual(dials, 1);
      assert.strictEqual(await b.db.Task.count({}), 5);
      // A transport whose first call throws a TypeError (a fetch's) is tried again; so is a CLOSED answer.
      let failures = 0;
      const flaky = async (info) => {
        const channel = await port.dial(info);
        return {
          call: async (method, args) => {
            if (failures === 0) {
              failures++;
              throw new TypeError('fetch failed');
            }
            if (failures === 1) {
              failures++;
              return { ok: false, error: describe(new SyncomError('CLOSED', 'closing', { path: 'order' })) };
            }
            return channel.call(method, args);
          },
          close: () => channel.close?.(),
        };
      };
      const d = await open({ channel: flaky });
      await d.set('flaky', { $type: 'Task', title: 'landed' });
      assert.strictEqual(failures, 2);
      assert.deepStrictEqual(await b.get('flaky'), { $type: 'Task', title: 'landed' });
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
    // A follower by option never leads: `mode: 'follower'`, a write without a leader waits, then LEADER_LOST.
    const never = await openShared({
      createDatabase: syncom.createDatabase,
      engine,
      path: 'nochan',
      logger: false,
      election: { follower: true },
      failover: 60,
      channel: async () => ({ call: async () => 42 }),
    });
    t2.after(() => never.close().catch(() => {}));
    assert.strictEqual(never.mode, 'follower');
    assert.strictEqual(never.leader, false);
    await assert.rejects(() => never.set('x', {}), { code: 'LEADER_LOST' });
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

  await t.test(
    'describe sends a data error’s fields alone and revive never swaps a prototype; a SharedDocument whose bind failed throws that error',
    async () => {
      // A file system's error crosses as its name, message and code: never its path, syscall or errno.
      const fs = Object.assign(new Error('ENOENT: no such file'), {
        code: 'ENOENT',
        path: '/home/x/keys/private.pem',
        syscall: 'open',
        errno: -2,
      });
      assert.deepStrictEqual(describe(fs), {
        name: 'Error',
        message: 'ENOENT: no such file',
        code: 'ENOENT',
        fields: {},
      });
      const data = new SyncomError('NOT_FOUND', 'gone', { id: 'x' });
      assert.deepStrictEqual(describe(data).fields, { id: 'x' });
      // Described fields that would reach the prototype or the error's own are never laid on.
      const hostile = {
        name: 'SyncomError',
        code: 'NOT_FOUND',
        message: 'm',
        fields: JSON.parse(
          '{"__proto__":{"evil":true},"constructor":"x","prototype":1,"code":"OTHER","name":"Nope","id":"ok"}',
        ),
      };
      const revived = revive(hostile);
      assert.strictEqual(Object.getPrototypeOf(revived), SyncomError.prototype);
      assert.strictEqual(revived.evil, undefined);
      assert.strictEqual(revived.constructor, SyncomError);
      assert.strictEqual(revived.code, 'NOT_FOUND');
      assert.strictEqual(revived.name, 'SyncomError');
      assert.strictEqual(revived.id, 'ok');
      const plain = revive({ name: 'TypeError', message: 'm', fields: JSON.parse('{"__proto__":{"evil":true}}') });
      assert.strictEqual(Object.getPrototypeOf(plain), TypeError.prototype);
      assert.strictEqual(plain.evil, undefined);
      assert.strictEqual(Object.prototype.evil, undefined);
      // A SharedDocument whose bind failed: data() throws what the bind threw, never a read of null.
      const failing = {
        live(make) {
          make({ document: async () => Promise.reject(new SyncomError('CLOSED', 'the instance is closed')) });
          return () => {};
        },
      };
      const doc = new SharedDocument(failing, 'x', () => ({ warn() {} }));
      await assert.rejects(() => doc.data(), { code: 'CLOSED' });
      assert.strictEqual(doc.document, null);
      doc.close();
    },
  );
});
