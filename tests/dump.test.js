'use strict';

// Dumps (src/dump/dump.js): export → import as a merge gives a node what the
// source holds, record by record and tombstone by tombstone; insert keeps
// the ids and makes new ops; a dump under another schema is refused;
// migrateStorage moves a database between engines as the same node (copy)
// or into a new one (merge).

const test = require('node:test');
const assert = require('node:assert');
const syncom = require('../src/all/all.js');
const { memory, memoryEngine } = require('../src/memory/memory.js');
const { exportJSON, exportPages, importJSON, migrateStorage } = require('../src/dump/dump.js');
const { SOURCE } = require('../src/symbols.js');

const schema = { entities: { Post: { index: ['kind'] }, Tag: {} } };
const openAt = async (t, path, options = {}) => {
  const db = await syncom.createDatabase({ path, fsi: memory(), defer: 0, logger: false, schema, ...options });
  t.after(() => db.close().catch(() => {}));
  return db;
};

test('dumps', async (t) => {
  await t.test(
    'export then import (merge) on an empty node equals the source, record by record and tombstone by tombstone',
    async (t2) => {
      const source = await openAt(t2, '/s');
      const ids = [];
      for (let i = 0; i < 12; i++) ids.push((await source.Post.insert({ kind: i % 2 ? 'a' : 'b', n: i })).id);
      await source.inc(ids[0], 'hits', 3);
      await source.add(ids[1], 'tags', ['x', 'y']);
      await source.push(ids[2], 'body', 'hello');
      await source.treeMove(ids[3], 'outline', 'r');
      await source.Tag.insert({ name: 't' });
      await source.delete(ids[4], { data: { why: 'gone' } });
      await source.purge(ids[5]);
      const dump = await exportJSON(source);
      assert.strictEqual(dump.format, 1);
      assert.strictEqual(dump.node, source.nodeId);
      assert.deepStrictEqual(dump.schema, { version: source.schemaInfo.version, hash: source.schemaInfo.hash });
      assert.deepStrictEqual(dump.kinds, ['text', 'tree']);
      assert.strictEqual(dump.eventId, source.log.lastEventId);
      assert.strictEqual(dump.records.length, 13, 'live records and tombstones, the purged one too');
      assert.ok(dump.records.every((record) => record.meta && typeof record.meta === 'object'));
      // JSON through and through.
      const text = JSON.stringify(dump);
      const target = await openAt(t2, '/t');
      assert.deepStrictEqual(await importJSON(target, JSON.parse(text)), { mode: 'merge', records: 13 });
      for (const id of ids) {
        assert.deepStrictEqual(await target.get(id), await source.get(id), id);
        const [mine, theirs] = [await source[SOURCE].entry(id), await target[SOURCE].entry(id)];
        assert.deepStrictEqual(theirs.data, mine.data, `${id} data`);
        assert.deepStrictEqual(theirs.meta.deleted, mine.meta.deleted, `${id} tombstone`);
        assert.deepStrictEqual(theirs.meta.purged ?? null, mine.meta.purged ?? null, `${id} purge`);
      }
      assert.deepStrictEqual(await target.list(), await source.list());
      assert.strictEqual(await target.Post.count({ kind: 'a' }), await source.Post.count({ kind: 'a' }));
      assert.ok(target.log.length >= 13, 'one merge op per record, this node’s own');
      // Pages, collections, scopes, the live data alone.
      const pages = [];
      for await (const page of exportPages(source, { collections: ['Post'], limit: 5 })) pages.push(page.length);
      // Every Post, the tombstone too; the Tag left out — and the purged one, whose collection is erased with it.
      assert.strictEqual(
        pages.reduce((sum, n) => sum + n, 0),
        11,
      );
      assert.ok(pages.length >= 3 && pages.every((n) => n <= 5), 'pages of five ids at most');
      const plain = await exportJSON(source, { meta: false, collections: ['Tag'] });
      assert.strictEqual(plain.meta, false);
      assert.deepStrictEqual(
        plain.records.map((record) => Object.keys(record)),
        [['id', 'data']],
      );
      assert.deepStrictEqual(plain.records[0].data, { name: 't', $type: 'Tag' });
      // Insert: the ids kept, new ops of this node; a foreign dump the same way; a tombstone deletes.
      const other = await openAt(t2, '/o');
      const logged = other.log.length;
      assert.deepStrictEqual(
        await importJSON(
          other,
          {
            records: [
              { id: 'x1', data: { kind: 'a', n: 1, $type: 'Post' } },
              { id: 'x2', data: { n: 2 } },
            ],
          },
          { mode: 'insert' },
        ),
        { mode: 'insert', records: 2 },
      );
      assert.deepStrictEqual(await other.Post.get('x1'), { kind: 'a', n: 1, $type: 'Post' });
      assert.deepStrictEqual(await other.get('x2'), { n: 2 });
      assert.strictEqual(other.log.length - logged, 2, 'new ops');
      assert.ok(other.log.entriesOf('x1')[0].op.origin === other.nodeId);
      await importJSON(other, dump, { mode: 'insert' });
      assert.strictEqual(await other.get(ids[4]), null, 'a tombstone deletes');
      assert.deepStrictEqual(await other.get(ids[0]), await source.get(ids[0]));
      // Another schema: refused, unless forced; no meta: no merge.
      const foreign = { ...dump, schema: { version: 2, hash: 'other' } };
      await assert.rejects(importJSON(target, foreign), { code: 'SCHEMA_MISMATCH', given: 'other' });
      await importJSON(target, foreign, { force: true });
      await assert.rejects(importJSON(target, { records: [{ id: 'y', data: {} }] }), TypeError);
      await assert.rejects(importJSON(target, { records: [{ id: 'bad id', data: {} }] }), TypeError);
      await assert.rejects(importJSON(target, dump, { mode: 'nope' }), TypeError);
      await assert.rejects(exportJSON({}), TypeError);
    },
  );

  await t.test(
    'migrateStorage copies a database as the same node (its id and vector) or merges it into a new one',
    async (t2) => {
      const from = memoryEngine();
      const to = memoryEngine();
      let db = await syncom.createDatabase({ engine: from, path: 'm', defer: 0, logger: false, schema });
      const ids = [];
      for (let i = 0; i < 20; i++) ids.push((await db.Post.insert({ kind: 'k', n: i })).id);
      await db.delete(ids[0]);
      const { nodeId, vector } = db;
      const held = JSON.parse(JSON.stringify(vector));
      await db.close();
      const counts = await migrateStorage({ from, to, path: 'm', batch: 7 });
      assert.strictEqual(counts.records, 20);
      db = await syncom.createDatabase({ engine: to, path: 'm', defer: 0, logger: false, schema });
      assert.strictEqual(db.nodeId, nodeId, 'the same node');
      assert.deepStrictEqual(JSON.parse(JSON.stringify(db.vector)), held, 'the same vector');
      assert.strictEqual(await db.Post.count(), 19);
      await db.update(ids[1], { n: 100 });
      assert.strictEqual((await db.Post.get(ids[1])).n, 100);
      // Merge: a new node holding the same records.
      const fresh = await openAt(t2, '/fresh');
      assert.deepStrictEqual(await migrateStorage({ from: db, to: fresh, mode: 'merge', batch: 6 }), {
        mode: 'merge',
        records: 20,
      });
      assert.notStrictEqual(fresh.nodeId, nodeId);
      assert.strictEqual(await fresh.Post.count(), 19);
      assert.deepStrictEqual(await fresh.get(ids[1]), await db.get(ids[1]));
      assert.strictEqual(await fresh.get(ids[0]), null);
      await db.close();
      await assert.rejects(migrateStorage({ from: db, to: fresh, mode: 'nope' }), TypeError);
      await assert.rejects(migrateStorage({ from: {}, to: fresh, mode: 'merge' }), TypeError);
    },
  );
});
