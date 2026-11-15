'use strict';

// Persistent app state (src/state/state.js): by name and path, over a record
// — every path a register, two nodes writing different paths converge — or
// a local document.

const test = require('node:test');
const assert = require('node:assert');
const syncom = require('../src/all/all.js');
const { memory } = require('../src/memory/memory.js');
const { createState } = require('../src/state/state.js');
const { toStore } = require('../src/store/store.js');
const { createMesh, settle } = require('./utils/mesh.js');

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

test('app state', async (t) => {
  await t.test(
    'two nodes that write different paths of one state converge; a function runs over the value as it is',
    async (t2) => {
      const fsi = memory();
      const createStorage = async (t3, name, options = {}) => {
        const db = await syncom.createDatabase({ path: `/${name}`, fsi, defer: 0, logger: false, ...options });
        t3.after(() => db.close().catch(() => {}));
        return db;
      };
      const mesh = await createMesh(t2, ['A', 'B'], [['A', 'B']], createStorage);
      const a = createState(mesh.get('A'), 'ui');
      const b = createState(mesh.get('B'), 'ui');
      assert.strictEqual(a.id, 'state.ui');
      assert.deepStrictEqual(await a.get(), {});
      assert.strictEqual(await a.get('theme'), undefined);
      assert.strictEqual(await a.set('theme', 'dark'), 'dark');
      assert.strictEqual(await a.set('panel/width', 320), 320);
      await settle([mesh.get('A'), mesh.get('B')]);
      assert.deepStrictEqual(await b.get(), { theme: 'dark', panel: { width: 320 } });
      // Different paths, at once, on both: both kept.
      await mesh.get('A').sync.enableNode('mem://B', false);
      await a.set('panel/height', 200);
      await b.set('theme', 'light');
      await b.set('count', (n) => (n ?? 0) + 1);
      await b.set('count', (n) => n + 1);
      await mesh.get('A').sync.enableNode('mem://B', true);
      await settle([mesh.get('A'), mesh.get('B')]);
      assert.deepStrictEqual(await a.get(), { theme: 'light', panel: { width: 320, height: 200 }, count: 2 });
      assert.deepStrictEqual(await b.get(), await a.get());
      assert.strictEqual(await a.get('panel/height'), 200);
      // Observed at a path, as a store; a path removed; the whole state replaced.
      const seen = [];
      const stop = a.observe('count', (value) => seen.push(value));
      const store = toStore(a, 'theme');
      const themes = [];
      const unsubscribe = store.subscribe((value) => themes.push(value));
      await tick();
      await b.set('count', 10);
      await b.set('theme', 'blue');
      await settle([mesh.get('A'), mesh.get('B')]);
      await tick();
      assert.deepStrictEqual(seen, [10]);
      assert.deepStrictEqual(themes, [undefined, 'light', 'blue']);
      stop();
      unsubscribe();
      await a.delete('panel/width');
      assert.deepStrictEqual(await a.get('panel'), { height: 200 });
      await a.set({ fresh: true });
      assert.deepStrictEqual(await a.get(), { fresh: true });
      await a.delete();
      assert.deepStrictEqual(await a.get(), {});
      assert.deepStrictEqual(await mesh.get('A').get('state.ui'), {}, 'the record written empty, no tombstone');
      // The arguments.
      await assert.rejects(a.set('x', undefined), TypeError);
      await assert.rejects(
        a.set('x', () => undefined),
        TypeError,
      );
      await assert.rejects(a.set(5), TypeError);
      await assert.rejects(a.get('__proto__/x'), TypeError);
      assert.throws(() => createState(mesh.get('A'), 'bad name'), TypeError);
      assert.throws(() => createState({}, 'x'), TypeError);
    },
  );

  await t.test('over a local document, the whole object is this node’s alone', async (t2) => {
    const fsi = memory();
    const db = await syncom.createDatabase({ path: '/L', fsi, defer: 0, logger: false });
    t2.after(() => db.close().catch(() => {}));
    const state = createState(db, 'prefs', { local: true });
    assert.strictEqual(state.local, true);
    assert.deepStrictEqual(await state.get(), {});
    await state.set('a/b', 1);
    await state.set('a/c', (v) => (v ?? 0) + 2);
    assert.deepStrictEqual(await state.get(), { a: { b: 1, c: 2 } });
    assert.strictEqual(await state.get('a/c'), 2);
    assert.deepStrictEqual(await db.local.get('state.prefs'), { a: { b: 1, c: 2 } });
    assert.strictEqual(db.log.length, 0, 'no op');
    // Sets made at once compose: one change of the document at a time.
    const bump = (n) => (n ?? 0) + 1;
    await Promise.all([state.set('n', bump), state.set('n', bump), state.set('x', 'y'), state.set('n', bump)]);
    assert.strictEqual(await state.get('n'), 3);
    assert.strictEqual(await state.get('x'), 'y');
    // A path deleted from a state that holds nothing writes nothing.
    await createState(db, 'none', { local: true }).delete('x');
    assert.strictEqual(await db.local.get('state.none'), null);
    const seen = [];
    const stop = state.observe((value) => seen.push(value));
    await state.delete('a/b');
    await state.set({ whole: true });
    await tick();
    assert.deepStrictEqual(seen, [{ a: { c: 2 }, n: 3, x: 'y' }, { whole: true }]);
    stop();
    // A listener that throws is contained: the state goes on, the next listener hears.
    const stopBad = state.observe(() => {
      throw new Error('boom');
    });
    const heard = [];
    const stopGood = state.observe('q', (value) => heard.push(value));
    await state.set('q', 1);
    await tick();
    assert.deepStrictEqual(heard, [1]);
    stopBad();
    stopGood();
    await state.delete();
    assert.strictEqual(await db.local.get('state.prefs'), null);
    assert.deepStrictEqual(await state.get(), {});
  });

  await t.test(
    'the first write of a state is a path’s alone: a device that writes before its first sync wipes no other node’s paths',
    async (t2) => {
      const fsi = memory();
      const createStorage = async (t3, name, options = {}) => {
        const db = await syncom.createDatabase({ path: `/${name}`, fsi, defer: 0, logger: false, ...options });
        t3.after(() => db.close().catch(() => {}));
        return db;
      };
      const mesh = await createMesh(t2, ['A', 'B'], [['A', 'B']], createStorage);
      const [a, b] = ['A', 'B'].map((name) => mesh.get(name));
      const apart = async (fn) => {
        await a.sync.enableNode('mem://B', false);
        await fn();
        await a.sync.enableNode('mem://B', true);
        await settle([a, b]);
      };
      // Two nodes make one state at once, each with a path of its own: both kept.
      await apart(async () => {
        await createState(a, 'ui').set('theme', 'dark');
        await tick();
        await createState(b, 'ui').set('language', 'uk');
      });
      assert.deepStrictEqual(await createState(a, 'ui').get(), { theme: 'dark', language: 'uk' });
      assert.deepStrictEqual(await createState(b, 'ui').get(), await createState(a, 'ui').get());
      // A built its settings over time; B, a new device offline at its first launch, sets one: nothing is wiped.
      const onA = createState(a, 'settings');
      await apart(async () => {
        await onA.set('theme', 'dark');
        await onA.set('filters/done', false);
        await onA.set('opened', 7);
        await tick();
        await createState(b, 'settings').set('language', 'uk');
      });
      const settings = { theme: 'dark', filters: { done: false }, opened: 7, language: 'uk' };
      assert.deepStrictEqual(await onA.get(), settings);
      assert.deepStrictEqual(await createState(b, 'settings').get(), settings);
      // delete() empties the state for every node — and a path set after it, on either node, lands and stays.
      const ui = createState(a, 'ui');
      await ui.delete();
      await settle([a, b]);
      assert.deepStrictEqual(await createState(b, 'ui').get(), {});
      await apart(async () => {
        await ui.set('p', 1);
        await tick();
        await createState(b, 'ui').set('q', 2);
      });
      assert.deepStrictEqual(await ui.get(), { p: 1, q: 2 });
      assert.deepStrictEqual(await createState(b, 'ui').get(), { p: 1, q: 2 });
      // A record deleted through the database (a tombstone, which only a whole-record write brings back): the next
      // set makes it again, with that path.
      await a.delete('state.ui');
      await settle([a, b]);
      assert.deepStrictEqual(await ui.get(), {});
      await ui.set('again', true);
      await settle([a, b]);
      assert.deepStrictEqual(await createState(b, 'ui').get(), { again: true });
      // On one node, sets made at once on a state not made yet all land.
      const fresh = createState(a, 'fresh');
      const bump = (n) => (n ?? 0) + 1;
      await Promise.all([fresh.set('a', 1), fresh.set('b', 2), fresh.set('n', bump), fresh.set('n', bump)]);
      assert.deepStrictEqual(await fresh.get(), { a: 1, b: 2, n: 2 });
    },
  );
});
