'use strict';

// The catalog and the cache through the storage, against whichever half
// the caller builds: `createStorage(t, name, options)` gives the SAME
// directory for the same name within one subtest (reopen cases). The
// memory backend is wrapped to count reads, so "no I/O" is a number.

const { createMemoryFsi } = require('../../src/backend.js');

const counting = (fsi) => {
  const reads = [];
  const wrapped = {
    read: (dir, name) => {
      reads.push(`${dir}/${name}`);
      return fsi.read(dir, name);
    },
    write: (dir, name, content) => fsi.write(dir, name, content),
    exists: (dir, name) => fsi.exists(dir, name),
    remove: (dir, name) => fsi.remove(dir, name),
    list: (dir) => fsi.list(dir),
    reads,
    dataReads: () => reads.filter((key) => key.includes('/data/')).length,
    reset: () => void reads.splice(0),
  };
  return wrapped;
};

const runCatalogTests = async (t, assert, createStorage) => {
  const schema = { entities: { Post: { index: ['orgId'], unique: ['slug'] } } };

  await t.test('list() and hasRecord() answer from the catalog, with no read of data/', async (t2) => {
    const fsi = counting(createMemoryFsi());
    const storage = await createStorage(t2, 'A', { fsi, schema });
    const ids = [];
    for (let i = 0; i < 50; i++) ids.push((await storage.Post.insert({ orgId: `o${i % 5}`, slug: `s${i}` })).id);
    for (const id of ids.slice(0, 5)) await storage.delete(id);
    const loose = await storage.insert({ loose: true });
    const sealed = await storage.insert({ secret: true }, { encrypted: true });
    fsi.reset();
    const listed = await storage.list();
    assert.deepStrictEqual(listed, [...ids.slice(5), loose, sealed].sort());
    assert.strictEqual(storage.hasRecord(ids[5]), true);
    assert.strictEqual(storage.hasRecord(ids[0]), false, 'deleted');
    assert.strictEqual(storage.hasRecord(sealed), true, 'encrypted records are listed');
    assert.strictEqual(storage.hasRecord('nope'), false);
    assert.strictEqual(fsi.dataReads(), 0, 'no record was read');
  });

  await t.test(
    'a reopen catches up from the log, and only re-reads what changed since the catalog was saved',
    async (t2) => {
      const fsi = counting(createMemoryFsi());
      let storage = await createStorage(t2, 'A', { fsi, schema, catalog: { flushEvery: 1000 } });
      const ids = [];
      for (let i = 0; i < 20; i++) ids.push((await storage.Post.insert({ orgId: 'o', slug: `s${i}` })).id);
      // Sealed: a reopen replays the unsealed tail, which reads records too.
      await storage.log.flush();
      await storage.close();
      fsi.reset();
      storage = await createStorage(t2, 'A', { fsi, schema, catalog: { flushEvery: 1000 } });
      assert.strictEqual(fsi.dataReads(), 0, 'saved at close: nothing to re-read');
      assert.deepStrictEqual(await storage.list(), [...ids].sort());
      // Two writes that never reach the file (flushEvery is high, no close):
      // the next open reads just those two.
      const more = (await storage.Post.insert({ orgId: 'o', slug: 'late' })).id;
      await storage.update(ids[0], { touched: true });
      await storage.log.flush();
      storage.sync.stop();
      fsi.reset();
      const reopened = await createStorage(t2, 'A', { fsi, schema, catalog: { flushEvery: 1000 }, lock: false });
      assert.strictEqual(fsi.dataReads(), 2);
      assert.strictEqual((await reopened.list()).length, 21);
      assert.strictEqual(reopened.hasRecord(more), true);
      await reopened.close();
      await storage.close();
    },
  );

  await t.test(
    'a catalog the log cannot catch up — foreign stamp, other indexes, absent — is rebuilt from a scan',
    async (t2) => {
      const fsi = counting(createMemoryFsi());
      const debug = [];
      const logger = { debug: (entry) => debug.push(entry.event) };
      let storage = await createStorage(t2, 'A', { fsi, schema, logger });
      for (let i = 0; i < 10; i++) await storage.Post.insert({ orgId: 'o', slug: `s${i}` });
      await storage.close();
      const file = JSON.parse((await fsi.read('store-A/index', 'catalog.json').catch(() => null)) ?? 'null');
      const path = file ? 'store-A' : storage.path;
      const saved = JSON.parse(await fsi.read(`${path}/index`, 'catalog.json'));
      await fsi.write(`${path}/index`, 'catalog.json', JSON.stringify({ ...saved, stamp: 'other-epoch.3' }));
      fsi.reset();
      debug.length = 0;
      storage = await createStorage(t2, 'A', { fsi, schema, logger });
      assert.strictEqual(fsi.dataReads(), 10, 'every record read once');
      assert.ok(debug.includes('catalog.rebuild'));
      assert.strictEqual((await storage.list()).length, 10);
      await storage.close();
      // Other indexes than the file was built with.
      fsi.reset();
      storage = await createStorage(t2, 'A', { fsi, schema: { entities: { Post: { index: ['slug'] } } }, logger });
      assert.strictEqual(fsi.dataReads(), 10);
      await storage.close();
      // No file at all.
      await fsi.remove(`${path}/index`, 'catalog.json');
      fsi.reset();
      storage = await createStorage(t2, 'A', { fsi, schema, logger });
      assert.strictEqual(fsi.dataReads(), 10);
      assert.strictEqual(await fsi.exists(`${path}/index`, 'catalog.json'), true, 'rebuilt and saved');
    },
  );

  await t.test('the catalog follows a peer’s ops, a lens, and a tombstone', async (t2) => {
    const storage = await createStorage(t2, 'A', {
      schema: {
        version: 2,
        entities: { Post: { index: ['name'] } },
        migrations: { 2: { Post: { up: ({ title, ...rest }) => ({ ...rest, name: title }) } } },
      },
    });
    const stamp = (n) => Date.now() + 10_000 + n;
    await storage.applyRemote([
      { origin: 'peer', seq: 1, ts: stamp(1), type: 'write', id: 'old', data: { title: 'x', $type: 'Post' }, v: 1 },
      { origin: 'peer', seq: 2, ts: stamp(2), type: 'write', id: 'gone', data: { title: 'y', $type: 'Post' }, v: 1 },
      { origin: 'peer', seq: 3, ts: stamp(3), type: 'delete', id: 'gone' },
    ]);
    assert.deepStrictEqual(await storage.list(), ['old']);
    assert.strictEqual(storage.hasRecord('gone'), false);
    assert.deepStrictEqual(await storage.get('old'), { name: 'x', $type: 'Post' });
    // The row carries the lensed value: `name`, not `title`.
    await storage.Post.insert({ name: 'x' });
    assert.strictEqual((await storage.list()).length, 2);
  });

  await t.test('the cache is bounded; a live Record pins its entry; absent ids are not cached', async (t2) => {
    const storage = await createStorage(t2, 'A', { cache: { max: 3 } });
    const ids = [];
    for (let i = 0; i < 5; i++) ids.push(await storage.insert({ i }));
    assert.strictEqual(storage.getCachedData(ids[0]), null, 'evicted');
    assert.deepStrictEqual(storage.getCachedData(ids[4]), { i: 4 });
    assert.deepStrictEqual(await storage.get(ids[0]), { i: 0 });
    assert.deepStrictEqual(storage.getCachedData(ids[0]), { i: 0 }, 'back in after a read');
    assert.strictEqual(storage.getCachedData(ids[2]), null, 'the oldest went instead');
    assert.strictEqual(storage.hasRecord(ids[2]), true, 'evicted is not gone');
    const pinned = await storage.record(ids[1]);
    for (let i = 5; i < 12; i++) ids.push(await storage.insert({ i }));
    assert.deepStrictEqual(storage.getCachedData(ids[1]), { i: 1 }, 'pinned by its Record');
    assert.strictEqual(pinned.i, 1);
    assert.strictEqual(await storage.get('nope'), null);
    assert.strictEqual(storage.getCachedData('nope'), null);
    // A string field naming an evicted record is still a reference.
    const referrer = await storage.insert({ to: ids[2] });
    const record = await storage.record(referrer);
    assert.strictEqual(typeof record.to.record, 'function');
    assert.strictEqual((await record.to.record()).i, 2);
    await assert.rejects(() => createStorage(t2, 'B', { cache: { max: 0 } }), /cache.max must be a positive integer/);
    await assert.rejects(() => createStorage(t2, 'B', { catalog: { flushEvery: 'often' } }), /flushEvery must be/);
  });

  await t.test("integrity 'lazy' trusts the file on a cold read; validate() still tells", async (t2) => {
    const fsi = createMemoryFsi();
    let storage = await createStorage(t2, 'A', { fsi });
    const id = await storage.insert({ ok: true });
    await storage.close();
    const dir = `${storage.path}/data`;
    const entry = JSON.parse(await fsi.read(dir, `${id}.json`));
    entry.data = { ok: false };
    await fsi.write(dir, `${id}.json`, JSON.stringify(entry));
    storage = await createStorage(t2, 'A', { fsi, integrity: 'lazy', logger: false });
    assert.deepStrictEqual(await storage.get(id), { ok: false }, 'read as it is');
    assert.strictEqual(await storage.validate(id, entry.data, entry.block), false);
    await storage.close();
    await fsi.remove(`${storage.path}/index`, 'catalog.json');
    const strict = await createStorage(t2, 'A', { fsi, logger: false });
    await assert.rejects(() => strict.get(id), { code: 'INTEGRITY', id, message: /is invalid/ });
    assert.strictEqual(strict.hasRecord(id), false, 'left out of the rebuilt catalog');
    await assert.rejects(() => createStorage(t2, 'B', { integrity: 'trust' }), /integrity must be/);
  });

  await t.test(
    'repair(id) rebuilds a record from its log entries; UNRECOVERABLE when the log has no start',
    async (t2) => {
      const fsi = createMemoryFsi();
      const storage = await createStorage(t2, 'A', { fsi });
      const id = await storage.insert({ title: 'first', hits: 0, $type: 'Post' });
      await storage.update(id, { title: 'second' });
      await storage.inc(id, 'views', 3);
      const gone = await storage.insert({ $type: 'Post', title: 'gone' });
      await storage.delete(gone);
      const purged = await storage.insert({ $type: 'Post', title: 'purged' });
      await storage.purge(purged);
      const expected = await storage.get(id);
      await storage.close();
      // The file is tampered with: the data no longer hashes to its block.
      const dir = `${storage.path}/data`;
      const file = JSON.parse(await fsi.read(dir, `${id}.json`));
      file.data = { title: 'forged' };
      await fsi.write(dir, `${id}.json`, JSON.stringify(file));
      await fsi.write(dir, `${purged}.json`, 'torn{');
      const again = await createStorage(t2, 'A', { fsi, logger: false });
      await assert.rejects(() => again.get(id), { code: 'INTEGRITY' });
      const seen = [];
      const record = await again.record(gone);
      record.on('update', (data) => seen.push(data));
      assert.deepStrictEqual(await again.repair(id), { ops: 3, alive: true }, 'write, set, inc');
      assert.deepStrictEqual(await again.get(id), expected, 'what the log says the record is');
      assert.strictEqual(again.hasRecord(id), true, 'back in the catalog');
      assert.strictEqual(await again.validate(id, expected, JSON.parse(await fsi.read(dir, `${id}.json`)).block), true);
      assert.deepStrictEqual(await again.repair(gone), { ops: 2, alive: false }, 'a tombstone is rebuilt as one');
      assert.deepStrictEqual(seen, [null], 'a live Record hears of it');
      assert.deepStrictEqual(
        await again.repair(purged),
        { ops: 1, alive: false },
        'the purge alone: a scrubbed write is no start',
      );
      assert.strictEqual(await again.get(purged), null);
      assert.deepStrictEqual(await again.list(), [id], 'the catalog lists the rebuilt record alone');
      await assert.rejects(() => again.repair('never-written'), { code: 'UNRECOVERABLE', id: 'never-written' });
      await assert.rejects(() => again.repair('../x'), { code: 'INVALID_ID' });
      const sealed = await again.insert({ secret: 1 }, { encrypted: true });
      await assert.rejects(() => again.repair(sealed), { code: 'UNRECOVERABLE' }, 'no ops for a sealed record');
      await again.close();
      // Compaction took the write: only sets remain, and a set is not a start.
      const short = await createStorage(t2, 'C', { fsi, sync: { log: { rollAfter: 1 }, retention: { ops: 2 } } });
      const shortId = await short.insert({ n: 0 });
      for (let i = 1; i <= 4; i++) await short.update(shortId, { n: i });
      assert.ok(
        short.log.entriesOf(shortId).every(({ op }) => op.type === 'set'),
        'the write was compacted away',
      );
      await assert.rejects(() => short.repair(shortId), {
        code: 'UNRECOVERABLE',
        message: /no whole-record op/,
      });
      assert.deepStrictEqual(await short.get(shortId), { n: 4 }, 'the record itself is untouched');
      await short.close();
    },
  );
};

module.exports = { runCatalogTests };
