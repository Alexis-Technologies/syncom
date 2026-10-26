'use strict';

// Framework stores (src/store/store.js): each source — a cursor, a live
// Record, a record through get(), a presence, an emitter — as a store that
// keeps Svelte's contract and React's useSyncExternalStore's (STORE-1).

const test = require('node:test');
const assert = require('node:assert');
const syncom = require('../src/all/all.js');
const { memory } = require('../src/memory/memory.js');
const { createPresence } = require('../src/presence/presence.js');
const { toStore, fromEvents } = require('../src/store/store.js');
const { waitUntil } = require('./utils/mesh.js');

const open = async (t, options = {}) => {
  const storage = await syncom.open({
    path: '/s',
    fsi: memory(),
    logger: false,
    defer: 0,
    schema: { entities: { Task: { index: ['done'] } } },
    ...options,
  });
  t.after(() => storage.close().catch(() => {}));
  return storage;
};

// What React's useSyncExternalStore asks of a store: the snapshot is the
// same value until the store says it changed, and a change it was told of
// reads as a new one.
const reactLike = (store) => {
  const renders = [];
  let last = store.getSnapshot();
  renders.push(last);
  const stop = store.subscribe(() => {
    const next = store.getSnapshot();
    if (!Object.is(next, last)) renders.push((last = next));
  });
  assert.strictEqual(store.getSnapshot(), store.getSnapshot(), 'a snapshot keeps its identity between changes');
  return { renders, stop };
};

test('stores', async (t) => {
  await t.test(
    'a store keeps Svelte’s contract and React’s: a value at once and on every change, a stable snapshot, the source watched from the first subscriber to the last',
    async (t2) => {
      const storage = await open(t2);
      await storage.Task.insert({ title: 'a', done: false });
      const cursor = storage.Task.select({ done: false }).order('title');
      const store = toStore(cursor);
      assert.strictEqual(store.getSnapshot(), undefined, 'nothing before a subscriber');
      // Svelte: run is called at once, with what the store holds.
      const seen = [];
      const stop = store.subscribe((rows) => seen.push(rows?.map((row) => row.title)));
      assert.deepStrictEqual(seen, [undefined]);
      await store.ready;
      await waitUntil(() => seen.length === 2);
      assert.deepStrictEqual(seen[1], ['a']);
      // React: a second subscriber; the snapshot changes only with the rows.
      const react = reactLike(store);
      const b = await storage.Task.insert({ title: 'b', done: false });
      await waitUntil(() => react.renders.length === 2);
      assert.deepStrictEqual(
        react.renders[1].map((row) => row.title),
        ['a', 'b'],
      );
      await storage.Task.update(b.id, { done: true });
      await waitUntil(() => react.renders.length === 3);
      assert.deepStrictEqual(
        store.value.map((row) => row.title),
        ['a'],
      );
      // The last subscriber gone: the watch stops, the last value stays.
      stop();
      react.stop();
      const held = store.getSnapshot();
      await storage.Task.insert({ title: 'c', done: false });
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.strictEqual(store.getSnapshot(), held, 'not watched');
      // A new subscriber starts it again.
      const again = [];
      const off = store.subscribe((rows) => again.push(rows));
      await waitUntil(() => again.length === 2);
      assert.deepStrictEqual(
        again[1].map((row) => row.title),
        ['a', 'c'],
      );
      off();
      off(); // twice is nothing
      assert.throws(() => store.subscribe('x'), TypeError);
      assert.throws(() => toStore({}), TypeError);
      assert.throws(() => toStore(storage), TypeError, 'a storage needs a record id');
    },
  );

  await t.test('a live Record, a record through get() or a field of it, a presence room, any emitter', async (t2) => {
    const storage = await open(t2);
    const id = await storage.insert({ title: 'a', profile: { city: 'Lviv' } });
    // A live Record: its data, a new copy per change; null once deleted.
    const record = await storage.record(id);
    const recordStore = toStore(record);
    const records = [];
    const stopRecord = recordStore.subscribe((data) => records.push(data));
    await recordStore.ready;
    assert.deepStrictEqual(records.at(-1), { title: 'a', profile: { city: 'Lviv' } });
    // Through get(): the whole record, and one field of it by path.
    const whole = toStore(storage, id);
    const city = toStore(storage, id, { path: 'profile/city' });
    const wholes = [];
    const cities = [];
    const stopWhole = whole.subscribe((data) => wholes.push(data));
    const stopCity = city.subscribe((value) => cities.push(value));
    await Promise.all([whole.ready, city.ready]);
    await storage.update(id, { 'profile/city': 'Kyiv' });
    await waitUntil(() => cities.at(-1) === 'Kyiv' && records.at(-1)?.profile?.city === 'Kyiv');
    assert.deepStrictEqual(wholes.at(-1), { title: 'a', profile: { city: 'Kyiv' } });
    // The live Record reads as get() does: the path under its prefix, never a field of its own.
    assert.deepStrictEqual(records.at(-1), { title: 'a', profile: { city: 'Kyiv' } });
    assert.deepStrictEqual([record.profile, record['profile/city']], [{ city: 'Kyiv' }, undefined]);
    assert.notStrictEqual(records.at(-1), records.at(-2), 'a copy per change');
    await storage.delete(id);
    await waitUntil(() => wholes.at(-1) === null && records.at(-1) === null && cities.at(-1) === null);
    stopRecord();
    stopWhole();
    stopCity();
    assert.throws(() => toStore(storage, id, { path: 5 }), TypeError);
    // A presence room: its states by node.
    const presence = createPresence(storage, { timeout: 1000 });
    t2.after(() => presence.destroy());
    const room = toStore(presence);
    const states = [];
    const stopRoom = room.subscribe((map) => states.push(map.size));
    await presence.set({ name: 'ada' });
    assert.deepStrictEqual(states, [0, 1], 'at once, then on the change');
    assert.deepStrictEqual(room.value.get(storage.nodeId), { name: 'ada' });
    stopRoom();
    // Any emitter: the read again after each event, a promise's value once it is there.
    const peers = fromEvents(storage, ['change'], async () => (await storage.list()).length, { initial: -1 });
    const counts = [];
    const stopPeers = peers.subscribe((count) => counts.push(count));
    await peers.ready;
    await storage.insert({ n: 1 });
    await waitUntil(() => counts.at(-1) === 1);
    assert.strictEqual(counts[0], -1, 'the initial value at once');
    stopPeers();
    assert.throws(() => fromEvents({}, [], () => 1), TypeError);
    assert.throws(() => fromEvents(storage, 'change', () => 1), TypeError);
  });

  await t.test(
    'a failing source keeps the last value, reports the error and clears it with the next value',
    async (t2) => {
      const storage = await open(t2);
      const errors = [];
      let fail = true;
      const store = fromEvents(
        storage,
        ['change'],
        () => {
          if (fail) throw new Error('boom');
          return 'ok';
        },
        { initial: 'start', onError: (error) => errors.push(error.message) },
      );
      const values = [];
      const stop = store.subscribe((value) => values.push(value));
      assert.deepStrictEqual([values, store.error?.message, errors], [['start'], 'boom', ['boom']]);
      fail = false;
      await storage.insert({ n: 1 });
      await waitUntil(() => values.at(-1) === 'ok');
      assert.strictEqual(store.error, null);
      stop();
      // A cursor whose query throws reports through onError too.
      await storage.Task.insert({ title: 'x', done: false });
      const broken = toStore(
        storage.Task.select().filter(() => {
          throw new Error('a filter that throws');
        }),
        { onError: (error) => errors.push(error.message) },
      );
      const off = broken.subscribe(() => {});
      await waitUntil(() => errors.length === 2);
      assert.ok(broken.error instanceof Error);
      off();
      // A read that resolves after its watch stopped is dropped.
      let resolveLate;
      const late = fromEvents(storage, ['change'], () => new Promise((resolve) => (resolveLate = resolve)));
      const offLate = late.subscribe(() => {});
      offLate();
      resolveLate('too late');
      await new Promise((resolve) => setTimeout(resolve, 5));
      assert.strictEqual(late.getSnapshot(), undefined);
    },
  );
});
