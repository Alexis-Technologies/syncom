'use strict';

// open({ defer }): a local write's record file lags the log by at most the
// window — the log is durable at once, reads see every write, tag() and
// close() flush first, a peer's write of the record settles what waited.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs/promises');
const path = require('node:path');
const syncom = require('..');
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

  await t.test('the option is a non-negative integer of milliseconds', async (t2) => {
    const dir = await createTemp();
    t2.after(() => cleanupTemp(dir));
    assert.throws(() => syncom.open({ path: dir, logger: false, defer: -1 }), TypeError);
    assert.throws(() => syncom.open({ path: dir, logger: false, defer: '50' }), TypeError);
  });
});
