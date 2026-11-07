'use strict';

// Attachments: bytes beside a record in the engine's blobs store, named on the
// record as a register that replicates; the bytes fetched from a peer on
// demand, checked by digest; compression; the at-rest wrapper sealing them;
// copyEngine carrying them.

const test = require('node:test');
const assert = require('node:assert');
const syncom = require('../src/all/all.js');
const { attachments, FIELD } = require('../src/attachments/attachments.js');
const { atRestEngine } = require('../src/encryption/at-rest-engine.js');
const { copyEngine } = require('../src/engines/copy.js');
const { DB } = require('../src/symbols.js');
const { hashBytes } = require('../src/crypto/digest.js');
const { createMesh, settle, waitUntil } = require('./utils/mesh.js');

const bytesOf = (text) => new TextEncoder().encode(text);
const same = (a, b) => assert.deepStrictEqual([...a], [...b]);

test('Attachments', async (t) => {
  const engine = syncom.memoryEngine();
  const createStorage = async (t2, name, options = {}) => {
    const storage = await syncom.createDatabase({
      engine,
      path: `${t2.name}/${name}`,
      logger: false,
      defer: 0,
      plugins: [attachments()],
      ...options,
    });
    t2.after(() => storage.close().catch(() => {}));
    return storage;
  };

  await t.test(
    'put keeps the bytes under their digest and names them on the record; get, has, list, remove; a name shared by two records is one blob',
    async (t2) => {
      const db = await createStorage(t2, 'A');
      const id = await db.insert({ title: 'with a file' });
      const entry = await db.attachments.put(id, 'notes.txt', bytesOf('hello attachments'), { type: 'text/plain' });
      assert.match(entry.digest, /^[0-9a-f]{64}$/);
      assert.strictEqual(entry.digest, await hashBytes(bytesOf('hello attachments')));
      assert.deepStrictEqual(entry, { digest: entry.digest, type: 'text/plain', length: 17 });
      // The name is a register on the record, as any field: readable, and what a peer gets.
      const data = await db.get(id);
      assert.deepStrictEqual(data[FIELD], { 'notes.txt': entry });
      const got = await db.attachments.get(id, 'notes.txt');
      same(got.bytes, bytesOf('hello attachments'));
      assert.strictEqual(got.type, 'text/plain');
      assert.strictEqual(got.length, 17);
      assert.strictEqual(got.digest, entry.digest);
      assert.strictEqual(await db.attachments.has(id, 'notes.txt'), true);
      assert.strictEqual(await db.attachments.has(id, 'other'), false);
      assert.strictEqual(await db.attachments.get(id, 'other'), null);
      // The default type; a string is UTF-8; an ArrayBuffer is its bytes.
      await db.attachments.put(id, 'raw.bin', new Uint8Array([0, 255, 7]).buffer);
      await db.attachments.put(id, 'text', 'as text');
      assert.strictEqual((await db.attachments.get(id, 'raw.bin')).type, 'application/octet-stream');
      same((await db.attachments.get(id, 'raw.bin')).bytes, [0, 255, 7]);
      same((await db.attachments.get(id, 'text')).bytes, bytesOf('as text'));
      assert.deepStrictEqual(
        (await db.attachments.list(id)).map((a) => a.name),
        ['notes.txt', 'raw.bin', 'text'],
      );
      // Two names, two records, the same bytes: one blob in the store.
      const other = await db.insert({ title: 'another' });
      await db.attachments.put(other, 'copy.txt', bytesOf('hello attachments'));
      assert.strictEqual((await db[DB].blobs.list()).length, 3);
      // A removed name is gone from the record; its bytes stay (the other record names them).
      await db.attachments.remove(id, 'notes.txt');
      assert.strictEqual(await db.attachments.get(id, 'notes.txt'), null);
      assert.deepStrictEqual(
        (await db.attachments.list(id)).map((a) => a.name),
        ['raw.bin', 'text'],
      );
      same((await db.attachments.get(other, 'copy.txt')).bytes, bytesOf('hello attachments'));
      assert.deepStrictEqual(await db.attachments.list('missing-record'), []);
      // The arguments are checked; a record that is not there refuses the put.
      await assert.rejects(() => db.attachments.put(id, 'bad/name', bytesOf('x')), {
        name: 'TypeError',
        message: /name/,
      });
      await assert.rejects(() => db.attachments.put('bad id!', 'x', bytesOf('x')), {
        name: 'TypeError',
        message: /record id/,
      });
      await assert.rejects(() => db.attachments.put(id, 'x', 42), { name: 'TypeError', message: /bytes/ });
      await assert.rejects(() => db.attachments.put(id, 'x', bytesOf('x'), { type: '' }), {
        name: 'TypeError',
        message: /type/,
      });
      await assert.rejects(() => db.attachments.put('absent', 'x', bytesOf('x')), { code: 'NOT_FOUND' });
      assert.throws(() => attachments({ compression: 'lz' }), { name: 'TypeError', message: /compression/ });
      // An engine without a blobs store cannot carry attachments.
      const plain = syncom.memoryEngine();
      const without = Object.freeze({
        name: 'no-blobs',
        capabilities: Object.freeze({ ...plain.capabilities, blobs: false }),
        open: async (path, options) => {
          const { blobs, ...rest } = await plain.open(path, options);
          return Object.freeze(rest);
        },
        remove: (path) => plain.remove(path),
      });
      await assert.rejects(
        () => syncom.createDatabase({ engine: without, path: 'x', logger: false, plugins: [attachments()] }),
        { name: 'TypeError', message: /blobs store/ },
      );
    },
  );

  await t.test(
    'compression: the stored bytes are the compressed ones, the digest theirs, the register says so; get inflates',
    async (t2) => {
      const db = await createStorage(t2, 'Z', { plugins: [attachments({ compression: 'gzip' })] });
      const id = await db.insert({ title: 'zipped' });
      const text = 'the same line again and again '.repeat(200);
      const entry = await db.attachments.put(id, 'long.txt', bytesOf(text), { type: 'text/plain' });
      assert.strictEqual(entry.encoding, 'gzip');
      assert.strictEqual(entry.length, text.length);
      const stored = await db[DB].blobs.get(entry.digest);
      assert.ok(stored.length < text.length / 4, `compressed: ${stored.length} of ${text.length}`);
      assert.strictEqual(await hashBytes(stored), entry.digest);
      const got = await db.attachments.get(id, 'long.txt');
      assert.strictEqual(new TextDecoder().decode(got.bytes), text);
      assert.strictEqual(got.encoding, 'gzip');
      assert.deepStrictEqual((await db.attachments.list(id))[0].encoding, 'gzip');
    },
  );

  await t.test(
    'the name replicates, the bytes are fetched from a peer on demand, checked by digest and kept; none holding them is BLOB_NOT_FOUND; a host that serves no blobs is skipped',
    async (t2) => {
      const mesh = await createMesh(
        t2,
        ['A', 'B', 'C'],
        [
          ['B', 'A'],
          ['C', 'B'],
        ],
        createStorage,
      );
      const [a, b, c] = ['A', 'B', 'C'].map((name) => mesh.get(name));
      const id = await a.insert({ title: 'shared file' });
      const entry = await a.attachments.put(id, 'photo.bin', new Uint8Array(5000).fill(3), { type: 'image/x-test' });
      await settle([a, b, c]);
      // The register reached B and C; the bytes did not.
      assert.deepStrictEqual((await b.get(id))[FIELD], { 'photo.bin': entry });
      assert.strictEqual(await b.attachments.has(id, 'photo.bin'), false);
      await assert.rejects(() => b.attachments.get(id, 'photo.bin', { fetch: false }), { code: 'BLOB_NOT_FOUND' });
      // C dials B alone, and B holds no bytes yet: nobody has them for C.
      await assert.rejects(
        () => c.attachments.get(id, 'photo.bin'),
        (error) => {
          assert.strictEqual(error.code, 'BLOB_NOT_FOUND');
          assert.strictEqual(error.id, id);
          assert.strictEqual(error.digest, entry.digest);
          return true;
        },
      );
      // B asks A, checks the digest, keeps the bytes; then C gets them from B.
      const got = await b.attachments.get(id, 'photo.bin');
      assert.strictEqual(got.bytes.length, 5000);
      assert.strictEqual(got.type, 'image/x-test');
      assert.strictEqual(await b.attachments.has(id, 'photo.bin'), true);
      assert.strictEqual((await c.attachments.get(id, 'photo.bin')).bytes.length, 5000);
      assert.strictEqual(await c.attachments.has(id, 'photo.bin'), true);
      // A host that serves no blobs refuses the call (403 NOT_SERVED); a digest that is none, 400; one it lacks, 404.
      const { MemoryLink } = require('./utils/memory-link.js');
      const closed = new MemoryLink(a.sync.unit({ access: 'public', allow: { blob: false } }));
      await closed.call('syncom/hello', { node: 'probe-1', version: 1 });
      await assert.rejects(() => closed.call('syncom/blob', { digest: entry.digest }), {
        code: 403,
        reason: 'NOT_SERVED',
      });
      const open = new MemoryLink(a.sync.unit({ access: 'public' }));
      await open.call('syncom/hello', { node: 'probe-2', version: 1 });
      await assert.rejects(() => open.call('syncom/blob', { digest: 'xyz' }), { code: 400, reason: 'BAD_DIGEST' });
      await assert.rejects(() => open.call('syncom/blob', { digest: 'f'.repeat(64) }), {
        code: 404,
        reason: 'BLOB_NOT_FOUND',
      });
      // By default a blob is served to a peer that names the record holding it (allow.blob 'named'): the digest
      // alone is 404 there, and serves under allow.blob 'any'.
      await assert.rejects(() => open.call('syncom/blob', { digest: entry.digest }), {
        code: 404,
        reason: 'BLOB_NOT_FOUND',
      });
      const answer = await open.call('syncom/blob', { digest: entry.digest, id, name: 'photo.bin' });
      assert.strictEqual(answer.digest, entry.digest);
      assert.strictEqual(answer.size, 5000);
      const any = new MemoryLink(a.sync.unit({ access: 'public', allow: { blob: 'any' } }));
      await any.call('syncom/hello', { node: 'probe-3', version: 1 });
      assert.strictEqual((await any.call('syncom/blob', { digest: entry.digest })).size, 5000);
      // A peer answering the wrong bytes under the digest is not believed.
      await a[DB].blobs.put(entry.digest, new Uint8Array([1, 2, 3]));
      const warnings = [];
      const quiet = await createStorage(t2, 'D', {
        sync: { connect: mesh.connect, autoStart: false },
        logger: { warn: (e) => warnings.push(e), error: () => {}, info: () => {}, debug: () => {} },
      });
      await quiet.sync.addNode({ url: 'mem://A' });
      await quiet.sync.start();
      await waitUntil(() => quiet.sync.peers()[0]?.subscribed);
      await waitUntil(() => quiet.hasRecord(id));
      await assert.rejects(() => quiet.attachments.get(id, 'photo.bin'), { code: 'BLOB_NOT_FOUND' });
      assert.ok(warnings.some((w) => w.event === 'sync.blob.mismatch'));
      // fetchBlob checks its argument; a node that dials nobody has nobody to ask.
      await assert.rejects(() => quiet.sync.fetchBlob('nope'), { name: 'TypeError' });
      const alone = await createStorage(t2, 'E');
      const lone = await alone.insert({ title: 'alone' });
      await alone.transact(async (tx) =>
        tx.update(lone, { [`${FIELD}/f`]: { digest: 'a'.repeat(64), type: 'x', length: 1 } }),
      );
      await assert.rejects(() => alone.attachments.get(lone, 'f'), { code: 'BLOB_NOT_FOUND' });
    },
  );

  await t.test(
    'at rest the bytes are sealed at the blob’s place and read back whole; copyEngine carries the blobs',
    async (t2) => {
      const inner = syncom.memoryEngine();
      const cipher = {
        seal: async (name, text) => `sealed:${name}:${text}`,
        open: async (name, text) => {
          const prefix = `sealed:${name}:`;
          if (!text.startsWith(prefix)) throw new Error('not sealed here');
          return text.slice(prefix.length);
        },
      };
      const sealed = atRestEngine(inner, cipher);
      const db = await syncom.createDatabase({
        engine: sealed,
        path: 'rest',
        logger: false,
        defer: 0,
        plugins: [attachments()],
      });
      t2.after(() => db.close().catch(() => {}));
      const id = await db.insert({ title: 'sealed' });
      const entry = await db.attachments.put(id, 'secret.txt', bytesOf('top secret'));
      same((await db.attachments.get(id, 'secret.txt')).bytes, bytesOf('top secret'));
      // What the inner engine holds is the ciphertext's bytes, bound to the blob's place.
      const raw = await (await inner.open('rest')).blobs.get(entry.digest);
      const text = new TextDecoder().decode(raw);
      assert.match(text, /^sealed:4:rest\/blobs\//);
      assert.ok(!text.includes('top secret'));
      // A copy to another engine carries the blobs as they are stored.
      await db.close();
      const target = syncom.memoryEngine();
      const counts = await copyEngine(sealed, target, { path: 'rest' });
      assert.strictEqual(counts.blobs, 1);
      // Through the sealed engine's contract the copy reads the bytes open, and the plain target keeps them so.
      same(await (await target.open('rest')).blobs.get(entry.digest), bytesOf('top secret'));
    },
  );
});
