'use strict';

// The local plugin over the lean core with the plugins given by hand — `local` alone: never an op, the store, a
// collection's prefix, the event, observe(); the run over /all (with the mesh) is tests/local.test.js.

const test = require('node:test');
const assert = require('node:assert');
const core = require('../index.js');
const { memory } = require('../src/memory/memory.js');
const { local } = require('../src/local/local.js');

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

test('local documents (lean core, plugins by hand)', async (t) => {
  const db = await core.createDatabase({ path: '/lean', fsi: memory(), defer: 0, logger: false, plugins: [local] });
  t.after(() => db.close().catch(() => {}));
  const events = [];
  db.on('local', (event) => events.push(event.key));
  const id = await db.insert({ a: 1 });
  const logged = db.log.length;
  assert.deepStrictEqual(await db.local.set('layout', { panel: 320 }), { panel: 320 });
  assert.strictEqual(await db.local.set('n', (n) => (n ?? 0) + 1), 1);
  assert.strictEqual(db.log.length, logged, 'never an op');
  assert.deepStrictEqual(await db.list(), [id], 'not in the catalog');
  assert.deepStrictEqual(await db.local.get('layout'), { panel: 320 });
  const seen = [];
  const stop = db.local.observe('n', (value) => seen.push(value));
  await db.local.set('n', 2);
  await db.local.delete('n');
  await tick();
  stop();
  assert.strictEqual(seen[0], 2);
  assert.strictEqual(seen.length, 2, 'the change and the deletion');
  assert.strictEqual(await db.local.get('n'), null);
  assert.deepStrictEqual(events, ['layout', 'n', 'n', 'n']);
  await assert.rejects(db.local.set('bad/key', 1), TypeError);
  // A collection's store is the same under its prefix — the lean core has no collections here, so `scoped()`.
  const scoped = db.local.scoped('Post');
  await scoped.set('filter', { open: true });
  assert.deepStrictEqual(await db.local.get('Post.filter'), { open: true });
  assert.deepStrictEqual(await scoped.get('filter'), { open: true });
});
