'use strict';

// Tombstone cleanup (src/cleanup/cleanup.js): a folded tombstone still wins
// and pages in a snapshot; nothing folds before every node acknowledged it;
// a reopen reads the folded row; drop forgets it.

const test = require('node:test');
const assert = require('node:assert');
const syncom = require('../src/all/all.js');
const { memory } = require('../src/memory/memory.js');
const { cleanup } = require('../src/cleanup/cleanup.js');
const { SOURCE } = require('../src/symbols.js');
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
      assert.ok(a[SOURCE].row(gone).folded, 'folded');
      assert.strictEqual(a[SOURCE].row(late).folded, undefined, 'awaiting B');
      assert.strictEqual(await fsi.exists(`/A/data`, `${gone}.json`), false, 'the file is gone');
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
      assert.strictEqual(a[SOURCE].row(gone).folded, undefined);
      assert.strictEqual(await fsi.exists(`/A/data`, `${gone}.json`), true);
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
      assert.ok(again[SOURCE].row(late).folded, 'kept across a reopen');
      assert.strictEqual(await again.get(late), null);
      const dropping = cleanup(again, { minimumDeletedTime: 0, awaitSync: false });
      const counts = await dropping.run({ drop: true });
      assert.ok(counts.dropped >= 1);
      assert.strictEqual(again[SOURCE].row(late), null, 'forgotten');
      assert.strictEqual(await again.get(late), null);
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
});
