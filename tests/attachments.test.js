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
const { atRest } = require('../src/encryption/encryption.js');
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
    "a blob at the cap is stored at rest — the seal's 28 bytes are the store's to hold — and one past it is BLOB_TOO_LARGE at the door",
    async (t2) => {
      const sealed = atRest(syncom.memoryEngine(), { key: new Uint8Array(32).fill(3) });
      const db = await syncom.createDatabase({
        engine: sealed,
        path: 'cap',
        logger: false,
        defer: 0,
        plugins: [attachments()],
      });
      t2.after(() => db.close().catch(() => {}));
      const id = await db.insert({ title: 'at the cap' });
      const atCap = new Uint8Array(MAX_BLOB_BYTES);
      atCap[0] = 1;
      atCap[MAX_BLOB_BYTES - 1] = 2;
      const entry = await db.attachments.put(id, 'cap.bin', atCap, { type: 'application/octet-stream' });
      assert.strictEqual(entry.length, MAX_BLOB_BYTES);
      const got = await db.attachments.get(id, 'cap.bin', { fetch: false });
      assert.strictEqual(got.bytes.length, MAX_BLOB_BYTES);
      assert.deepStrictEqual([got.bytes[0], got.bytes[MAX_BLOB_BYTES - 1]], [1, 2]);
      await assert.rejects(db.attachments.put(id, 'over.bin', new Uint8Array(MAX_BLOB_BYTES + 1)), {
        code: 'BLOB_TOO_LARGE',
      });
      await assert.rejects(db[DB].blobs.put('a'.repeat(64), new Uint8Array(MAX_BLOB_BYTES + 1)), {
        code: 'BLOB_TOO_LARGE',
      });
    },
  );

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
    'a dialer uploads the bytes of the registers it pushed (syncom/blobPut): A — H — B and A — H1 — H2 — B read what A attached; bytes the dialer lacks wait until they land; a refused upload is reported, never fatal',
    async (t2) => {
      // A and B both dial the hub H: the bytes go up with A's push, and B reads them from H.
      const hub = await createMesh(
        t2,
        ['H', 'A', 'B'],
        [
          ['A', 'H'],
          ['B', 'H'],
        ],
        createStorage,
      );
      const [h, a, b] = ['H', 'A', 'B'].map((name) => hub.get(name));
      await a.sync.awaitInitialReplication();
      await b.sync.awaitInitialReplication();
      const id = await a.insert({ title: 'with a file' });
      await a.attachments.put(id, 'notes.txt', bytesOf('from A'), { type: 'text/plain' });
      await settle([h, a, b]);
      assert.strictEqual(await h.attachments.has(id, 'notes.txt'), true, 'the hub holds the bytes');
      assert.strictEqual(await b.attachments.has(id, 'notes.txt'), false, 'down on a read, not ahead of it');
      assert.strictEqual(new TextDecoder().decode((await b.attachments.get(id, 'notes.txt')).bytes), 'from A');
      // Two hubs: A2 dials H1, H1 dials H2, B2 dials H2. H1 relays the register before A2's bytes reach it; once
      // they land there, H1 uploads them to H2.
      const chain = await createMesh(
        t2,
        ['H1', 'H2', 'A2', 'B2'],
        [
          ['A2', 'H1'],
          ['H1', 'H2'],
          ['B2', 'H2'],
        ],
        createStorage,
      );
      const [h1, h2, a2, b2] = ['H1', 'H2', 'A2', 'B2'].map((name) => chain.get(name));
      await a2.sync.awaitInitialReplication();
      await h1.sync.awaitInitialReplication();
      await b2.sync.awaitInitialReplication();
      const far = await a2.insert({ title: 'two hubs away' });
      await a2.attachments.put(far, 'far.bin', new Uint8Array(3000).fill(7), { type: 'application/octet-stream' });
      await settle([h1, h2, a2, b2]);
      await waitUntil(() => h2.attachments.has(far, 'far.bin'));
      const got = await b2.attachments.get(far, 'far.bin');
      assert.strictEqual(got.bytes.length, 3000);
      // A relay that never fetched the bytes has nothing to upload: it waits, and uploads once they land (here a read
      // on the relay fetches them from its host).
      const relay = await createMesh(
        t2,
        ['R0', 'R1', 'R2'],
        [
          ['R1', 'R0'],
          ['R1', 'R2'],
        ],
        createStorage,
      );
      const [r0, r1, r2] = ['R0', 'R1', 'R2'].map((name) => relay.get(name));
      await r1.sync.awaitInitialReplication();
      const kept = await r0.insert({ title: 'on the first host' });
      await r0.attachments.put(kept, 'kept.txt', bytesOf('on R0'), { type: 'text/plain' });
      await settle([r0, r1, r2]);
      assert.strictEqual(await r2.attachments.has(kept, 'kept.txt'), false, 'R1 held no bytes to upload');
      await r1.attachments.get(kept, 'kept.txt');
      await waitUntil(() => r2.attachments.has(kept, 'kept.txt'));
      // A host whose limit refuses the bytes: the push stands, the upload is reported (BLOB_UPLOAD_FAILED).
      const strict = await createMesh(t2, ['S', 'C'], [['C', 'S']], createStorage, {
        unit: { access: 'public', limits: { bytesPerBlob: 10 } },
      });
      const [s, c] = ['S', 'C'].map((name) => strict.get(name));
      const errors = [];
      c.sync.on('error', (error) => errors.push(error));
      await c.sync.awaitInitialReplication();
      const big = await c.insert({ title: 'too big for S' });
      const bigEntry = await c.attachments.put(big, 'big.bin', new Uint8Array(100).fill(1), { type: 'x/y' });
      await settle([s, c]);
      assert.deepStrictEqual((await s.get(big))[FIELD], { 'big.bin': bigEntry }, 'the push stands');
      assert.strictEqual(await s.attachments.has(big, 'big.bin'), false);
      const [failed] = errors.filter((error) => error.code === 'BLOB_UPLOAD_FAILED');
      assert.strictEqual(failed.digest, bigEntry.digest);
      assert.strictEqual(failed.id, big);
      assert.strictEqual(failed.attachment, 'big.bin');
      assert.strictEqual(failed.cause.code, 413);
      assert.strictEqual(failed.retry, false, 'a refusal is final');
    },
  );

  // What a node still has to upload, as the root kv holds it (src/sync/uploads.js).
  const queued = async (db) => {
    const text = await db[DB].kv.get('', 'uploads.json');
    return text === null ? null : JSON.parse(text);
  };

  await t.test(
    'what waits to go up survives a restart: a dialer closed before its bytes went up uploads them at the next hello, with no new write',
    async (t2) => {
      const { MemoryLink } = require('./utils/memory-link.js');
      const host = await createStorage(t2, 'H');
      const unit = host.sync.unit({ access: 'public' });
      // A text link that takes no message past 4 KiB: the push lands, and the bytes — base64 in one call — take the
      // link down with them.
      let dial = null;
      const open = (hazards) =>
        createStorage(t2, 'A', {
          sync: { connect: () => (dial = new MemoryLink(unit, hazards)), autoStart: false },
        });
      const first = await open({ maxMessage: 4 * 1024 });
      const failures = [];
      first.sync.on('error', (error) => failures.push(error));
      await first.sync.addNode({ url: 'mem://H' });
      await first.sync.start();
      await first.sync.awaitInitialReplication();
      const id = await first.insert({ title: 'cut off' });
      const bytes = new Uint8Array(20_000).fill(5);
      const entry = await first.attachments.put(id, 'cut.bin', bytes, { type: 'x/y' });
      await waitUntil(() => failures.some((error) => error.code === 'BLOB_UPLOAD_FAILED'));
      const [failed] = failures.filter((error) => error.code === 'BLOB_UPLOAD_FAILED');
      assert.strictEqual(failed.retry, true, 'a transport that failed: tried again');
      assert.strictEqual(dial.down, true);
      assert.deepStrictEqual((await host.get(id))[FIELD], { 'cut.bin': entry }, 'the push landed');
      assert.strictEqual(await host.attachments.has(id, 'cut.bin'), false, 'the bytes did not');
      // The process ends here: what waits is on disk, by node, the record and the name with the digest.
      await first.close();
      const again = await open({});
      assert.deepStrictEqual(await queued(again), { v: 1, nodes: { 'mem://H': [[entry.digest, id, 'cut.bin']] } });
      // Nothing is written: the hello alone takes the upload up again, behind its (empty) push.
      await again.sync.start();
      await waitUntil(() => host.attachments.has(id, 'cut.bin'));
      same((await host.attachments.get(id, 'cut.bin', { fetch: false })).bytes, bytes);
      assert.strictEqual(dial.calls.includes('syncom/push'), false, 'no page was pushed for it');
      assert.deepStrictEqual(
        dial.calls.filter((method) => method === 'syncom/blobPut'),
        ['syncom/blobPut', 'syncom/blobPut'],
        'a probe, then the bytes',
      );
      // Gone from the queue with the upload, and from the disk: a third open asks nothing.
      await waitUntil(async () => (await queued(again)).nodes['mem://H'] === undefined);
      await again.close();
      const third = await open({});
      await third.sync.start();
      await third.sync.awaitInitialReplication();
      assert.strictEqual(dial.calls.includes('syncom/blobPut'), false);
    },
  );

  await t.test(
    'an upload refused for good is not asked again after a restart, one whose record names it no more is refused once (404) and gone; the queue keeps 1024 entries a node, the oldest let go, and a node removed takes its entries',
    async (t2) => {
      const { MemoryLink } = require('./utils/memory-link.js');
      const strict = await createStorage(t2, 'S');
      const unit = strict.sync.unit({ access: 'public', limits: { bytesPerBlob: 10 } });
      let dial = null;
      const open = () =>
        createStorage(t2, 'C', { sync: { connect: () => (dial = new MemoryLink(unit)), autoStart: false } });
      const first = await open();
      const errors = [];
      first.sync.on('error', (error) => errors.push(error));
      await first.sync.addNode({ url: 'mem://S' });
      await first.sync.start();
      await first.sync.awaitInitialReplication();
      const big = await first.insert({ title: 'too big for S' });
      await first.attachments.put(big, 'big.bin', new Uint8Array(100).fill(1), { type: 'x/y' });
      await waitUntil(() => errors.some((error) => error.code === 'BLOB_UPLOAD_FAILED'));
      assert.strictEqual(errors.find((error) => error.code === 'BLOB_UPLOAD_FAILED').retry, false);
      await first.sync.awaitInSync();
      await first.close();
      const again = await open();
      assert.deepStrictEqual(await queued(again), { v: 1, nodes: {} }, 'refused for good: nothing waits');
      const told = [];
      again.sync.on('error', (error) => told.push(error));
      await again.sync.start();
      await again.sync.awaitInitialReplication();
      assert.strictEqual(dial.calls.includes('syncom/blobPut'), false, 'never asked again');
      assert.deepStrictEqual(told, []);
      // An entry whose record names the digest no more: it waited for bytes this node lacked, the name was taken
      // off the record, and the bytes came. The host's one answer for every miss (404) is final too — told once,
      // gone from the disk, nothing loops.
      const late = bytesOf('late');
      const lateDigest = await hashBytes(late);
      await again.update(big, { [`${FIELD}/late.bin`]: { digest: lateDigest, type: 'x/y', length: late.length } });
      await again.sync.awaitInSync();
      await again.unset(big, [`${FIELD}/late.bin`]);
      await again.sync.awaitInSync();
      await again[DB].blobs.put(lateDigest, late);
      await again.close();
      const unnamed = await open();
      assert.deepStrictEqual(await queued(unnamed), { v: 1, nodes: { 'mem://S': [[lateDigest, big, 'late.bin']] } });
      unnamed.sync.on('error', (error) => told.push(error));
      await unnamed.sync.start();
      await unnamed.sync.awaitInitialReplication();
      assert.strictEqual(told.length, 1);
      assert.deepStrictEqual(
        [told[0].code, told[0].cause.code, told[0].cause.reason, told[0].retry, told[0].attachment],
        ['BLOB_UPLOAD_FAILED', 404, 'NOT_NAMED', false, 'late.bin'],
      );
      assert.deepStrictEqual(
        dial.calls.filter((method) => method === 'syncom/blobPut'),
        ['syncom/blobPut'],
        'one probe, never the bytes',
      );
      await waitUntil(async () => (await queued(unnamed)).nodes['mem://S'] === undefined);
      await unnamed.close();
      // The bound: 1030 registers whose bytes this node lacks (written by hand, as a relay holds them) leave the
      // newest 1024 waiting — in memory and on disk — and nothing is asked of the host for them.
      const digestOf = (n) => n.toString(16).padStart(64, '0');
      const relay = await open();
      await relay.sync.start();
      await relay.sync.awaitInitialReplication();
      assert.strictEqual(dial.calls.includes('syncom/blobPut'), false, 'nor after another restart');
      const many = await relay.insert({ title: 'many' });
      const delta = {};
      for (let i = 0; i < 1030; i++) delta[`${FIELD}/f${i}`] = { digest: digestOf(i), type: 'x/y', length: 1 };
      await relay.update(many, delta);
      await relay.sync.awaitInSync();
      await waitUntil(async () => (await queued(relay))?.nodes['mem://S']?.length === 1024);
      const kept = (await queued(relay)).nodes['mem://S'];
      assert.deepStrictEqual(kept[0], [digestOf(6), many, 'f6'], 'the six oldest were let go');
      assert.deepStrictEqual(kept[1023], [digestOf(1029), many, 'f1029']);
      assert.strictEqual(dial.calls.includes('syncom/blobPut'), false, 'bytes this node lacks are not offered');
      await relay.close();
      const third = await open();
      await third.sync.start();
      await third.sync.awaitInitialReplication();
      assert.strictEqual((await queued(third)).nodes['mem://S'].length, 1024, 'the bound holds across a restart');
      assert.strictEqual(dial.calls.includes('syncom/blobPut'), false);
      // The bytes of one of them come by another way (a local put of the same bytes): named again, it is looked
      // at again and goes up.
      const landed = new Uint8Array([7, 7, 7]);
      const digest = await hashBytes(landed);
      await third.update(many, { [`${FIELD}/late`]: { digest, type: 'x/y', length: 3 } });
      await third.sync.awaitInSync();
      assert.strictEqual(await strict[DB].blobs.has(digest), false, 'named, not held: it waits');
      await third[DB].blobs.put(digest, landed);
      await third.update(many, { [`${FIELD}/again`]: { digest, type: 'x/y', length: 3 } });
      await waitUntil(() => strict[DB].blobs.has(digest));
      // A node removed takes what waited for it.
      await third.sync.removeNode('mem://S');
      await waitUntil(async () => (await queued(third)).nodes['mem://S'] === undefined);
    },
  );

  await t.test(
    'uploads.json that does not read is said and read as none, a row that is none is left out; a save that fails is logged and fails neither the push nor the upload',
    async (t2) => {
      const { MemoryLink } = require('./utils/memory-link.js');
      const host = await createStorage(t2, 'H');
      const unit = host.sync.unit({ access: 'public' });
      const warnings = [];
      const logger = { warn: (event) => warnings.push(event), error: () => {}, info: () => {}, debug: () => {} };
      let dial = null;
      const sync = { connect: () => (dial = new MemoryLink(unit)), autoStart: false };
      const first = await createStorage(t2, 'A', { sync, logger });
      await first.sync.addNode({ url: 'mem://H' });
      await first.sync.start();
      await first.sync.awaitInitialReplication();
      // A register pushed by hand: the host names bytes this node holds and never offered.
      const bytes = bytesOf('kept on disk');
      const digest = await hashBytes(bytes);
      const id = await first.insert({ title: 'by hand' });
      await first.update(id, { [`${FIELD}/f`]: { digest, type: 'text/plain', length: bytes.length } });
      await first.sync.awaitInSync();
      await first[DB].blobs.put(digest, bytes);
      await first.close();
      // The file as a hand or another build could leave it: one row that is one, the rest none.
      const raw = await engine.open(`${t2.name}/A`, { logger });
      const write = (value) =>
        raw.kv.put('', 'uploads.json', typeof value === 'string' ? value : JSON.stringify(value));
      const rows = [[digest, id, 'f'], ['no digest', id, 'f'], 'no row', ['a'.repeat(64), 7, 'f'], [digest, id]];
      await write({ v: 1, nodes: { 'mem://H': rows, 'mem://gone': [[digest, id, 'f']], 'mem://bad': 'no list' } });
      const second = await createStorage(t2, 'A', { sync, logger });
      await second.sync.start();
      await waitUntil(() => host[DB].blobs.has(digest));
      assert.deepStrictEqual(
        dial.calls.filter((method) => method === 'syncom/blobPut'),
        ['syncom/blobPut', 'syncom/blobPut'],
        'the one row that is one went up',
      );
      await waitUntil(async () => (await queued(second)).nodes['mem://H'] === undefined);
      assert.deepStrictEqual(await queued(second), { v: 1, nodes: {} }, 'a node that is not registered keeps none');
      await second.close();
      // A text that does not read, another version, no nodes: said where it does not parse, read as none.
      for (const value of ['{nope', { v: 2, nodes: { 'mem://H': [[digest, id, 'f']] } }, { v: 1, nodes: [] }, 'null']) {
        await write(value);
        warnings.length = 0;
        const opened = await createStorage(t2, 'A', { sync, logger });
        const unreadable = warnings.filter((event) => event.event === 'sync.uploads.unreadable').length;
        assert.strictEqual(unreadable, value === '{nope' ? 1 : 0);
        await opened.sync.start();
        await opened.sync.awaitInitialReplication();
        assert.strictEqual(dial.calls.includes('syncom/blobPut'), false, 'nothing waits');
        await opened.close();
      }
      await raw.close();
      // A medium that refuses the file: logged, and the push and the upload go on without it.
      const plain = syncom.memoryEngine();
      const refusing = Object.freeze({
        name: 'no-uploads-file',
        capabilities: plain.capabilities,
        open: async (path, options) => {
          const db = await plain.open(path, options);
          const put = (ns, key, value, hints) =>
            key === 'uploads.json' ? Promise.reject(new Error('disk full')) : db.kv.put(ns, key, value, hints);
          return Object.freeze({ ...db, kv: { ...db.kv, put } });
        },
        remove: (path) => plain.remove(path),
      });
      warnings.length = 0;
      const poor = await createStorage(t2, 'P', { engine: refusing, sync, logger });
      await poor.sync.addNode({ url: 'mem://H' });
      await poor.sync.start();
      await poor.sync.awaitInitialReplication();
      const other = await poor.insert({ title: 'on a full disk' });
      await poor.attachments.put(other, 'g', bytesOf('goes up all the same'), { type: 'text/plain' });
      await waitUntil(() => host.attachments.has(other, 'g'));
      await poor.sync.stop();
      assert.ok(warnings.some((event) => event.event === 'sync.uploads.failed' && event.err.message === 'disk full'));
    },
  );

  await t.test(
    'syncom/blobPut takes the bytes a live record in the peer’s scopes names, checked against the digest and the limits; a probe without bytes answers whether the host holds them',
    async (t2) => {
      const scope = (id, data) => data.$type ?? '*';
      const host = await createStorage(t2, 'H', { sync: { scope } });
      const { MemoryLink } = require('./utils/memory-link.js');
      const { toBase64 } = require('../src/crypto/pem.js');
      const bytes = bytesOf('the bytes');
      const digest = await hashBytes(bytes);
      const register = { digest, type: 'text/plain', length: bytes.length };
      const id = await host.insert({ $type: 'A', [`${FIELD}/f`]: register });
      const open = async (scopes, options = {}) => {
        const link = new MemoryLink(host.sync.unit({ access: 'public', ...options }));
        await link.call('syncom/hello', { node: `peer-${scopes.join('-')}`, version: 1, scopes });
        return (args) => link.call('syncom/blobPut', args);
      };
      const put = await open(['A']);
      // A probe: not held — and this link carries no stream, so the bytes would come as base64.
      assert.deepStrictEqual(await put({ digest, id, name: 'f' }), { digest, have: false, stream: false });
      await assert.rejects(put({ digest: 'xyz', id, name: 'f' }), { code: 400, reason: 'BAD_DIGEST' });
      await assert.rejects(put({ digest, id, name: 'f', base64: 7 }), { code: 400, reason: 'BAD_BLOB' });
      // The digest under another name, another digest, no record: one answer, nothing told.
      await assert.rejects(put({ digest, id, name: 'g', base64: toBase64(bytes) }), {
        code: 404,
        reason: 'NOT_NAMED',
      });
      const other = await hashBytes(bytesOf('other'));
      await assert.rejects(put({ digest: other, id, name: 'f', base64: toBase64(bytesOf('other')) }), {
        code: 404,
        reason: 'NOT_NAMED',
      });
      await assert.rejects(put({ digest, name: 'f', base64: toBase64(bytes) }), { code: 404, reason: 'NOT_NAMED' });
      // A record outside the peer's scopes is none.
      const outsider = await open(['B']);
      await assert.rejects(outsider({ digest, id, name: 'f', base64: toBase64(bytes) }), {
        code: 404,
        reason: 'NOT_NAMED',
      });
      // Bytes that are not the digest.
      await assert.rejects(put({ digest, id, name: 'f', base64: toBase64(bytesOf('forged!!!')) }), {
        code: 400,
        reason: 'BLOB_MISMATCH',
      });
      // Past the unit's limit.
      const small = await open(['A'], { limits: { bytesPerBlob: 4 } });
      await assert.rejects(small({ digest, id, name: 'f', base64: toBase64(bytes) }), {
        code: 413,
        reason: 'BYTES_PER_BLOB',
      });
      assert.throws(() => host.sync.unit({ limits: { bytesPerBlob: 0 } }), { name: 'TypeError' });
      // A unit that takes no pushes takes no bytes.
      const mirror = await open(['A'], { allow: { push: false } });
      await assert.rejects(mirror({ digest, id, name: 'f', base64: toBase64(bytes) }), {
        code: 403,
        reason: 'READ_ONLY',
      });
      assert.strictEqual(await host[DB].blobs.has(digest), false, 'nothing refused was kept');
      // Taken: kept, and a probe after says so.
      assert.deepStrictEqual(await put({ digest, id, name: 'f', base64: toBase64(bytes) }), { digest, have: true });
      same(await host[DB].blobs.get(digest), bytes);
      assert.deepStrictEqual(await put({ digest, id, name: 'f' }), { digest, have: true });
      // Before hello there is no peer to take bytes from.
      const stranger = new MemoryLink(host.sync.unit({ access: 'public' }));
      await assert.rejects(stranger.call('syncom/blobPut', { digest, id, name: 'f' }), { code: 428 });
    },
  );

  await t.test(
    'the bytes cross as a stream where the link carries one: a blob larger than one message goes up and comes down in pieces through two hubs; a link down mid-way is tried again',
    async (t2) => {
      // Every link a binary transport that takes no message past 256 KiB: the blob as base64 in a call, or as one
      // chunk of a stream, would take the link down.
      const link = { streams: true, maxMessage: 256 * 1024 };
      const mesh = await createMesh(
        t2,
        ['H1', 'H2', 'A', 'B'],
        [
          ['A', 'H1'],
          ['H1', 'H2'],
          ['B', 'H2'],
        ],
        createStorage,
        { link },
      );
      const [h1, h2, a, b] = ['H1', 'H2', 'A', 'B'].map((name) => mesh.get(name));
      const errors = [];
      for (const node of [a, h1, b]) node.sync.on('error', (error) => errors.push(error));
      await a.sync.awaitInitialReplication();
      await h1.sync.awaitInitialReplication();
      await b.sync.awaitInitialReplication();
      // 17 pieces of 64 KiB, the last a short one: writeAll waits for the link's drain on the way.
      const bytes = new Uint8Array(1024 * 1024 + 7);
      for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31) % 251;
      const id = await a.insert({ title: 'a film' });
      const entry = await a.attachments.put(id, 'film.bin', bytes, { type: 'video/mp4' });
      await a.attachments.put(id, 'empty.bin', new Uint8Array(0), { type: 'application/octet-stream' });
      await settle([h1, h2, a, b]);
      await waitUntil(() => h2.attachments.has(id, 'film.bin'));
      await waitUntil(() => h2.attachments.has(id, 'empty.bin'));
      const got = await b.attachments.get(id, 'film.bin');
      assert.strictEqual(got.bytes.length, bytes.length);
      assert.strictEqual(await hashBytes(got.bytes), entry.digest);
      assert.strictEqual(
        (await b.attachments.get(id, 'empty.bin')).bytes.length,
        0,
        'an empty blob is a stream of no bytes',
      );
      assert.deepStrictEqual(errors, []);
      for (const dialed of mesh.links.values()) assert.strictEqual(dialed.down, false, 'no message was too big');

      // A link that goes down with the bytes on their way (not one piece fits its messages): the upload is reported
      // as a transport's failure, and tried again once the link is back.
      const { MemoryLink } = require('./utils/memory-link.js');
      const hazards = { streams: true, maxMessage: 8 * 1024 };
      const s = await createStorage(t2, 'S');
      const unit = s.sync.unit({ access: 'public' });
      let dial = null;
      const c = await createStorage(t2, 'C', {
        sync: { connect: () => (dial = new MemoryLink(unit, hazards)), autoStart: false },
      });
      const failures = [];
      c.sync.on('error', (error) => failures.push(error));
      await c.sync.addNode({ url: 'mem://S' });
      await c.sync.start();
      await c.sync.awaitInitialReplication();
      const big = await c.insert({ title: 'cut off' });
      const cut = await c.attachments.put(big, 'cut.bin', bytes.subarray(0, 100_000), { type: 'x/y' });
      await waitUntil(() => failures.some((error) => error.code === 'BLOB_UPLOAD_FAILED'));
      const [failed] = failures.filter((error) => error.code === 'BLOB_UPLOAD_FAILED');
      assert.strictEqual(failed.digest, cut.digest);
      assert.strictEqual(failed.cause.code, 503);
      assert.strictEqual(failed.retry, true, 'a transport that failed is tried again');
      assert.strictEqual(dial.down, true);
      assert.strictEqual(await s.attachments.has(big, 'cut.bin'), false);
      hazards.maxMessage = undefined;
      await dial.reconnect();
      await waitUntil(() => s.attachments.has(big, 'cut.bin'));
      assert.strictEqual(await hashBytes((await s.attachments.get(big, 'cut.bin')).bytes), cut.digest);

      // What a host answers for a streamed blob is held to the size it says: more, less or none is no blob.
      const t1 = await createStorage(t2, 'T');
      const served = t1.sync.unit({ access: 'public' });
      let answer = (page) => page;
      const tampering = () => {
        const tampered = new MemoryLink(served, { streams: true });
        const call = tampered.call.bind(tampered);
        tampered.call = async (method, args) => {
          const page = await call(method, args);
          return method === 'syncom/blob' ? answer(page) : page;
        };
        return tampered;
      };
      const reader = await createStorage(t2, 'R', { sync: { connect: tampering, autoStart: false } });
      await reader.sync.addNode({ url: 'mem://T' });
      await reader.sync.start();
      await reader.sync.awaitInitialReplication();
      const held = await t1.insert({ title: 'held' });
      const kept = await t1.attachments.put(held, 'kept.bin', bytes.subarray(0, 70_000), { type: 'x/y' });
      await settle([t1, reader]);
      const named = { id: held, name: 'kept.bin' };
      for (const size of [kept.length + 1, kept.length - 1, 'many', -1]) {
        answer = (page) => ({ ...page, size });
        await assert.rejects(reader.sync.fetchBlob(kept.digest, named), (error) => {
          assert.strictEqual(error.code, 'BLOB_NOT_FOUND');
          assert.strictEqual(error.cause.code, 'BAD_PAGE', String(size));
          return true;
        });
      }
      answer = (page) => page;
      assert.strictEqual((await reader.sync.fetchBlob(kept.digest, named)).length, 70_000);
    },
  );

  await t.test(
    'syncom/blobPut over a stream: the pieces are read to the size announced and no further; a stream missing, short, long, forged, unnamed or past the limit is refused and let go, its writer told',
    async (t2) => {
      const scope = (id, data) => data.$type ?? '*';
      const host = await createStorage(t2, 'H', { sync: { scope } });
      const { MemoryLink } = require('./utils/memory-link.js');
      const bytes = bytesOf('the bytes');
      const digest = await hashBytes(bytes);
      const register = { digest, type: 'text/plain', length: bytes.length };
      const id = await host.insert({ $type: 'A', [`${FIELD}/f`]: register });
      const open = async (scopes, options = {}, hazards = { streams: true }) => {
        const link = new MemoryLink(host.sync.unit({ access: 'public', ...options }), hazards);
        await link.call('syncom/hello', { node: `peer-${scopes.join('-')}`, version: 1, scopes });
        return link;
      };
      // A stream announced, the call that names it, then the chunks — as the dialer does it.
      const send = (link, args, chunks, { end = true } = {}) => {
        const stream = link.createStream('syncom/blobPut', args.size);
        const taking = link.call('syncom/blobPut', { ...args, stream: stream.id });
        for (const chunk of chunks) stream.write(chunk);
        if (end) stream.end();
        return Object.assign(taking, { stream });
      };
      const peer = await open(['A']);
      const size = bytes.length;
      const named = { digest, id, name: 'f' };
      assert.deepStrictEqual(
        await peer.call('syncom/blobPut', named),
        { digest, have: false, stream: true },
        'a probe',
      );
      const bad = { code: 400, reason: 'BAD_BLOB' };
      // No such stream; a size that is none; the bytes both ways at once.
      await assert.rejects(peer.call('syncom/blobPut', { ...named, stream: 'nope', size }), bad);
      await assert.rejects(send(peer, { ...named, size: -1 }, []), bad);
      await assert.rejects(send(peer, { ...named, size: 1.5 }, [bytes]), bad);
      await assert.rejects(send(peer, { ...named, size, base64: 'AA==' }, [bytes]), bad);
      // Fewer bytes than announced, then more: never waited for, never read past.
      await assert.rejects(send(peer, { ...named, size: size + 1 }, [bytes]), bad);
      await assert.rejects(send(peer, { ...named, size: size - 1 }, [bytes]), bad);
      // The size right, the bytes not the digest; a stream of no bytes is a stream too, and no digest of these.
      const mismatch = { code: 400, reason: 'BLOB_MISMATCH' };
      await assert.rejects(send(peer, { ...named, size }, [bytesOf('forged!!!')]), mismatch);
      await assert.rejects(send(peer, { ...named, size: 0 }, []), mismatch);
      // No record of the peer's names it: refused before a byte is read, and the writer is told to stop (wrpc 2.1).
      const unnamed = send(peer, { ...named, name: 'g', size }, [], { end: false });
      await assert.rejects(unnamed, { code: 404, reason: 'NOT_NAMED' });
      assert.strictEqual(unnamed.stream.closed, true, 'the host let go of the stream');
      assert.strictEqual(unnamed.stream.error.code, 499);
      assert.strictEqual(unnamed.stream.write(bytes), false, 'nothing more is taken');
      const outsider = await open(['B']);
      await assert.rejects(send(outsider, { ...named, size }, [bytes]), { code: 404, reason: 'NOT_NAMED' });
      // Past the unit's limit by the size announced.
      const small = await open(['A'], { limits: { bytesPerBlob: 4 } });
      await assert.rejects(send(small, { ...named, size }, [bytes]), { code: 413, reason: 'BYTES_PER_BLOB' });
      // A link that carries no stream cannot name one.
      const text = await open(['A'], {}, {});
      await assert.rejects(text.call('syncom/blobPut', { ...named, stream: 's1', size }), bad);
      assert.strictEqual(await host[DB].blobs.has(digest), false, 'nothing refused was kept');
      // Taken, in two pieces.
      const pieces = [bytes.subarray(0, 4), bytes.subarray(4)];
      assert.deepStrictEqual(await send(peer, { ...named, size }, pieces), { digest, have: true });
      same(await host[DB].blobs.get(digest), bytes);
      // Held already: answered before a byte is read.
      assert.deepStrictEqual(await send(peer, { ...named, size }, [], { end: false }), { digest, have: true });
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
