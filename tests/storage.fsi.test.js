'use strict';

// Files land at once here (`defer: 0`): what these tests read of the disk is the engine's, not the window's — the window has tests of its own (storage.defer, storage.group).

// The storage over an injected backend: nothing touches the disk, a reopen
// over the same memory backend is the same node, `durable` syncs.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs/promises');
const path = require('node:path');
const syncom = require('../src/all/all.js');
const nodeFsi = require('../src/fsi.js');
const { createTemp, cleanupTemp } = require('./utils/temp.js');
const { memory } = require('../src/memory/memory.js');

test('Storage over an injected fsi', async (t) => {
  await t.test('a memory backend: the whole lifecycle, nothing on disk, the same node on reopen', async () => {
    const fsi = memory();
    const storage = await syncom.open({ defer: 0, path: 'mem-store', fsi, logger: false });
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

    const reopened = await syncom.open({ defer: 0, path: 'mem-store', fsi, logger: false });
    assert.strictEqual(reopened.nodeId, nodeId);
    assert.deepStrictEqual(reopened.vector, vector);
    assert.deepStrictEqual(await reopened.get(id), { title: 'Final', hits: 1 });
    assert.strictEqual(reopened.sync.listNodes()[0].url, 'mem://peer', 'the registry is in the backend too');
    await reopened.close();
    // Another backend is another world.
    const other = await syncom.open({ defer: 0, path: 'mem-store', fsi: memory(), logger: false });
    assert.notStrictEqual(other.nodeId, nodeId);
    assert.deepStrictEqual(await other.list(), []);
    await other.close();
  });

  await t.test('the pieces take the backend too', async () => {
    const fsi = memory();
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
    await assert.rejects(async () => syncom.open({ defer: 0, fsi: { read() {} } }), {
      name: 'TypeError',
      message: 'open({ fsi }): adapter has no write()',
    });
    await assert.rejects(async () => syncom.open({ defer: 0, fsi: 'opfs' }), /adapter has no read\(\)/);
  });

  await t.test('durable: every write of an insert is synced on node:fs', async (t2) => {
    const dir = await createTemp();
    t2.after(() => cleanupTemp(dir));
    const synced = [];
    const spied = { ...nodeFsi, sync: (d, name) => synced.push(name) && nodeFsi.sync(d, name) };
    const storage = await syncom.open({ defer: 0, path: dir, fsi: spied, durable: true, logger: false });
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
      defer: 0,
      path: 'mem-durable',
      fsi: memory(),
      durable: true,
      logger: { debug: (entry) => debug.push(entry.event) },
    });
    await storage.insert({ n: 1 });
    assert.ok(debug.includes('durable.noop'));
    await storage.close();
  });
});

test('A backend that fails after the log append', async (t) => {
  // A memory backend whose record files can be made to fail, as a full disk
  // or a browser quota would; everything else keeps working.
  const flakyFsi = () => {
    const fsi = memory();
    const control = { failing: false };
    const wrapped = {
      read: (dir, name) => fsi.read(dir, name),
      exists: (dir, name) => fsi.exists(dir, name),
      remove: (dir, name) => fsi.remove(dir, name),
      create: (dir, name, content) => fsi.create(dir, name, content),
      list: (dir) => fsi.list(dir),
      async write(dir, name, content) {
        if (control.failing && dir.endsWith('/data')) {
          throw Object.assign(new Error('The quota has been exceeded'), { name: 'QuotaExceededError' });
        }
        return fsi.write(dir, name, content);
      },
    };
    return { fsi: wrapped, inner: fsi, control };
  };

  await t.test('the write stands, is read back from memory, and lands at the next open', async () => {
    const { fsi, inner, control } = flakyFsi();
    const storage = await syncom.open({ defer: 0, path: 'flaky', fsi, logger: false, cache: { max: 1 } });
    const errors = [];
    storage.on('error', (error) => errors.push(error));
    const id = await storage.insert({ n: 1 });
    control.failing = true;
    await storage.update(id, { n: 2 });
    assert.strictEqual(errors.length, 1);
    assert.strictEqual(errors[0].code, 'UNPERSISTED');
    assert.deepStrictEqual(errors[0].ids, [id]);
    assert.strictEqual(errors[0].cause.name, 'QuotaExceededError');
    // Held in the cache, past its size: reads see what the log says.
    control.failing = false;
    await storage.insert({ other: 1 });
    await storage.insert({ other: 2 });
    assert.deepStrictEqual(await storage.get(id), { n: 2 });
    assert.strictEqual(JSON.parse(await inner.read('flaky/data', `${id}.json`)).data.n, 1, 'the file is behind');
    await storage.close();
    // The batch was left unapplied: the reopen replays it onto the file.
    const reopened = await syncom.open({ defer: 0, path: 'flaky', fsi, logger: false });
    assert.deepStrictEqual(await reopened.get(id), { n: 2 });
    assert.strictEqual(JSON.parse(await inner.read('flaky/data', `${id}.json`)).data.n, 2);
    await reopened.close();
  });

  await t.test("a peer's batch whose files fail is held the same way", async () => {
    const { fsi, control } = flakyFsi();
    const storage = await syncom.open({ defer: 0, path: 'flaky-peer', fsi, logger: false });
    const errors = [];
    storage.on('error', (error) => errors.push(error));
    control.failing = true;
    const op = { origin: 'peer', seq: 1, ts: Date.now(), type: 'write', id: 'r1', data: { n: 1 } };
    const result = await storage.applyRemote([op]);
    assert.strictEqual(result.applied, 1);
    assert.strictEqual(errors[0].code, 'UNPERSISTED');
    assert.deepStrictEqual(await storage.get('r1'), { n: 1 });
    control.failing = false;
    await storage.close();
    const reopened = await syncom.open({ defer: 0, path: 'flaky-peer', fsi, logger: false });
    assert.deepStrictEqual(await reopened.get('r1'), { n: 1 });
    await reopened.close();
  });

  await t.test('a torn record file is an INTEGRITY error, and repair(id) rebuilds it', async () => {
    const shared = memory();
    const storage = await syncom.open({ defer: 0, path: 'torn', fsi: shared, logger: false, cache: { max: 1 } });
    const id = await storage.insert({ n: 1 });
    await storage.insert({ other: true });
    await shared.write('torn/data', `${id}.json`, '{"data":{"n":');
    await assert.rejects(
      () => storage.get(id),
      (error) => {
        assert.ok(error instanceof syncom.SyncomError);
        assert.strictEqual(error.code, 'INTEGRITY');
        assert.strictEqual(error.id, id);
        assert.ok(error.cause instanceof SyntaxError);
        return true;
      },
    );
    await assert.rejects(() => storage.has(id), { code: 'INTEGRITY' });
    await shared.write('torn/data', `${id}.json`, 'null');
    await assert.rejects(() => storage.get(id), { code: 'INTEGRITY' });
    await storage.repair(id);
    assert.deepStrictEqual(await storage.get(id), { n: 1 });
    await storage.close();
  });
});
