'use strict';

// Tombstone cleanup (src/cleanup/cleanup.js): a folded tombstone still wins
// and pages in a snapshot; nothing folds before every node acknowledged it;
// a reopen reads the folded row; drop forgets it.

const test = require('node:test');
const assert = require('node:assert');
const syncom = require('../src/all/all.js');
const { memory } = require('../src/memory/memory.js');
const { cleanup } = require('../src/cleanup/cleanup.js');
const { SOURCE, DB } = require('../src/symbols.js');
const { memoryEngine } = require('../src/memory/engine.js');
const { createMesh, settle } = require('./utils/mesh.js');

test('tombstone cleanup', async (t) => {
  await t.test(
    'a folded tombstone still wins over an older op and pages in a snapshot; nothing folds before every node acknowledged it',
    async (t2) => {
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
      const gone = (await a.Post.insert({ title: 'old' })).id;
      const kept = (await a.Post.insert({ title: 'kept' })).id;
      await settle([a, b]);
      await a.delete(gone);
      await settle([a, b]);
      const sweeper = cleanup(a, { minimumDeletedTime: 0 });
      // Not yet: B is registered and enabled, but the delete is not acknowledged while the link is cut
      // (a node disabled is left out: it bootstraps from a snapshot, which carries a folded tombstone).
      mesh.links.get('mem://B').disconnect();
      const late = (await a.Post.insert({ title: 'later' })).id;
      await a.delete(late);
      assert.deepStrictEqual(
        await sweeper.run(),
        { folded: 1, dropped: 0, skipped: 1 },
        'the acknowledged one folded, the late one not',
      );
      assert.ok(a[SOURCE].folded(gone), 'folded');
      assert.strictEqual(a[SOURCE].row(gone).type, 'Post', 'the row stays a tombstone of its collection');
      assert.strictEqual(a[SOURCE].folded(late), false, 'awaiting B');
      assert.strictEqual(await fsi.exists(`/A/data`, `${gone}.json`), false, 'the file is gone');
      assert.strictEqual(await fsi.exists('/A/tombstones', gone), true, 'the whole tombstone, in the namespace');
      await mesh.links.get('mem://B').reconnect();
      await settle([a, b]);
      assert.deepStrictEqual(await sweeper.run(), { folded: 1, dropped: 0, skipped: 0 });
      // Dead, and read as a tombstone: a late op below the stamp is moot, a snapshot hands it on.
      assert.strictEqual(await a.get(gone), null);
      assert.strictEqual(a.hasRecord(gone), false);
      const entry = await a[SOURCE].entry(gone);
      assert.ok(entry !== null && entry.meta.deleted !== null, 'rebuilt from the row');
      await a.applyRemote([
        { origin: 'peer', seq: 1, ts: entry.meta.deleted[0] - 1, type: 'set', id: gone, data: { title: 'stale' } },
      ]);
      assert.strictEqual(await a.get(gone), null, 'an op below the tombstone is moot');
      const page = await a.snapshot({ limit: 100 });
      const row = page.records.find((record) => record.id === gone);
      assert.deepStrictEqual(row.data, {});
      assert.deepStrictEqual(row.meta.deleted, entry.meta.deleted);
      // A revival above the stamp writes a file again.
      await a.Post.set(gone, { title: 'back' });
      assert.deepStrictEqual(await a.get(gone), { title: 'back', $type: 'Post' });
      assert.strictEqual(a[SOURCE].folded(gone), false);
      assert.strictEqual(await fsi.exists(`/A/data`, `${gone}.json`), true);
      assert.strictEqual(await fsi.exists('/A/tombstones', gone), false, 'the kv entry went with the revival');
      await settle([a, b]);
      assert.deepStrictEqual(await b.get(gone), await a.get(gone));
      // Not old enough: skipped; a live record and the kept one: untouched.
      await a.delete(gone);
      const young = cleanup(a, { minimumDeletedTime: 60_000 });
      assert.deepStrictEqual(await young.run(), { folded: 0, dropped: 0, skipped: 1 });
      assert.deepStrictEqual(await a.get(kept), { title: 'kept', $type: 'Post' });
      // A reopen reads the folded row; drop forgets it.
      await a.close();
      const again = await createStorage(t2, 'A', { lock: false, sync: { autoStart: false } });
      assert.ok(again[SOURCE].folded(late), 'kept across a reopen');
      assert.strictEqual(await again.get(late), null);
      const dropping = cleanup(again, { minimumDeletedTime: 0, awaitSync: false });
      const counts = await dropping.run({ drop: true });
      assert.ok(counts.dropped >= 1);
      assert.strictEqual(again[SOURCE].row(late), null, 'forgotten');
      assert.strictEqual(await again.get(late), null);
      assert.strictEqual(await fsi.exists('/A/tombstones', late), false, 'the kv entry went with the row');
      // The timer, and the arguments.
      dropping.start();
      dropping.start();
      dropping.stop();
      assert.throws(() => cleanup({}), TypeError);
      assert.throws(() => cleanup(again, { minimumDeletedTime: -1 }), TypeError);
      assert.throws(() => cleanup(again, { runEach: 0 }), TypeError);
      await b.close();
    },
  );

  await t.test('a fold is one write set: a failure leaves the file, never a bare row', async (t2) => {
    const inner = memoryEngine();
    let failing = false;
    // The memory engine, its write sets refused while `failing` — before anything of them lands.
    const engine = {
      name: 'memory+failing',
      capabilities: inner.capabilities,
      remove: (path) => inner.remove(path),
      async open(path, options) {
        const db = await inner.open(path, options);
        return {
          ...db,
          write(batch) {
            if (failing && (batch.kv?.put ?? []).some((put) => put[0] === 'tombstones')) {
              return Promise.reject(new Error('disk full'));
            }
            return db.write(batch);
          },
        };
      },
    };
    const schema = { entities: { Post: {} } };
    const db = await syncom.createDatabase({ path: '/f', engine, defer: 0, logger: false, schema });
    t2.after(() => db.close().catch(() => {}));
    const id = (await db.Post.insert({ title: 'x' })).id;
    await db.delete(id, { data: { why: 'gone' } });
    const sweeper = cleanup(db, { minimumDeletedTime: 0, awaitSync: false });
    failing = true;
    await assert.rejects(sweeper.run(), { message: 'disk full' });
    const store = db[DB];
    assert.strictEqual(await store.records.has(id), true, 'the file stays');
    assert.strictEqual(await store.kv.get('tombstones', id), null, 'nothing in the namespace');
    assert.strictEqual(db[SOURCE].row(id).gone, true);
    assert.strictEqual(db[SOURCE].folded(id), false);
    assert.strictEqual(await db.get(id), null);
    failing = false;
    assert.deepStrictEqual(await sweeper.run(), { folded: 1, dropped: 0, skipped: 0 });
    assert.strictEqual(await store.records.has(id), false, 'the file went');
    const kept = JSON.parse(await store.kv.get('tombstones', id));
    assert.strictEqual(kept.type, 'Post');
    assert.deepStrictEqual(kept.data, { why: 'gone', $type: 'Post' }, 'the data the delete carried');
    assert.deepStrictEqual(kept.meta.deleted, db[SOURCE].row(id).deleted);
    assert.strictEqual(await db.get(id), null);
  });

  await t.test(
    'a folded tombstone keeps its whole meta: an unset watermark above the delete and the tombstone’s data converge with an unfolded peer',
    async (t2) => {
      const schema = { entities: { Post: {} } };
      const openAt = async (path) => {
        const db = await syncom.createDatabase({ path, fsi: memory(), defer: 0, logger: false, schema });
        t2.after(() => db.close().catch(() => {}));
        return db;
      };
      const folding = await openAt('/folding');
      const plain = await openAt('/plain');
      const id = 'post-1';
      const base = Date.now() + 1_000;
      // A peer's record, deleted with data, then a field unset ABOVE the delete: the watermark outlives the record.
      const history = [
        { origin: 'peer', seq: 1, ts: base, type: 'write', id, data: { $type: 'Post', x: 'before', y: 1 }, v: 1 },
        { origin: 'peer', seq: 2, ts: base + 10, type: 'delete', id, data: { why: 'gone' } },
        { origin: 'peer', seq: 3, ts: base + 30, type: 'unset', id, value: ['x'] },
      ];
      await folding.applyRemote(history);
      await plain.applyRemote(history);
      const sweeper = cleanup(folding, { minimumDeletedTime: 0, awaitSync: false, now: () => base + 1_000 });
      assert.deepStrictEqual(await sweeper.run(), { folded: 1, dropped: 0, skipped: 0 });
      assert.ok(folding[SOURCE].folded(id));
      // A late op below the watermark but above the delete: moot on both, or the folded node would revive the record.
      const late = [{ origin: 'other', seq: 1, ts: base + 20, type: 'set', id, data: { x: 'late' } }];
      await folding.applyRemote(late);
      await plain.applyRemote(late);
      assert.strictEqual(await plain.get(id), null, 'the unfolded peer');
      assert.strictEqual(await folding.get(id), null, 'the folded node agrees');
      const theirs = await plain[SOURCE].entry(id);
      const mine = await folding[SOURCE].entry(id);
      assert.deepStrictEqual(mine.meta, theirs.meta, 'the whole meta, watermark included');
      assert.deepStrictEqual(mine.data, theirs.data, 'the data the delete carried');
      assert.strictEqual(mine.data.why, 'gone');
      // A snapshot page hands the tombstone on whole.
      const page = await folding.snapshot({ limit: 10 });
      const row = page.records.find((record) => record.id === id);
      assert.deepStrictEqual(row.meta, theirs.meta);
      assert.strictEqual(row.data.why, 'gone');
    },
  );
});
