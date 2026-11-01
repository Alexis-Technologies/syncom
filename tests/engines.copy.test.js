'use strict';

// A database copied between engines keeps the node: the identity, the epoch,
// the vector, every record with its pieces, every tag, the chain — files →
// memory → IndexedDB → SQLite → files — and a peer resumes from its cursor
// without a bootstrap. A target that holds anything is refused.

const test = require('node:test');
const assert = require('node:assert');
const { IDBFactory, IDBKeyRange } = require('fake-indexeddb');
const syncom = require('../src/all/all.js');
const { memory } = require('../src/memory/memory.js');
const { idbEngine } = require('../src/idb/idb.js');
const { copyEngine } = require('../src/engines/engines.js');
const { createMesh } = require('./utils/mesh.js');
const { settle } = require('./utils/mesh.js');
const { createTemp, cleanupTemp } = require('./utils/temp.js');
const fs = require('node:fs/promises');
const path = require('node:path');
const nodeFsi = require('../src/fsi.js');

process.removeAllListeners('warning');
process.on('warning', (warning) => {
  if (warning.name !== 'ExperimentalWarning') console.error(warning.stack);
});
const { sqliteEngine } = require('../src/sqlite/sqlite.js');
const { PIECES_MIN } = require('../src/text/sequence.js');

const { createDatabase, filesEngine, memoryEngine } = syncom;
const base = { logger: false, defer: 0, schema: { entities: { Note: { index: ['kind'] } } } };

// What a database reads as, for the comparison across engines.
const picture = async (db) => {
  const ids = await db.list();
  const records = {};
  for (const id of ids) records[id] = await db.get(id);
  const tagged = {};
  for (const id of await db.at('v1').list()) tagged[id] = await db.at('v1').get(id);
  return {
    nodeId: db.nodeId,
    vector: db.vector,
    epoch: db.stats().log.epoch,
    floor: db.stats().log.floor,
    next: db.stats().log.next,
    length: db.stats().log.length,
    records,
    tagged,
    kinds: (await db.Note.select({ kind: 'b' }).fetch()).length,
    valid: await db.validate(),
  };
};

test('a database copied between engines', async (t) => {
  await t.test('files → memory → IndexedDB → SQLite → files: the same node on every engine', async () => {
    const files = filesEngine(memory());
    const path = 'app';
    const db = await createDatabase({ ...base, path, engine: files });
    const ids = [];
    for (let i = 0; i < 30; i++) ids.push(await db.insert({ n: i, kind: i % 2 ? 'a' : 'b', $type: 'Note' }));
    // A text of more runs than fit the record file: its pieces ride beside it (src/text/sequence.js PIECES_MIN).
    for (let i = 0; i < PIECES_MIN + 10; i++) await db.splice(ids[0], 'body', 0, 0, String.fromCharCode(97 + (i % 26)));
    await db.tag('v1');
    await db.update(ids[0], { n: 100 });
    await db.delete(ids[1]);
    await db.purge(ids[2]);
    await db.close();
    const probe = await createDatabase({ ...base, path, engine: files });
    let expected = await picture(probe);
    await probe.close();
    const hops = [
      memoryEngine(),
      idbEngine({ indexedDB: new IDBFactory(), IDBKeyRange, channel: null }),
      sqliteEngine(),
      filesEngine(memory()),
    ];
    let from = files;
    let expectRecords = 30;
    for (const to of hops) {
      const counts = await copyEngine(from, to, { path, batch: 7 });
      assert.strictEqual(counts.records, expectRecords, 'the records, tombstones and the purged ones included');
      assert.ok(counts.pieces > 0, 'the pieces');
      assert.ok(counts.copies >= 2, 'the tag’s copies: the records changed after the tag (a purge copies nothing)');
      assert.ok(counts.kv >= 3, 'node.json, the catalog, the chain…');
      assert.strictEqual(counts.entries, expected.length);
      const copied = await createDatabase({ ...base, path, engine: to });
      assert.deepStrictEqual(await picture(copied), expected, to.name);
      // The copy is a working database: a write lands and the chain stays valid; the next hop carries it on.
      const more = await copied.insert({ n: 999, kind: 'b', $type: 'Note' });
      assert.strictEqual(await copied.validate(), true);
      await copied.delete(more);
      await copied.purge(more);
      expectRecords++;
      expected = await picture(copied);
      await copied.close();
      from = to;
    }
    for (const engine of hops) await engine.close?.();
  });

  await t.test('a target that holds a database is TARGET_NOT_EMPTY; both are held for the copy', async () => {
    const from = memoryEngine();
    const to = memoryEngine();
    const a = await createDatabase({ ...base, path: 'p', engine: from });
    await a.insert({ n: 1 });
    await a.close();
    const b = await createDatabase({ ...base, path: 'p', engine: to });
    await b.insert({ n: 2 });
    await b.close();
    await assert.rejects(() => copyEngine(from, to, { path: 'p' }), { code: 'TARGET_NOT_EMPTY', path: 'p' });
    const open = await createDatabase({ ...base, path: 'p', engine: from });
    await assert.rejects(() => copyEngine(from, memoryEngine(), { path: 'p' }), { code: 'LOCKED' });
    await open.close();
    await assert.rejects(() => copyEngine(from, to, {}), { name: 'TypeError', message: /path/ });
    await assert.rejects(() => copyEngine(from, to, { path: 'p', batch: 0 }), { name: 'TypeError', message: /batch/ });
    await copyEngine(from, memoryEngine(), { path: 'p' });
    const again = await createDatabase({ ...base, path: 'p', engine: from });
    assert.strictEqual((await again.list()).length, 1, 'the source is as it was, unlocked');
    await again.close();
  });

  await t.test('a peer resumes from its cursor against the copy: no bootstrap, the same vector', async (t2) => {
    const engines = { A: memoryEngine(), B: memoryEngine() };
    const makeNode = async (t3, name, options = {}) => {
      const storage = await createDatabase({ ...base, path: name, engine: engines[name], ...options });
      t3.after(() => storage.close().catch(() => {}));
      return storage;
    };
    const mesh = await createMesh(t2, ['A', 'B'], [['B', 'A']], makeNode);
    const a = mesh.get('A');
    const b = mesh.get('B');
    for (let i = 0; i < 10; i++) await a.insert({ n: i, $type: 'Note' });
    await settle([a, b]);
    assert.strictEqual((await b.list()).length, 10);
    const vector = a.vector;
    await a.close();
    // A moves to SQLite; B dials the copy as the same node.
    const moved = sqliteEngine();
    await copyEngine(engines.A, moved, { path: 'A' });
    engines.A = moved;
    const copied = await createDatabase({
      ...base,
      path: 'A',
      engine: moved,
      sync: { connect: mesh.connect, autoStart: false },
    });
    t2.after(() => copied.close().catch(() => {}));
    assert.deepStrictEqual(copied.vector, vector);
    assert.strictEqual(copied.nodeId, a.nodeId);
    const bootstraps = [];
    b.sync.on('bootstrap', (info) => bootstraps.push(info));
    // B dials again: its link reaches the unit of the copy, the same node at the same position.
    await b.sync.stop();
    mesh.units.set('A', copied.sync.unit({ access: 'public' }));
    await b.sync.start();
    await copied.insert({ n: 'after the move', $type: 'Note' });
    await settle([copied, b]);
    assert.strictEqual((await b.list()).length, 11, 'B followed from its cursor');
    assert.deepStrictEqual(bootstraps, [], 'no bootstrap: the same epoch, the same seqs');
    await moved.close();
  });
});

// What a copy must get right whatever the engines: every id whatever order the
// source lists in, nothing left behind by a copy that failed, the identity
// last, the keys' mode kept.
test('a copy out of a files engine: order, failure, the keys', async (t) => {
  const stored = (data) => ({
    data,
    meta: { clock: {}, base: 0, deleted: 0 },
    encrypted: false,
    timestamp: 1,
    block: null,
  });

  await t.test(
    '1 500 records out of a files engine whose backend lists backwards: none skipped, in id order',
    async () => {
      const base = memory();
      const fsi = {
        ...base,
        async list(dir) {
          return (await base.list(dir)).reverse();
        },
      };
      const from = filesEngine(fsi);
      const source = await from.open('app', { logger: null });
      const ids = [];
      for (let i = 0; i < 500; i++) {
        const k = `k${String(i).padStart(3, '0')}`;
        ids.push(k, `${k}-x`, `${k}.y`);
      }
      for (let i = 0; i < ids.length; i += 300) {
        const rows = [];
        for (const id of ids.slice(i, i + 300)) rows.push({ id, stored: stored({ id }) });
        await source.write({ records: rows });
      }
      await source.close();
      const to = memoryEngine();
      const copied = await copyEngine(from, to, { path: 'app', batch: 200 });
      assert.strictEqual(copied.records, 1500);
      const target = await to.open('app', { logger: null });
      const got = await target.records.ids();
      assert.strictEqual(got.length, 1500);
      assert.deepStrictEqual(got, ids.slice().sort());
      await target.close();
    },
  );

  await t.test('a copy that fails midway leaves the target empty; the identity lands last', async () => {
    const from = memoryEngine();
    const source = await from.open('app', { logger: null });
    await source.write({
      kv: {
        put: [
          ['', 'node.json', '{"id":"n"}', undefined],
          ['keys', 'private.pem', 'secret', undefined],
          ['index', 'catalog.json', '{}', undefined],
        ],
      },
      records: [
        { id: 'a', stored: stored({ a: 1 }) },
        { id: 'b', stored: stored({ b: 1 }) },
      ],
    });
    await source.close();
    const inner = memoryEngine();
    const sets = [];
    let failAt = Infinity;
    const to = {
      ...inner,
      open: async (path, options) => {
        const db = await inner.open(path, options);
        return {
          ...db,
          write: async (batch) => {
            const keys = batch.kv ? batch.kv.put.map((put) => put[1]).join('|') : '';
            sets.push(`${Object.keys(batch).join(',')}:${keys}`);
            if (sets.length === failAt) throw new Error('disk full');
            return db.write(batch);
          },
        };
      },
    };
    failAt = 2;
    await assert.rejects(copyEngine(from, to, { path: 'app', batch: 1 }), /disk full/);
    const after = await inner.open('app', { logger: null });
    assert.strictEqual(await after.kv.has('', 'node.json'), false, 'no identity on a target the copy left');
    assert.deepStrictEqual(await after.records.ids(), [], 'no record either');
    await after.close();
    sets.length = 0;
    failAt = Infinity;
    const copied = await copyEngine(from, to, { path: 'app', batch: 1 });
    assert.strictEqual(copied.records, 2);
    assert.ok(sets[sets.length - 1].includes('node.json'), `the identity is the last write set: ${sets.join(' / ')}`);
    assert.ok(sets[sets.length - 2].includes('private.pem'), `the keys just before it: ${sets.join(' / ')}`);
  });

  await t.test('the private keys keep their mode on a files target', async () => {
    // One path on both engines: the source lives under the target's directory name.
    const dir = await createTemp();
    const from = memoryEngine();
    const source = await from.open(dir, { logger: null });
    await source.write({
      kv: {
        put: [
          ['', 'node.json', '{"id":"n"}', undefined],
          ['keys', 'private.pem', 'secret', undefined],
          ['keys', 'public.pem', 'open', undefined],
        ],
      },
    });
    await source.close();
    try {
      await copyEngine(from, filesEngine(nodeFsi), { path: dir });
      const { mode } = await fs.stat(path.join(dir, 'keys', 'private.pem'));
      assert.strictEqual(mode & 0o777, 0o600);
      assert.strictEqual((await fs.readFile(path.join(dir, 'node.json'), 'utf8')).length > 0, true);
    } finally {
      await cleanupTemp(dir);
    }
  });
});
