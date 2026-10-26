'use strict';

// The backend contract in isolation: the memory adapter passes the same
// suite as node:fs and OPFS, `isFsi` reads the shape, `withSync` is what
// `durable` wraps a backend in.

const test = require('node:test');
const assert = require('node:assert');
const { isFsi, checkFsi, withSync } = require('../src/backend.js');
const { runFsiTests } = require('./suites/fsi.js');
const { memory } = require('../src/memory/memory.js');

test('memory()', async (t) => {
  let n = 0;
  await runFsiTests(t, memory(), {
    getRoot: async () => `mem-${n++}`,
    joinPath: (root, ...parts) => [root, ...parts].join('/'),
  });

  await t.test('size and dump; content is kept as text', async () => {
    const fsi = memory();
    await fsi.write('a', 'x.json', '{"n":1}');
    await fsi.write('a/b', 'y.txt', 'y');
    await fsi.write('a', 'x.json', 42);
    assert.strictEqual(fsi.size, 2);
    assert.deepStrictEqual(fsi.dump(), { 'a/x.json': '42', 'a/b/y.txt': 'y' });
    assert.deepStrictEqual(await fsi.list('a'), ['x.json']);
    const error = await fsi.read('a', 'nope').catch((e) => e);
    assert.strictEqual(error.code, 'ENOENT');
    assert.match(error.message, /a\/nope/);
  });
});

test('isFsi and checkFsi', async (t) => {
  await t.test('the five functions, by name', () => {
    const fsi = memory();
    assert.strictEqual(isFsi(fsi), true);
    assert.strictEqual(isFsi(withSync({ ...fsi, sync: async () => {} })), true);
    for (const value of [null, undefined, 'fs', 42, {}, []]) assert.strictEqual(isFsi(value), false, String(value));
    for (const name of ['read', 'write', 'exists', 'remove', 'list']) {
      const broken = { read() {}, write() {}, exists() {}, remove() {}, list() {}, [name]: 'nope' };
      assert.strictEqual(isFsi(broken), false);
      assert.throws(() => checkFsi(broken, 'open({ fsi })'), {
        name: 'TypeError',
        message: `open({ fsi }): adapter has no ${name}()`,
      });
    }
    assert.throws(() => checkFsi(null, 'Blockchain'), { message: 'Blockchain: adapter has no read()' });
    assert.strictEqual(checkFsi(fsi, 'x'), fsi);
  });
});

test('withSync', async (t) => {
  await t.test('every write is followed by sync; the rest passes through', async () => {
    const calls = [];
    const inner = memory();
    const spied = {
      read: (...args) => inner.read(...args),
      write: (...args) => inner.write(...args),
      exists: (...args) => inner.exists(...args),
      remove: (...args) => inner.remove(...args),
      list: (...args) => inner.list(...args),
      sync: async (dir, name) => void calls.push(['sync', dir, name]),
    };
    const durable = withSync(spied);
    await durable.write('d', 'f', 'content');
    assert.deepStrictEqual(calls, [['sync', 'd', 'f']]);
    assert.strictEqual(await durable.read('d', 'f'), 'content');
    assert.strictEqual(await durable.exists('d', 'f'), true);
    assert.deepStrictEqual(await durable.list('d'), ['f']);
    await durable.sync('d', 'f');
    await durable.remove('d', 'f');
    assert.strictEqual(await durable.exists('d', 'f'), false);
    assert.strictEqual(calls.length, 2);
    // A failing sync fails the write.
    spied.sync = async () => {
      throw new Error('disk full');
    };
    await assert.rejects(() => durable.write('d', 'g', 'x'), /disk full/);
  });

  await t.test('an append is followed by sync too; a backend without append gets none', async () => {
    const calls = [];
    const inner = memory();
    const durable = withSync({ ...inner, sync: async (dir, name) => void calls.push([dir, name]) });
    await durable.append('d', 'j.jsonl', 'a\n');
    await durable.append('d', 'j.jsonl', 'b\n');
    assert.strictEqual(await durable.read('d', 'j.jsonl'), 'a\nb\n');
    assert.deepStrictEqual(calls, [
      ['d', 'j.jsonl'],
      ['d', 'j.jsonl'],
    ]);
    const { append, ...withoutAppend } = inner;
    assert.strictEqual(withSync({ ...withoutAppend, sync: async () => {} }).append, undefined);
  });
});
