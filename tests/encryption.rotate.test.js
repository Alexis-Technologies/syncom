'use strict';

// The at-rest key rotated by a copy: the database sealed under one key copied
// whole into another place sealed under the next — the same node, every
// record, blob and log entry — never in place.

const test = require('node:test');
const assert = require('node:assert');
const syncom = require('../src/all/all.js');
const { atRest, rotateAtRest } = require('../src/encryption/encryption.js');
const { attachments } = require('../src/attachments/attachments.js');
const { copyEngine } = require('../src/engines/copy.js');
const { memory } = require('../src/memory/memory.js');

const { createDatabase, dropDatabase, filesEngine, memoryEngine } = syncom;

const KEY_A = new Uint8Array(32).fill(1);
const KEY_B = new Uint8Array(32).fill(2);

test('Key rotation at rest', async (t) => {
  await t.test(
    'rotateAtRest copies the database under the new key into another path or engine; the old key opens nothing there',
    async (t2) => {
      const inner = syncom.memoryEngine();
      const open = async (engine, path, options = {}) => {
        const db = await syncom.createDatabase({
          engine,
          path,
          logger: false,
          defer: 0,
          plugins: [attachments()],
          ...options,
        });
        t2.after(() => db.close().catch(() => {}));
        return db;
      };
      const a = await open(atRest(inner, { key: KEY_A }), 'p');
      const id = await a.insert({ title: 'sealed at rest' });
      const other = await a.insert({ title: 'and another' });
      await a.attachments.put(id, 'file.bin', new Uint8Array([1, 2, 3]));
      const nodeId = a.nodeId;
      const vector = { ...a.vector };
      await a.close();
      // Into another path on the same engine.
      const counts = await rotateAtRest(inner, {
        path: 'p',
        from: { key: KEY_A },
        to: { key: KEY_B },
        into: { path: 'p2' },
      });
      assert.ok(counts.records >= 2, JSON.stringify(counts));
      assert.strictEqual(counts.blobs, 1);
      const rotated = await open(atRest(inner, { key: KEY_B }), 'p2');
      assert.strictEqual(rotated.nodeId, nodeId, 'the same node');
      assert.deepStrictEqual(rotated.vector, vector, 'the same log');
      assert.strictEqual((await rotated.get(id)).title, 'sealed at rest');
      assert.deepStrictEqual(await rotated.get(other), { title: 'and another' });
      assert.deepStrictEqual([...(await rotated.attachments.get(id, 'file.bin')).bytes], [1, 2, 3]);
      await rotated.close();
      // The old key opens nothing at the new place; the source is fenced — MOVED, naming where it went — and a copy
      // of it is refused the same (the node in two places).
      await assert.rejects(
        () => syncom.createDatabase({ engine: atRest(inner, { key: KEY_A }), path: 'p2', logger: false }),
        (error) => {
          assert.ok(typeof error.code === 'string', error.message);
          return true;
        },
      );
      await assert.rejects(() => open(atRest(inner, { key: KEY_A }), 'p'), {
        code: 'MOVED',
        to: { path: 'p2', engine: 'memory' },
      });
      await assert.rejects(() => copyEngine(atRest(inner, { key: KEY_A }), syncom.memoryEngine(), { path: 'p' }), {
        code: 'MOVED',
        path: 'p',
      });
      // Into another engine, same path — from where the database is now.
      const elsewhere = syncom.memoryEngine();
      const moved = await rotateAtRest(inner, {
        path: 'p2',
        from: { key: KEY_B },
        to: { key: KEY_B },
        into: { engine: elsewhere },
      });
      assert.strictEqual(moved.records, counts.records);
      const there = await open(atRest(elsewhere, { key: KEY_B }), 'p2');
      assert.strictEqual(there.nodeId, nodeId);
      await there.close();
      await assert.rejects(() => open(atRest(inner, { key: KEY_B }), 'p2'), { code: 'MOVED' });
      // Never in place; the options are checked; the target must be empty.
      await assert.rejects(
        () => rotateAtRest(inner, { path: 'p', from: { key: KEY_A }, to: { key: KEY_B }, into: { path: 'p' } }),
        {
          name: 'TypeError',
          message: /in place/,
        },
      );
      await assert.rejects(() => rotateAtRest(inner, { path: 'p', from: { key: KEY_A }, to: { key: KEY_B } }), {
        name: 'TypeError',
        message: /into/,
      });
      await assert.rejects(() => rotateAtRest({}, { path: 'p', from: {}, to: {}, into: { path: 'x' } }), {
        name: 'TypeError',
        message: /engine/,
      });
      await assert.rejects(() => rotateAtRest(inner, { from: {}, to: {}, into: { path: 'x' } }), {
        name: 'TypeError',
        message: /path/,
      });
      await assert.rejects(
        () =>
          rotateAtRest(elsewhere, { path: 'p2', from: { key: KEY_B }, to: { key: KEY_A }, into: { engine: inner } }),
        { code: 'TARGET_NOT_EMPTY' },
      );
      await assert.rejects(() => copyEngine(inner, inner, { path: 'p' }), {
        name: 'TypeError',
        message: /target is the source/,
      });
      await assert.rejects(() => copyEngine(inner, inner, { path: 'p', targetPath: '' }), {
        name: 'TypeError',
        message: /targetPath/,
      });
    },
  );

  await t.test(
    'rotateAtRest over a backend: filesEngine(atRest(fsi)) into another fsi or path; the source is fenced (MOVED) until dropped; a copy cut short is taken away before the next',
    async (t2) => {
      const fsi = memory();
      const open = async (backend, path) => {
        const db = await createDatabase({ fsi: backend, path, logger: false, defer: 0, plugins: [attachments()] });
        t2.after(() => db.close().catch(() => {}));
        return db;
      };
      const a = await open(atRest(fsi, { key: KEY_A }), 'p');
      const id = await a.insert({ title: 'on a backend' });
      await a.attachments.put(id, 'f.bin', new Uint8Array([4, 5, 6]));
      const nodeId = a.nodeId;
      await a.close();
      // The default medium rotated: the files engine over the backend wrapped under each key.
      const counts = await rotateAtRest(
        { fsi, filesEngine },
        { path: 'p', from: { key: KEY_A }, to: { key: KEY_B }, into: { path: 'p2' } },
      );
      assert.strictEqual(counts.blobs, 1);
      assert.ok(counts.records >= 1);
      const rotated = await open(atRest(fsi, { key: KEY_B }), 'p2');
      assert.strictEqual(rotated.nodeId, nodeId, 'the same node');
      assert.deepStrictEqual([...(await rotated.attachments.get(id, 'f.bin')).bytes], [4, 5, 6]);
      await rotated.close();
      // The source is fenced: an open there is MOVED, naming where it went — sealed under the old key, never copied.
      await assert.rejects(
        () => open(atRest(fsi, { key: KEY_A }), 'p'),
        (error) => {
          assert.strictEqual(error.code, 'MOVED');
          assert.deepStrictEqual(error.to, { path: 'p2', engine: 'files' });
          return true;
        },
      );
      const files = fsi.dump();
      assert.ok(typeof files['p/moved.json'] === 'string' && !files['p/moved.json'].includes('p2'), 'sealed');
      assert.strictEqual(files['p2/moved.json'], undefined, 'the fence is the source’s alone');
      assert.strictEqual(files['p2/copy.json'], undefined, 'the mark of the copy went with its end');
      await assert.rejects(() => open(atRest(fsi, { key: KEY_A }), 'p'), { code: 'MOVED' });
      // dropDatabase takes the fence with the rest: a fresh database at the old place is a new node.
      await dropDatabase('p', { fsi: atRest(fsi, { key: KEY_A }) });
      const fresh = await open(atRest(fsi, { key: KEY_A }), 'p');
      assert.notStrictEqual(fresh.nodeId, nodeId);
      await fresh.close();
      // Into another backend.
      const other = memory();
      await rotateAtRest(
        { fsi, filesEngine },
        { path: 'p2', from: { key: KEY_B }, to: { key: KEY_A }, into: { fsi: other } },
      );
      const there = await open(atRest(other, { key: KEY_A }), 'p2');
      assert.strictEqual(there.nodeId, nodeId);
      await there.close();
      await assert.rejects(() => open(atRest(fsi, { key: KEY_B }), 'p2'), { code: 'MOVED' });
      // An engine's source is fenced the same.
      const inner = memoryEngine();
      const e = await createDatabase({ engine: atRest(inner, { key: KEY_A }), path: 'e', logger: false, defer: 0 });
      await e.insert({ n: 1 });
      await e.close();
      await rotateAtRest(inner, { path: 'e', from: { key: KEY_A }, to: { key: KEY_B }, into: { path: 'e2' } });
      await assert.rejects(
        () => createDatabase({ engine: atRest(inner, { key: KEY_A }), path: 'e', logger: false }),
        (error) => {
          assert.strictEqual(error.code, 'MOVED');
          assert.deepStrictEqual(error.to, { path: 'e2', engine: 'memory' });
          return true;
        },
      );
      // A copy cut short — the target marked (copy.json), rows there, no identity: taken away before the next copy.
      const stale = memory();
      const cut = await filesEngine(atRest(stale, { key: KEY_A })).open('p3', { logger: null });
      await cut.kv.put('', 'copy.json', '{"from":"p2","started":0}');
      await cut.write({ records: [{ id: 'leftover', text: '{"data":{"left":true}}' }] });
      await cut.close();
      await rotateAtRest(
        { fsi: other, filesEngine },
        { path: 'p2', from: { key: KEY_A }, to: { key: KEY_B }, into: { fsi: stale, path: 'p3' } },
      );
      const taken = await open(atRest(stale, { key: KEY_B }), 'p3');
      assert.strictEqual(taken.nodeId, nodeId);
      assert.strictEqual(await taken.has('leftover'), false, 'what the cut copy left is gone');
      await taken.close();
      // A target that holds a database is refused still (the fenced source among them); the options are checked.
      await assert.rejects(
        () =>
          rotateAtRest(
            { fsi: stale, filesEngine },
            { path: 'p3', from: { key: KEY_B }, to: { key: KEY_A }, into: { fsi: other, path: 'p2' } },
          ),
        { code: 'TARGET_NOT_EMPTY' },
      );
      await assert.rejects(
        () =>
          rotateAtRest(
            { fsi: other, filesEngine },
            { path: 'p2', from: { key: KEY_A }, to: { key: KEY_B }, into: { fsi: memory(), path: 'p4' } },
          ),
        { code: 'MOVED', path: 'p2' },
      );
      await assert.rejects(() => rotateAtRest({ fsi }, { path: 'p', from: {}, to: {}, into: { path: 'x' } }), {
        name: 'TypeError',
        message: /filesEngine/,
      });
      await assert.rejects(
        () => rotateAtRest({ fsi, filesEngine }, { path: 'p', from: {}, to: {}, into: { path: 'p' } }),
        { name: 'TypeError', message: /in place/ },
      );
      await assert.rejects(
        () => rotateAtRest({ fsi, filesEngine }, { path: 'p', from: {}, to: {}, into: { engine: memoryEngine() } }),
        { name: 'TypeError', message: /not an engine/ },
      );
      await assert.rejects(
        () => rotateAtRest(memoryEngine(), { path: 'p', from: {}, to: {}, into: { fsi: memory() } }),
        { name: 'TypeError', message: /not a backend/ },
      );
      await assert.rejects(() => rotateAtRest({}, { path: 'p', from: {}, to: {}, into: { path: 'x' } }), {
        name: 'TypeError',
        message: /engine, or/,
      });
    },
  );
});
