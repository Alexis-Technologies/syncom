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
      // The old key opens nothing at the new place; the source stands as it was under its key.
      await assert.rejects(
        () => syncom.createDatabase({ engine: atRest(inner, { key: KEY_A }), path: 'p2', logger: false }),
        (error) => {
          assert.ok(typeof error.code === 'string', error.message);
          return true;
        },
      );
      const still = await open(atRest(inner, { key: KEY_A }), 'p');
      assert.strictEqual((await still.get(id)).title, 'sealed at rest');
      await still.close();
      // Into another engine, same path.
      const elsewhere = syncom.memoryEngine();
      const moved = await rotateAtRest(inner, {
        path: 'p',
        from: { key: KEY_A },
        to: { key: KEY_B },
        into: { engine: elsewhere },
      });
      assert.strictEqual(moved.records, counts.records);
      const there = await open(atRest(elsewhere, { key: KEY_B }), 'p');
      assert.strictEqual(there.nodeId, nodeId);
      await there.close();
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
        () => rotateAtRest(inner, { path: 'p', from: { key: KEY_A }, to: { key: KEY_B }, into: { path: 'p2' } }),
        {
          code: 'TARGET_NOT_EMPTY',
        },
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
});
