'use strict';

// Local documents (src/local/local.js): never an op — not in the log, the
// catalog, a snapshot or at a peer; the store, the collection's prefix, the
// event, observe(), toStore().

const test = require('node:test');
const assert = require('node:assert');
const syncom = require('../src/all/all.js');
const { memory } = require('../src/memory/memory.js');
const { toStore } = require('../src/store/store.js');
const { createMesh, settle } = require('./utils/mesh.js');

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

test('local documents', async (t) => {
  await t.test('a local document is never an op: not in the log, the catalog, a snapshot, or at a peer', async (t2) => {
    const fsi = memory();
    const schema = { entities: { Post: {} } };
    const createStorage = async (t3, name, options = {}) => {
      const db = await syncom.createDatabase({ path: `/${name}`, fsi, defer: 0, logger: false, schema, ...options });
      t3.after(() => db.close().catch(() => {}));
      return db;
    };
    const mesh = await createMesh(t2, ['A', 'B'], [['A', 'B']], createStorage);
    const a = mesh.get('A');
    const b = mesh.get('B');
    await a.Post.insert({ title: 'p' });
    await settle([a, b]);
    const logged = a.log.length;
    const events = [];
    a.on('local', (event) => events.push(event));
    assert.deepStrictEqual(await a.local.set('layout', { panel: 320 }), { panel: 320 });
    await a.local.set('draft', 'hello');
    await a.Post.local.set('filter', { open: true });
    assert.strictEqual(a.log.length, logged, 'no op');
    assert.deepStrictEqual(await a.list(), await b.list(), 'no record');
    assert.strictEqual((await a.snapshot({ limit: 100 })).records.length, 1, 'no snapshot record');
    await settle([a, b]);
    assert.strictEqual(await b.local.get('layout'), null, 'never at a peer');
    assert.deepStrictEqual(await a.local.get('layout'), { panel: 320 });
    assert.deepStrictEqual(await a.local.list(), ['Post.filter', 'draft', 'layout']);
    assert.deepStrictEqual(await a.Post.local.list(), ['filter']);
    assert.deepStrictEqual(await a.Post.local.get('filter'), { open: true });
    assert.strictEqual((await a.local.get('Post.filter')) !== null, true, 'a collection prefixes its keys');
    assert.deepStrictEqual(events, [
      { key: 'layout', value: { panel: 320 } },
      { key: 'draft', value: 'hello' },
      { key: 'Post.filter', value: { open: true } },
    ]);
    // Observed, as a store; deleted.
    const seen = [];
    const stop = a.local.observe('draft', (value) => seen.push(value));
    const store = toStore(a.local, 'layout');
    const snapshots = [];
    const unsubscribe = store.subscribe((value) => snapshots.push(value));
    await tick();
    await a.local.set('draft', 'again');
    await a.local.set('layout', { panel: 100 });
    await a.local.delete('draft');
    await a.local.delete('nope');
    await tick();
    assert.deepStrictEqual(seen, ['again', null]);
    assert.deepStrictEqual(snapshots, [undefined, { panel: 320 }, { panel: 100 }]);
    stop();
    unsubscribe();
    await a.local.set('draft', 'silent');
    assert.deepStrictEqual(seen, ['again', null]);
    // The changes of one key go one at a time: read-modify-writes made at once compose; a function that answers
    // nothing leaves the document as it is.
    const bump = (n) => (n ?? 0) + 1;
    await Promise.all([a.local.set('n', bump), a.local.set('n', bump), a.local.set('n', bump)]);
    assert.strictEqual(await a.local.get('n'), 3);
    assert.strictEqual(await a.local.set('n', () => undefined), 3);
    assert.strictEqual(await a.local.get('n'), 3);
    // An observer that throws is contained: the others hear, the event fires, the write stands.
    const stopThrowing = a.local.observe('n', () => {
      throw new Error('boom');
    });
    const heard = [];
    const stopHearing = a.local.observe('n', (value) => heard.push(value));
    const before = events.length;
    await a.local.set('n', 4);
    assert.deepStrictEqual(heard, [4]);
    assert.strictEqual(events.length, before + 1);
    assert.strictEqual(await a.local.get('n'), 4);
    stopThrowing();
    stopHearing();
    // A document that does not parse is CORRUPT, with its key.
    await fsi.write('/A/local', 'bad', '{oops');
    await assert.rejects(a.local.get('bad'), { code: 'CORRUPT', key: 'bad' });
    // Kept across a reopen; swept by drop().
    await a.close();
    const again = await syncom.createDatabase({ path: '/A', fsi, defer: 0, logger: false, schema, lock: false });
    assert.deepStrictEqual(await again.local.get('layout'), { panel: 100 });
    assert.strictEqual(await again.local.get('draft'), 'silent');
    await again.drop();
    const fresh = await syncom.createDatabase({ path: '/A', fsi, defer: 0, logger: false, schema });
    assert.strictEqual(await fresh.local.get('layout'), null);
    await fresh.close();
    // The arguments: a kv key, a JSON value.
    await assert.rejects(b.local.set('a/b', 1), TypeError);
    await assert.rejects(b.local.set('k', undefined), TypeError);
    await assert.rejects(
      b.local.set('k', () => null),
      TypeError,
    );
    assert.strictEqual(await b.local.set('k', () => 1), 1);
    assert.throws(() => b.local.observe('k', 'nope'), TypeError);
    assert.throws(() => b.local.scoped('a/b'), TypeError);
  });

  await t.test('without the plugin, db.local is PLUGIN_MISSING', async (t2) => {
    const core = require('../index.js');
    const db = await core.createDatabase({ fsi: memory(), path: '/c', logger: false, defer: 0 });
    t2.after(() => db.close());
    assert.throws(() => db.local, { code: 'PLUGIN_MISSING' });
  });
});
