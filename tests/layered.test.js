'use strict';

// One backend over several (@alexify/syncom/layered): a read is the first
// hit top down, filled upward; a write lands on every layer in list order,
// through or from the write-back queue; the lock is exclusive across the
// layers; and the backend contract holds through the stack.

const test = require('node:test');
const assert = require('node:assert');
const core = require('../index.js');
const nodeFsi = require('../src/fsi.js');
const { memory } = require('../src/memory/memory.js');
const { layered } = require('../src/layered/layered.js');
const { runFsiTests } = require('./suites/fsi.js');
const { createTemp, cleanupTemp } = require('./utils/temp.js');

// The five functions over a memory backend, with what the test adds.
const over = (inner, extra = {}) => ({
  read: (dir, name) => inner.read(dir, name),
  write: (dir, name, content) => inner.write(dir, name, content),
  exists: (dir, name) => inner.exists(dir, name),
  remove: (dir, name) => inner.remove(dir, name),
  list: (dir) => inner.list(dir),
  ...extra,
});

// A memory layer whose writes and removals wait for a gate: what a slow
// disk is to the write-back queue.
const gated = () => {
  const inner = memory();
  let gate = Promise.resolve();
  let release = () => {};
  const fsi = over(inner, {
    async write(dir, name, content) {
      await gate;
      await inner.write(dir, name, content);
    },
    async remove(dir, name) {
      await gate;
      await inner.remove(dir, name);
    },
  });
  return {
    fsi,
    inner,
    hold: () => {
      gate = new Promise((resolve) => (release = resolve));
    },
    release: () => release(),
  };
};

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

test('layered backends', async (t) => {
  await t.test(
    'through: a write lands on every layer in order, a read is the first hit filled upward, list is the union',
    async () => {
      const top = memory();
      const bottom = memory();
      const fsi = layered([top, bottom]);
      assert.deepStrictEqual(fsi.layers, [top, bottom]);
      await fsi.write('d', 'a.json', '1');
      assert.deepStrictEqual([top.dump(), bottom.dump()], [{ 'd/a.json': '1' }, { 'd/a.json': '1' }]);
      // Below only: the read answers from there and fills the top.
      await bottom.write('d', 'b.json', '2');
      assert.strictEqual(await top.exists('d', 'b.json'), false);
      assert.strictEqual(await fsi.exists('d', 'b.json'), true);
      assert.strictEqual(await fsi.read('d', 'b.json'), '2');
      assert.strictEqual(await top.read('d', 'b.json'), '2');
      // The first hit answers: the top over a stale bottom.
      await top.write('d', 'a.json', '3');
      assert.strictEqual(await fsi.read('d', 'a.json'), '3');
      await bottom.write('d', 'c.json', '4');
      assert.deepStrictEqual(await fsi.list('d'), ['a.json', 'b.json', 'c.json']);
      await fsi.remove('d', 'a.json');
      assert.deepStrictEqual([await top.exists('d', 'a.json'), await bottom.exists('d', 'a.json')], [false, false]);
      await assert.rejects(() => fsi.read('d', 'a.json'), { code: 'ENOENT' });
      assert.strictEqual(await fsi.exists('d', 'a.json'), false);
      // fill: false reads from below without copying.
      const cold = layered([memory(), bottom], { fill: false });
      assert.strictEqual(await cold.read('d', 'c.json'), '4');
      assert.strictEqual(await cold.layers[0].exists('d', 'c.json'), false);
      assert.strictEqual(fsi.pending, 0);
      assert.strictEqual(fsi.sync, undefined, 'no layer syncs');
      await fsi.flush();
    },
  );

  await t.test(
    'create is exclusive across layers: a file on the disk below is a lock, whatever the memory holds',
    async () => {
      const top = memory();
      const bottom = memory();
      const fsi = layered([top, bottom]);
      await bottom.write('d', 'lock.json', 'stale');
      await assert.rejects(() => fsi.create('d', 'lock.json', 'mine'), { code: 'EEXIST' });
      assert.strictEqual(await top.exists('d', 'lock.json'), false, 'nothing written above');
      await fsi.remove('d', 'lock.json');
      await fsi.create('d', 'lock.json', 'mine');
      assert.deepStrictEqual([await top.read('d', 'lock.json'), await bottom.read('d', 'lock.json')], ['mine', 'mine']);
      await assert.rejects(() => fsi.create('d', 'lock.json', 'again'), { code: 'EEXIST' });
      // A layer without create is written to.
      const plain = over(bottom);
      const stack = layered([memory(), plain]);
      await stack.create('d', 'other.json', 'x');
      assert.strictEqual(await bottom.read('d', 'other.json'), 'x');
      await assert.rejects(() => stack.create('d', 'other.json', 'y'), { code: 'EEXIST' });
    },
  );

  await t.test(
    'back: a write resolves when the top has it, the rest land from the queue; flush awaits it; nothing stale is read from below',
    async () => {
      const top = memory();
      const slow = gated();
      const fsi = layered([top, slow.fsi], { write: 'back', queue: 1 });
      slow.hold();
      await fsi.write('d', 'a.json', '1');
      await fsi.write('d', 'b.json', '2');
      assert.deepStrictEqual(top.dump(), { 'd/a.json': '1', 'd/b.json': '2' });
      assert.strictEqual(slow.inner.size, 0, 'the disk has nothing yet');
      assert.strictEqual(fsi.pending, 2, 'one running, one waiting');
      // The queue is full (queue: 1): the next write waits for room.
      let third = false;
      const writing = fsi.write('d', 'c.json', '3').then(() => (third = true));
      await tick();
      assert.strictEqual(third, false);
      // A read that hits the top never waits.
      assert.strictEqual(await fsi.read('d', 'a.json'), '1');
      slow.release();
      await writing;
      await fsi.flush();
      assert.strictEqual(fsi.pending, 0);
      assert.deepStrictEqual(slow.inner.dump(), { 'd/a.json': '1', 'd/b.json': '2', 'd/c.json': '3' });
      // A removal queued behind: the bottom still has the file, and a read,
      // an exists or a list must not answer from it.
      slow.hold();
      await fsi.remove('d', 'a.json');
      assert.strictEqual(await slow.inner.exists('d', 'a.json'), true);
      const reading = fsi.read('d', 'a.json').then(
        () => 'read',
        (error) => error.code,
      );
      const existing = fsi.exists('d', 'a.json');
      const listing = fsi.list('d');
      await tick();
      slow.release();
      assert.deepStrictEqual([await reading, await existing, await listing], ['ENOENT', false, ['b.json', 'c.json']]);
      await fsi.flush();
    },
  );

  await t.test(
    'back: a queued call that failed is reported by flush, once; close flushes and closes the layers that close',
    async () => {
      const top = memory();
      let closed = 0;
      const failing = over(memory(), {
        async write() {
          throw new Error('disk full');
        },
        async close() {
          closed++;
        },
      });
      const fsi = layered([top, failing], { write: 'back' });
      await fsi.write('d', 'a.json', '1');
      assert.strictEqual(await top.read('d', 'a.json'), '1', 'the write stood at the top');
      await assert.rejects(() => fsi.flush(), { message: 'disk full' });
      await fsi.flush();
      await fsi.close();
      assert.strictEqual(closed, 1);
    },
  );

  await t.test(
    'back: every queued failure is told to onError and counted; a read that waits for the queue never throws one',
    async () => {
      const top = memory();
      const bottom = memory();
      let failing = true;
      const flaky = over(bottom, {
        async write(dir, name, content) {
          if (failing) throw new Error(`disk full: ${name}`);
          return bottom.write(dir, name, content);
        },
      });
      const told = [];
      const fsi = layered([top, flaky], { write: 'back', onError: (error) => told.push(error.message) });
      await fsi.write('d', 'a.json', '1');
      await fsi.write('d', 'b.json', '2');
      // A miss at the top waits for the queue — and reads, whatever the queue's failures.
      await assert.rejects(() => fsi.read('d', 'none.json'), { code: 'ENOENT' });
      assert.strictEqual(await fsi.exists('d', 'a.json'), true);
      assert.deepStrictEqual(await fsi.list('d'), ['a.json', 'b.json']);
      assert.deepStrictEqual(told, ['disk full: a.json', 'disk full: b.json'], 'each failure told');
      assert.strictEqual(fsi.failed, 2);
      // flush() is the call that promises the lower layers: it reports the first.
      await assert.rejects(() => fsi.flush(), { message: 'disk full: a.json' });
      failing = false;
      await fsi.write('d', 'c.json', '3');
      await fsi.flush();
      assert.strictEqual(await bottom.read('d', 'c.json'), '3');
      assert.throws(() => layered([memory()], { onError: 1 }), TypeError);
    },
  );

  await t.test(
    'append lands on every layer; a file only below is copied up first; none unless every layer has it',
    async () => {
      const top = memory();
      const bottom = memory();
      await bottom.write('d', 'j.jsonl', 'head\n');
      const fsi = layered([top, bottom], { write: 'back' });
      await fsi.append('d', 'j.jsonl', 'tail\n');
      await fsi.flush();
      assert.strictEqual(await top.read('d', 'j.jsonl'), 'head\ntail\n', 'the head came up before the tail');
      assert.strictEqual(await bottom.read('d', 'j.jsonl'), 'head\ntail\n');
      await fsi.append('d', 'new.jsonl', 'a\n');
      await fsi.flush();
      assert.deepStrictEqual([await top.read('d', 'new.jsonl'), await bottom.read('d', 'new.jsonl')], ['a\n', 'a\n']);
      assert.strictEqual(layered([memory(), over(memory())]).append, undefined, 'a layer without append: none');
    },
  );

  await t.test('sync reaches every layer that has one; the options are checked', async () => {
    const synced = [];
    const withSync = over(memory(), { sync: async (dir, name) => void synced.push(`${dir}/${name}`) });
    const fsi = layered([memory(), withSync], { write: 'back' });
    assert.strictEqual(typeof fsi.sync, 'function');
    await fsi.write('d', 'a.json', '1');
    await fsi.sync('d', 'a.json');
    assert.deepStrictEqual(synced, ['d/a.json']);
    assert.strictEqual(fsi.pending, 0, 'sync drained the queue first');
    assert.throws(() => layered([]), { name: 'TypeError', message: 'layered() takes an array of one backend or more' });
    assert.throws(() => layered(memory()), { name: 'TypeError' });
    assert.throws(() => layered([memory(), {}]), { message: 'layered() layer 1: adapter has no read()' });
    assert.throws(() => layered([memory()], null), { message: 'layered() takes an options object' });
    assert.throws(() => layered([memory()], { write: 'sideways' }), {
      message: "layered(): write must be 'through' or 'back'",
    });
    assert.throws(() => layered([memory()], { fill: 'yes' }), { message: 'layered(): fill must be a boolean' });
    assert.throws(() => layered([memory()], { queue: 0 }), { message: 'layered(): queue must be a positive integer' });
  });

  await t.test(
    'a storage over a memory layer ahead of the disk: what lands below reopens alone, a fresh top fills on read',
    async (t2) => {
      const dir = await createTemp();
      t2.after(() => cleanupTemp(dir));
      const top = memory();
      const fsi = layered([top, nodeFsi], { write: 'back' });
      const storage = await core.open({ path: dir, fsi, logger: false });
      const id = await storage.insert({ title: 'Layered' });
      await storage.close();
      await fsi.flush();
      // The disk alone has everything, the lock released among it.
      const alone = await core.open({ path: dir, logger: false });
      assert.deepStrictEqual(await alone.get(id), { title: 'Layered' });
      assert.strictEqual(alone.nodeId, storage.nodeId);
      await alone.close();
      // A fresh memory top over the same disk: the reads fill it.
      const fresh = memory();
      const again = await core.open({ path: dir, fsi: layered([fresh, nodeFsi]), logger: false });
      assert.deepStrictEqual(await again.get(id), { title: 'Layered' });
      assert.ok(fresh.size > 0, 'filled on read');
      assert.strictEqual(again.nodeId, storage.nodeId);
      await again.close();
    },
  );

  // The contract holds through two memory layers, through the queue, and
  // over the disk.
  let n = 0;
  const join = (root, ...parts) => [root, ...parts].join('/');
  await runFsiTests(t, layered([memory(), memory()]), { getRoot: async () => `two-${n++}`, joinPath: join });
  await runFsiTests(t, layered([memory(), memory()], { write: 'back' }), {
    getRoot: async () => `back-${n++}`,
    joinPath: join,
  });
  await runFsiTests(t, layered([memory(), nodeFsi]), { getRoot: createTemp, afterEach: cleanupTemp });
});
