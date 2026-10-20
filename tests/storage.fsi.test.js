'use strict';

// The storage over an injected backend: nothing touches the disk, a reopen
// over the same memory backend is the same node, `durable` syncs.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs/promises');
const path = require('node:path');
const syncom = require('..');
const nodeFsi = require('../src/fsi.js');
const { createTemp, cleanupTemp } = require('./utils/temp.js');

test('Storage over an injected fsi', async (t) => {
  await t.test('a memory backend: the whole lifecycle, nothing on disk, the same node on reopen', async () => {
    const fsi = syncom.createMemoryFsi();
    const storage = await syncom.open({ path: 'mem-store', fsi, logger: false });
    assert.strictEqual(storage.fsi, fsi);
    const id = await storage.insert({ title: 'Draft' });
    await storage.update(id, { title: 'Final' });
    await storage.inc(id, 'hits');
    assert.deepStrictEqual(await storage.get(id), { title: 'Final', hits: 1 });
    assert.deepStrictEqual(await storage.list(), [id]);
    assert.strictEqual(await storage.validate(), true);
    await storage.sync.addNode({ url: 'mem://peer', scopes: ['*'] });
    const { nodeId, vector } = storage;
    await storage.close();
    assert.strictEqual(
      await fs
        .stat(path.resolve('mem-store'))
        .then(() => true)
        .catch(() => false),
      false,
      'nothing on disk',
    );
    assert.ok(fsi.size > 0);
    assert.ok(Object.keys(fsi.dump()).every((key) => key.startsWith('mem-store/')));

    const reopened = await syncom.open({ path: 'mem-store', fsi, logger: false });
    assert.strictEqual(reopened.nodeId, nodeId);
    assert.deepStrictEqual(reopened.vector, vector);
    assert.deepStrictEqual(await reopened.get(id), { title: 'Final', hits: 1 });
    assert.strictEqual(reopened.sync.listNodes()[0].url, 'mem://peer', 'the registry is in the backend too');
    await reopened.close();
    // Another backend is another world.
    const other = await syncom.open({ path: 'mem-store', fsi: syncom.createMemoryFsi(), logger: false });
    assert.notStrictEqual(other.nodeId, nodeId);
    assert.deepStrictEqual(await other.list(), []);
    await other.close();
  });

  await t.test('the pieces take the backend too', async () => {
    const fsi = syncom.createMemoryFsi();
    const keys = await syncom.loadKeys('k', { fsi });
    assert.deepStrictEqual(await syncom.loadKeys('k', { fsi }), keys, 'the same pair on the second load');
    const chain = await new syncom.Blockchain('c', { fsi });
    await chain.addBlock({ n: 1 });
    assert.strictEqual(await chain.validate(), true);
    const log = await new syncom.OpLog('l', { fsi });
    await log.append([{ origin: 'A', seq: 1, ts: 1, type: 'set', id: 'r', data: {} }]);
    await log.close();
    assert.deepStrictEqual(await fsi.list('l/log/open'), [], 'a close seals the open files');
    assert.ok((await fsi.list('l/log')).some((name) => name.startsWith('seg-')));
    assert.ok((await fsi.list('k')).includes('private.pem'));
    await assert.rejects(async () => new syncom.Blockchain('c', { fsi: {} }), /Blockchain: adapter has no read\(\)/);
  });

  await t.test('a backend without the contract is refused at open, by the method it lacks', async () => {
    await assert.rejects(async () => syncom.open({ fsi: { read() {} } }), {
      name: 'TypeError',
      message: 'open({ fsi }): adapter has no write()',
    });
    await assert.rejects(async () => syncom.open({ fsi: 'opfs' }), /adapter has no read\(\)/);
  });

  await t.test('durable: every write of an insert is synced on node:fs', async (t2) => {
    const dir = await createTemp();
    t2.after(() => cleanupTemp(dir));
    const synced = [];
    const spied = { ...nodeFsi, sync: (d, name) => synced.push(name) && nodeFsi.sync(d, name) };
    const storage = await syncom.open({ path: dir, fsi: spied, durable: true, logger: false });
    assert.notStrictEqual(storage.fsi, spied, 'wrapped');
    assert.strictEqual(typeof storage.fsi.sync, 'function');
    synced.length = 0;
    const id = await storage.insert({ n: 1 });
    // The log batch, the chain block and its tail, the record itself.
    assert.ok(synced.length >= 3, `synced ${synced.length}`);
    assert.ok(synced.includes(`${id}.json`));
    await storage.close();
    // The real sync works on the real files.
    await nodeFsi.sync(path.join(dir, 'data'), `${id}.json`);
  });

  await t.test('durable over a backend without sync is a debug line, not an error', async () => {
    const debug = [];
    const storage = await syncom.open({
      path: 'mem-durable',
      fsi: syncom.createMemoryFsi(),
      durable: true,
      logger: { debug: (entry) => debug.push(entry.event) },
    });
    await storage.insert({ n: 1 });
    assert.ok(debug.includes('durable.noop'));
    await storage.close();
  });
});
