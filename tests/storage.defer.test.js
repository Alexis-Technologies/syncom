'use strict';

// open({ defer }): a local write's record file lags the log by at most the
// window — the log is durable at once, reads see every write, tag() and
// close() flush first, a peer's write of the record settles what waited.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs/promises');
const path = require('node:path');
const syncom = require('../src/all/all.js');
const { createTemp, cleanupTemp } = require('./utils/temp.js');

const openTemp = async (t, options = {}) => {
  const dir = await createTemp();
  t.after(() => cleanupTemp(dir));
  const storage = await syncom.open({ path: dir, logger: false, ...options });
  t.after(() => storage.close().catch(() => {}));
  return { dir, storage };
};
const file = async (dir, id) => {
  try {
    return JSON.parse(await fs.readFile(path.join(dir, 'data', `${id}.json`), 'utf8')).data;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('open({ defer }): record files lag the log by the window, never the reads', async (t) => {
  await t.test(
    'writes within the window coalesce into one file and one block; reads see every write at once',
    async (t2) => {
      const { dir, storage } = await openTemp(t2, { defer: 40 });
      const id = await storage.insert({ title: 'doc' });
      for (const ch of 'hello') await storage.push(id, 'body', ch);
      assert.deepStrictEqual(await storage.get(id), { title: 'doc', body: 'hello' }, 'the cache reads every write');
      assert.strictEqual(await file(dir, id), null, 'no file yet');
      assert.deepStrictEqual([storage.stats().deferred, storage.stats().held], [1, 1]);
      assert.strictEqual(storage.log.length, 6, 'six ops in the log already');
      await sleep(120);
      assert.deepStrictEqual(await file(dir, id), { title: 'doc', body: 'hello' }, 'one file, the final state');
      assert.deepStrictEqual([storage.stats().deferred, storage.stats().held], [0, 0]);
      assert.strictEqual(await storage.validate(), true, 'one block covers the six ops');
    },
  );

  await t.test(
    'a writer that never yields to the timers lands its window by count, and the cache stays by its bound',
    async (t2) => {
      const { memory } = require('../src/memory/memory.js');
      // Over memory() every await settles in a microtask: the window's timer never fires inside the loop.
      const storage = await syncom.open({
        path: '/busy',
        fsi: memory(),
        logger: false,
        defer: 16,
        cache: { max: 200 },
      });
      t2.after(() => storage.close().catch(() => {}));
      const id = await storage.insert({});
      let most = { deferred: 0, held: 0, cache: 0 };
      for (let i = 0; i < 3000; i++) {
        await storage.insert({ n: i });
        await storage.splice(id, 'body', i, 0, 'x');
        const { deferred, held, cache } = storage.stats();
        most = {
          deferred: Math.max(most.deferred, deferred),
          held: Math.max(most.held, held),
          cache: Math.max(most.cache, cache.size),
        };
      }
      assert.ok(most.deferred <= 1024, `the window held ${most.deferred} records`);
      assert.ok(most.held <= 1025, `${most.held} held`);
      assert.ok(most.cache <= 200 + 1025, `the cache grew to ${most.cache}`);
      assert.strictEqual((await storage.get(id)).body.length, 3000);
      assert.strictEqual((await storage.list()).length, 3001);
    },
  );

  await t.test('tag() and close() flush first; the file is whole on disk after close', async (t2) => {
    const { dir, storage } = await openTemp(t2, { defer: 10_000 });
    const id = await storage.insert({ n: 1 });
    await storage.update(id, { n: 2 });
    assert.strictEqual(await file(dir, id), null);
    const tag = await storage.tag('t');
    assert.deepStrictEqual(await file(dir, id), { n: 2 }, 'flushed ahead of the tag');
    await storage.update(id, { n: 3 });
    assert.deepStrictEqual(await file(dir, id), { n: 2 }, 'deferred again');
    await storage.close();
    assert.deepStrictEqual(await file(dir, id), { n: 3 }, 'flushed by close');
    const again = await syncom.open({ path: dir, logger: false, defer: 10_000 });
    t2.after(() => again.close().catch(() => {}));
    assert.deepStrictEqual(await again.get(id), { n: 3 });
    assert.deepStrictEqual(
      await again.at('t').get(id),
      { n: 2 },
      'the tag copied the file before the flush changed it',
    );
    assert.deepStrictEqual(again.tags(), [tag]);
  });

  await t.test('a peer’s op on a deferred record writes the file whole and settles what waited', async (t2) => {
    const { dir, storage } = await openTemp(t2, { defer: 60 });
    const id = await storage.insert({ n: 1 });
    await storage.update(id, { local: true });
    assert.strictEqual(await file(dir, id), null);
    const peer = { origin: 'peer', seq: 1, ts: Date.now() + 1, type: 'set', id, data: { peer: true } };
    await storage.applyRemote([peer]);
    const written = await file(dir, id);
    assert.deepStrictEqual(
      written,
      { n: 1, local: true, peer: true },
      'the page wrote the record, local writes included',
    );
    assert.strictEqual(storage.stats().deferred, 0, 'nothing waits any more');
    await sleep(150);
    assert.deepStrictEqual(await file(dir, id), written, 'no older entry was laid over the file');
  });

  await t.test('a write landing while the window flushes keeps its slot: the file ends whole', async (t2) => {
    // Record files take 30 ms to write: the window's flush is still writing
    // the file when later keystrokes land (outside the queue), and their
    // slot must not be settled by a file that does not hold them.
    const node = require('../src/fsi.js');
    const slow = {
      ...node,
      write: async (dir, name, text) => {
        if (dir.endsWith('data')) await sleep(30);
        return node.write(dir, name, text);
      },
    };
    const { dir, storage } = await openTemp(t2, { defer: 20, fsi: slow });
    const id = await storage.insert({ title: 'doc' });
    for (const ch of 'hello') {
      await storage.push(id, 'body', ch);
      await sleep(8);
    }
    await sleep(200);
    assert.deepStrictEqual(await file(dir, id), { title: 'doc', body: 'hello' }, 'every keystroke on disk');
    assert.deepStrictEqual([storage.stats().deferred, storage.stats().held, storage.stats().inflight], [0, 0, 0]);
  });

  await t.test(
    'a flush slower than the window never runs back to back with the next: the window stretches to what it took',
    async (t2) => {
      // A record file takes 40 ms to write, the window is 5: a window armed while a flush was
      // queued or writing fired inside it, and the flushes ran back to back, each with a
      // keystroke or two, each writing the whole record while the writer waited behind it.
      const { memory } = require('../src/memory/memory.js');
      const inner = memory();
      let files = 0;
      const slow = {
        ...inner,
        write: async (dir, name, text) => {
          if (dir.endsWith('/data')) {
            files++;
            await sleep(40);
          }
          return inner.write(dir, name, text);
        },
      };
      const storage = await syncom.open({ path: '/slow', fsi: slow, logger: false, defer: 5 });
      t2.after(() => storage.close().catch(() => {}));
      const id = await storage.insert({ title: 'doc' });
      await storage.flush();
      files = 0;
      for (let i = 0; i < 60; i++) {
        await storage.splice(id, 'body', 0, 0, 'x');
        await sleep(1);
      }
      await storage.flush();
      assert.strictEqual((await storage.get(id)).body.length, 60);
      assert.strictEqual(JSON.parse(await inner.read('/slow/data', `${id}.json`)).data.body.length, 60);
      assert.ok(files <= 10, `${files} record files for 60 keystrokes`);
    },
  );

  await t.test('the option is a non-negative integer of milliseconds', async (t2) => {
    const dir = await createTemp();
    t2.after(() => cleanupTemp(dir));
    assert.throws(() => syncom.open({ path: dir, logger: false, defer: -1 }), TypeError);
    assert.throws(() => syncom.open({ path: dir, logger: false, defer: '50' }), TypeError);
  });
});
