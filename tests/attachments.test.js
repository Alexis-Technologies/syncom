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
const { MAX_BLOB_BYTES } = require('../src/blobs.js');
const { memory } = require('../src/memory/memory.js');
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
      // A sealed record takes no attachment: its bytes would lie in the clear, outside the record's key.
      const sealed = await db.insert({ secret: 'kept' }, { encrypted: true });
      const held = (await db[DB].blobs.list()).length;
      await assert.rejects(() => db.attachments.put(sealed, 'y', bytesOf('never stored')), {
        code: 'ENCRYPTED',
        id: sealed,
      });
      assert.strictEqual((await db[DB].blobs.list()).length, held, 'nothing stored for it');
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
    'a register a peer wrote with a digest that is none is ATTACHMENT_INVALID, never a path: every engine refuses a blob key that is no digest and a blob past 64 MiB',
    async (t2) => {
      // The files engine over a backend that counts what reaches it: a traversal in a register never does.
      const fsi = memory();
      const seen = [];
      const spy = {
        read(dir, name) {
          seen.push(['read', dir, name]);
          return fsi.read(dir, name);
        },
        write: (dir, name, content, options) => fsi.write(dir, name, content, options),
        exists(dir, name) {
          seen.push(['exists', dir, name]);
          return fsi.exists(dir, name);
        },
        remove(dir, name) {
          seen.push(['remove', dir, name]);
          return fsi.remove(dir, name);
        },
        list: (dir) => fsi.list(dir),
      };
      const warnings = [];
      const db = await syncom.createDatabase({
        engine: syncom.filesEngine(spy),
        path: 'peered',
        logger: { warn: (e) => warnings.push(e), error: () => {}, info: () => {}, debug: () => {} },
        defer: 0,
        plugins: [attachments()],
      });
      t2.after(() => db.close().catch(() => {}));
      const id = await db.insert({ title: 'a record a peer wrote registers on' });
      const good = await db.attachments.put(id, 'ok.txt', bytesOf('fine'));
      const bad = {
        traversal: { digest: '../../../../etc/hosts', type: 'text/plain', length: 112 },
        keys: { digest: 'keys/private.pem', type: 'text/plain', length: 1 },
        upper: { digest: 'A'.repeat(64), type: 'x', length: 1 },
        notype: { digest: good.digest, type: '', length: 1 },
        negative: { digest: good.digest, type: 'x', length: -1 },
        huge: { digest: good.digest, type: 'x', length: MAX_BLOB_BYTES + 1 },
        float: { digest: good.digest, type: 'x', length: 1.5 },
        encoding: { digest: good.digest, type: 'x', length: 1, encoding: 'lz' },
        text: 'not a register',
      };
      await db.transact(async (tx) => {
        for (const [name, entry] of Object.entries(bad)) await tx.update(id, { [`${FIELD}/${name}`]: entry });
      });
      seen.length = 0;
      for (const name of Object.keys(bad)) {
        await assert.rejects(
          () => db.attachments.get(id, name),
          (error) => {
            assert.strictEqual(error.code, 'ATTACHMENT_INVALID', name);
            assert.strictEqual(error.id, id);
            assert.strictEqual(error.attachment, name);
            assert.strictEqual(
              error.name,
              'SyncomError',
              'the attachment rides as `attachment`, never as the error’s name',
            );
            return true;
          },
        );
        await assert.rejects(() => db.attachments.has(id, name), { code: 'ATTACHMENT_INVALID' });
      }
      const touched = seen.filter(([, dir]) => dir.endsWith('/blobs'));
      assert.deepStrictEqual(touched, [], 'no register that is none reached the blobs directory');
      // list() leaves them out and warns once per register; the good one stands.
      assert.deepStrictEqual(
        (await db.attachments.list(id)).map((a) => a.name),
        ['ok.txt'],
      );
      await db.attachments.list(id);
      const invalid = warnings.filter((w) => w.event === 'attachments.register.invalid');
      assert.strictEqual(invalid.length, Object.keys(bad).length, 'once each');
      assert.ok(invalid.every((w) => w.id === id && typeof w.name === 'string'));
      assert.deepStrictEqual([...(await db.attachments.get(id, 'ok.txt')).bytes], [...bytesOf('fine')]);
      // Every engine's store refuses a key that is no digest before the medium sees it (the engine suites hold each);
      // here the files engine over the spy: a traversal reaches no read, no exists.
      const store = db[DB].blobs;
      seen.length = 0;
      for (const key of ['../../../../etc/hosts', 'A'.repeat(64), 'x']) {
        await assert.rejects(() => store.get(key), { name: 'TypeError', message: /digest/ });
        await assert.rejects(() => store.has(key), { name: 'TypeError', message: /digest/ });
        await assert.rejects(() => store.remove(key), { name: 'TypeError', message: /digest/ });
      }
      assert.deepStrictEqual(
        seen.filter(([, dir]) => dir.endsWith('/blobs')),
        [],
      );
      // The one cap: a put past 64 MiB is BLOB_TOO_LARGE before the bytes are hashed or stored.
      await assert.rejects(() => db.attachments.put(id, 'big.bin', new Uint8Array(MAX_BLOB_BYTES + 1)), {
        name: 'TypeError',
        code: 'BLOB_TOO_LARGE',
      });
      assert.strictEqual((await store.list()).length, 1);
      // A register that is null is none; `sync.fetchBlob` refuses what is no digest the same way.
      await db.transact(async (tx) => tx.update(id, { [`${FIELD}/none`]: null }));
      assert.strictEqual(await db.attachments.get(id, 'none'), null);
      await assert.rejects(() => db.sync.fetchBlob('../../etc/hosts'), { name: 'TypeError', message: /digest/ });
    },
  );

  await t.test(
    'the bytes are what the register says: a blob shorter or longer than length, or one that inflates past it, is BLOB_MISMATCH and is never inflated whole; a fetched blob is kept once, and a store that refuses it is a warning',
    async (t2) => {
      // Plain: the register's length is checked against the stored bytes.
      const plain = await createStorage(t2, 'M');
      const id = await plain.insert({ title: 'mismatched' });
      const entry = await plain.attachments.put(id, 'ok.txt', bytesOf('twelve bytes'));
      assert.strictEqual(entry.length, 12);
      await plain.transact(async (tx) => {
        await tx.update(id, { [`${FIELD}/short`]: { ...entry, length: 3 } });
        await tx.update(id, { [`${FIELD}/long`]: { ...entry, length: 400 } });
      });
      for (const name of ['short', 'long']) {
        await assert.rejects(
          () => plain.attachments.get(id, name),
          (error) => {
            assert.strictEqual(error.code, 'BLOB_MISMATCH');
            assert.strictEqual(error.reason, 'length');
            assert.strictEqual(error.id, id);
            assert.strictEqual(error.attachment, name);
            assert.strictEqual(error.digest, entry.digest);
            return true;
          },
        );
      }
      assert.strictEqual((await plain.attachments.get(id, 'ok.txt')).length, 12);
      // Compressed: a register that says fewer bytes than the blob inflates to stops the inflating there — a few KiB of
      // gzip naming a few GiB is never inflated whole; one that says more is a length mismatch after the inflating.
      const zipped = await createStorage(t2, 'MZ', { plugins: [attachments({ compression: 'gzip' })] });
      const zid = await zipped.insert({ title: 'zipped' });
      const big = new Uint8Array(4 * 1024 * 1024);
      const zentry = await zipped.attachments.put(zid, 'zeros.bin', big);
      const stored = await zipped[DB].blobs.get(zentry.digest);
      assert.ok(stored.length < 16 * 1024, `${stored.length} bytes of gzip name 4 MiB`);
      await zipped.transact(async (tx) => {
        await tx.update(zid, { [`${FIELD}/bomb`]: { ...zentry, length: 1024 } });
        await tx.update(zid, { [`${FIELD}/more`]: { ...zentry, length: big.length + 1 } });
      });
      const before = process.memoryUsage().heapUsed;
      await assert.rejects(() => zipped.attachments.get(zid, 'bomb'), { code: 'BLOB_MISMATCH', reason: 'inflated' });
      assert.ok(process.memoryUsage().heapUsed - before < 2 * 1024 * 1024, 'stopped at the register’s length');
      await assert.rejects(() => zipped.attachments.get(zid, 'more'), { code: 'BLOB_MISMATCH', reason: 'length' });
      assert.strictEqual((await zipped.attachments.get(zid, 'zeros.bin')).bytes.length, big.length);
      // Fetched once: the dialer's fetchBlob keeps the bytes, the plugin does not put them again; a store that refuses
      // them is a warning, the bytes answered all the same.
      const inner = syncom.memoryEngine();
      const puts = [];
      let refuse = false;
      const counting = Object.freeze({
        name: 'counting',
        capabilities: inner.capabilities,
        open: async (path, options) => {
          const db = await inner.open(path, options);
          const blobs = {
            ...db.blobs,
            put: async (digest, bytes) => {
              puts.push(digest);
              if (refuse) throw Object.assign(new Error('no room for a blob'), { code: 'ENOSPC' });
              return db.blobs.put(digest, bytes);
            },
          };
          return Object.freeze({ ...db, blobs });
        },
        remove: (path) => inner.remove(path),
      });
      const warnings = [];
      const mesh = await createMesh(t2, ['A', 'B'], [['B', 'A']], async (t3, name, options = {}) => {
        const db = await syncom.createDatabase({
          engine: name === 'B' ? counting : engine,
          path: `${t3.name}/${name}`,
          logger:
            name === 'B' ? { warn: (e) => warnings.push(e), error: () => {}, info: () => {}, debug: () => {} } : false,
          defer: 0,
          plugins: [attachments()],
          ...options,
        });
        t3.after(() => db.close().catch(() => {}));
        return db;
      });
      const a = mesh.get('A');
      const b = mesh.get('B');
      const rid = await a.insert({ title: 'remote' });
      const first = await a.attachments.put(rid, 'one.bin', new Uint8Array(3000).fill(1));
      const second = await a.attachments.put(rid, 'two.bin', new Uint8Array(3000).fill(2));
      await settle([a, b]);
      assert.strictEqual((await b.attachments.get(rid, 'one.bin')).bytes.length, 3000);
      assert.deepStrictEqual(puts, [first.digest], 'kept once, by fetchBlob');
      assert.strictEqual(await b.attachments.has(rid, 'one.bin'), true);
      refuse = true;
      const got = await b.attachments.get(rid, 'two.bin');
      assert.strictEqual(got.bytes.length, 3000);
      assert.deepStrictEqual(puts, [first.digest, second.digest]);
      assert.ok(warnings.some((w) => w.event === 'sync.blob.keep.failed' && w.digest === second.digest));
      assert.strictEqual(await b.attachments.has(rid, 'two.bin'), false, 'fetched again next time');
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
      const answer = await open.call('syncom/blob', { digest: entry.digest });
      assert.strictEqual(answer.digest, entry.digest);
      assert.strictEqual(answer.size, 5000);
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
    'sweep() removes the blobs no live record and no tag names, keeps the rest and a put in flight; dryRun counts; a follower cannot sweep',
    async (t2) => {
      // A gate inside the queue: a write held open holds a put between its blob and its register.
      let gate = null;
      const infos = [];
      const db = await syncom.createDatabase({
        engine,
        path: 'swept',
        logger: { info: (e) => infos.push(e), warn: () => {}, error: () => {}, debug: () => {} },
        defer: 0,
        plugins: [attachments()],
        hooks: { beforeWrite: async () => void (gate === null || (await gate)) },
      });
      t2.after(() => db.close().catch(() => {}));
      const store = db[DB].blobs;
      const digestOf = (text) => hashBytes(bytesOf(text));
      const kept = await db.insert({ title: 'keeps its file' });
      await db.attachments.put(kept, 'a.txt', bytesOf('named by a live record'));
      const unnamed = await db.insert({ title: 'drops its file' });
      await db.attachments.put(unnamed, 'b.txt', bytesOf('named by nobody once removed'));
      await db.attachments.remove(unnamed, 'b.txt');
      const deleted = await db.insert({ title: 'is deleted' });
      await db.attachments.put(deleted, 'c.txt', bytesOf('named by a tombstone'));
      await db.delete(deleted);
      const tagged = await db.insert({ title: 'tagged, then changed' });
      await db.attachments.put(tagged, 'd.txt', bytesOf('named by a tag’s copy alone'));
      await db.tag('v1');
      await db.attachments.remove(tagged, 'd.txt');
      await store.put(await digestOf('named by nothing at all'), bytesOf('named by nothing at all'));
      assert.strictEqual((await store.list()).length, 5);
      // A dry run counts: with the tags, the tag's copy keeps d.txt; without, it goes too.
      const dry = await db.attachments.sweep({ dryRun: true });
      assert.deepStrictEqual(dry, { blobs: 5, marked: 2, removed: 3, pending: 0 });
      assert.strictEqual((await store.list()).length, 5, 'a dry run removes nothing');
      assert.deepStrictEqual(await db.attachments.sweep({ dryRun: true, tags: false }), {
        blobs: 5,
        marked: 1,
        removed: 4,
        pending: 0,
      });
      // A put in flight — its blob stored, its register held in the queue — is kept by the sweep that runs meanwhile.
      const heldId = await db.insert({ title: 'held' });
      let open = null;
      gate = new Promise((resolve) => {
        open = resolve;
      });
      const held = db.attachments.put(heldId, 'e.txt', bytesOf('in flight'));
      try {
        await waitUntil(async () => store.has(await digestOf('in flight')));
        const during = await db.attachments.sweep();
        assert.strictEqual(during.pending, 1);
        assert.strictEqual(during.removed, 3, 'b, c and the stray — not d (the tag), not e (in flight)');
        assert.strictEqual(await store.has(await digestOf('in flight')), true);
        assert.strictEqual(await store.has(await digestOf('named by a tag’s copy alone')), true);
        assert.strictEqual(await store.has(await digestOf('named by nobody once removed')), false);
        assert.strictEqual(await store.has(await digestOf('named by a tombstone')), false);
        assert.strictEqual(await store.has(await digestOf('named by nothing at all')), false);
      } finally {
        open();
        gate = null;
      }
      await held;
      assert.deepStrictEqual(await db.attachments.sweep(), { blobs: 3, marked: 3, removed: 0, pending: 0 });
      assert.deepStrictEqual(
        [...(await db.attachments.get(kept, 'a.txt')).bytes],
        [...bytesOf('named by a live record')],
      );
      assert.strictEqual(
        (await db.at('v1').get(tagged))[FIELD]?.['d.txt']?.length,
        bytesOf('named by a tag’s copy alone').length,
        'the tag still reads the register whose bytes the sweep kept',
      );
      const line = infos.find((e) => e.event === 'attachments.sweep');
      assert.ok(line !== undefined && typeof line.ms === 'number' && line.removed === 3);
      // A follower cannot sweep (READ_ONLY); a closed database neither.
      const follower = await syncom.createDatabase({
        engine,
        path: 'swept',
        logger: false,
        readOnly: true,
        plugins: [attachments()],
      });
      t2.after(() => follower.close().catch(() => {}));
      await assert.rejects(() => follower.attachments.sweep(), { code: 'READ_ONLY' });
      const closing = await createStorage(t2, 'closing');
      const sweep = closing.attachments;
      await closing.close();
      await assert.rejects(() => sweep.sweep(), { code: 'CLOSED' });
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
