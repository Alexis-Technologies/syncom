'use strict';

// Equivocation: one writer, two ops at one seq of one stream — a directory
// restored from a backup, a second instance under the same identity, or a
// key holder that lies. Every op names the fingerprint of the op before it
// in its stream (`prev`, signed), and a node compares what it holds with
// what it is handed: two ops at one seq are reported (EQUIVOCATION), and an
// op that names a predecessor other than the one held is refused.

const test = require('node:test');
const assert = require('node:assert');
const syncom = require('../src/all/all.js');
const core = require('../index.js');
const { memory } = require('../src/memory/memory.js');
const { packOps, unpackOps } = require('../src/ops.js');
const { signOp } = require('../src/signing/sign.js');
const { createMesh, waitUntil } = require('./utils/mesh.js');

const FINGERPRINT = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
// A fingerprint of the right shape that names no op.
const STRANGER = `${'f'.repeat(42)}A`;

const open = async (t, options = {}, build = syncom) => {
  const storage = await build.open({ path: '/x', fsi: memory(), logger: false, defer: 0, ...options });
  t.after(() => storage.close().catch(() => {}));
  return storage;
};

// A copy of a backend in memory, file by file.
const cloneOf = async (fsi) => {
  const copy = memory();
  for (const [key, text] of Object.entries(fsi.dump())) {
    const at = key.lastIndexOf('/');
    await copy.write(key.slice(0, at), key.slice(at + 1), text);
  }
  return copy;
};

// One identity in two directories: a node's directory copied — a restored
// backup, a second instance — each copy minting the same seqs for its own ops.
const forked = async (t, build = syncom, prepare = null) => {
  const fsi = memory();
  const first = await open(t, { fsi, path: '/m' }, build);
  if (prepare !== null) await prepare(first);
  await first.close();
  const twin = await cloneOf(fsi);
  return [await open(t, { fsi, path: '/m' }, build), await open(t, { fsi: twin, path: '/m' }, build)];
};

// Ops as a peer receives them: packed, through JSON, unpacked.
const wire = (ops) => unpackOps(JSON.parse(JSON.stringify(packOps(ops))));
const entryOf = (storage, origin, seq) => {
  for (const entry of storage.log.scan()) if (entry.op.origin === origin && entry.op.seq === seq) return entry;
  return undefined;
};
const opOf = (storage, origin, seq) => wire([entryOf(storage, origin, seq).op])[0];
const errorsOf = (storage) => {
  const errors = [];
  storage.on('error', (error) => errors.push(error));
  return errors;
};

test('Equivocation: two ops of one stream at one seq', async (t) => {
  await t.test(
    'hosts that hold two ops of one seq report EQUIVOCATION with both fingerprints; neither takes the other',
    async (t2) => {
      const [m1, m2] = await forked(t2);
      const origin = m1.nodeId;
      assert.strictEqual(m2.nodeId, origin, 'one identity');
      await m1.set('doc', { title: 'x' });
      await m2.set('doc', { title: 'y' });
      const x = opOf(m1, origin, 1);
      const y = opOf(m2, origin, 1);
      const errors = new Map();
      // The forked writer pushed one op to each host before the hosts met;
      // then each dials the other.
      const mesh = await createMesh(
        t2,
        ['H1', 'H2'],
        [
          ['H1', 'H2'],
          ['H2', 'H1'],
        ],
        async (t3, name, options) => {
          const storage = await open(t3, { path: `/${name}`, ...options });
          errors.set(name, errorsOf(storage));
          const result = await storage.applyRemote([name === 'H1' ? x : y]);
          assert.strictEqual(result.applied, 1);
          return storage;
        },
      );
      const h1 = mesh.get('H1');
      const h2 = mesh.get('H2');
      const reported = (name) => errors.get(name).filter((error) => error.code === 'EQUIVOCATION');
      await waitUntil(() => reported('H1').length > 0 && reported('H2').length > 0);
      const [one] = reported('H1');
      const [two] = reported('H2');
      const held1 = entryOf(h1, origin, 1).fp;
      const held2 = entryOf(h2, origin, 1).fp;
      assert.match(held1, FINGERPRINT);
      assert.match(held2, FINGERPRINT);
      assert.notStrictEqual(held1, held2);
      // Each names what it holds and what it was handed: the other's.
      assert.deepStrictEqual(
        [one.reason, one.origin, one.scope, one.seq, one.held, one.received, one.count],
        ['seq', origin, null, 1, held1, held2, 1],
      );
      assert.deepStrictEqual(
        [two.reason, two.origin, two.scope, two.seq, two.held, two.received, two.count],
        ['seq', origin, null, 1, held2, held1, 1],
      );
      assert.strictEqual(one.op.data.title, 'y');
      assert.strictEqual(two.op.data.title, 'x');
      // The author fingerprints its op as every node does.
      assert.strictEqual(entryOf(m1, origin, 1).fp, held1);
      assert.strictEqual(entryOf(m2, origin, 1).fp, held2);
      // Neither took the other's version: not applied, not logged, not relayed.
      assert.deepStrictEqual(await h1.get('doc'), { title: 'x' });
      assert.deepStrictEqual(await h2.get('doc'), { title: 'y' });
      let theirs = 0;
      for (const entry of h1.log.scan()) if (entry.op.origin === origin) theirs++;
      assert.strictEqual(theirs, 1);
      assert.strictEqual(h1.vector[origin], 1);
      assert.strictEqual(h2.vector[origin], 1);
    },
  );

  await t.test(
    'without signatures, two copies that mint one seq are told apart by their headers, not by their payloads',
    async (t2) => {
      const [m1, m2] = await forked(t2, core);
      const origin = m1.nodeId;
      await m1.set('doc', { title: 'x' });
      // A stamp of its own: the copies write a millisecond apart at least.
      await new Promise((resolve) => setTimeout(resolve, 2));
      await m2.set('doc', { title: 'y' });
      const x = opOf(m1, origin, 1);
      const y = opOf(m2, origin, 1);
      assert.deepStrictEqual([x.sig, x.digest], [undefined, undefined], 'unsigned, no digest');
      assert.notStrictEqual(x.ts, y.ts);
      const host = await open(t2, { path: '/h' }, core);
      const errors = errorsOf(host);
      assert.strictEqual((await host.applyRemote([x])).applied, 1);
      const result = await host.applyRemote([y]);
      assert.deepStrictEqual([result.applied, result.duplicates, result.equivocations], [0, 0, 1]);
      assert.deepStrictEqual(
        [errors[0].code, errors[0].reason, errors[0].held, errors[0].received],
        ['EQUIVOCATION', 'seq', entryOf(m1, origin, 1).fp, entryOf(m2, origin, 1).fp],
      );
      // The same op again is a duplicate, nothing more.
      assert.deepStrictEqual([(await host.applyRemote([x])).duplicates, errors.length], [1, 1]);
      assert.deepStrictEqual(await host.get('doc'), { title: 'x' });
      // The limit: without a digest the fingerprint is the header's alone —
      // another payload under one header is the same op to it. Signed, the
      // digest is in the header (the test above).
      const twin = { ...x, data: { title: 'z' } };
      assert.deepStrictEqual([(await host.applyRemote([twin])).duplicates, errors.length], [1, 1]);
    },
  );
});

test('The per-stream hash chain', async (t) => {
  await t.test(
    'the next op of a forked stream is refused as a broken chain where the other branch is held, taken where its own is',
    async (t2) => {
      const [m1, m2] = await forked(t2);
      const origin = m1.nodeId;
      await m1.set('doc', { title: 'x1' });
      await m2.set('doc', { title: 'y1' });
      await m1.set('doc', { title: 'x2' });
      await m2.set('doc', { title: 'y2' });
      const [x1, x2] = [opOf(m1, origin, 1), opOf(m1, origin, 2)];
      const [y1, y2] = [opOf(m2, origin, 1), opOf(m2, origin, 2)];
      // Seq 1 opens the stream: it names no predecessor. Seq 2 names seq 1.
      assert.strictEqual(x1.prev, undefined);
      assert.strictEqual(x2.prev, entryOf(m1, origin, 1).fp);
      assert.strictEqual(y2.prev, entryOf(m2, origin, 1).fp);
      const h1 = await open(t2, { path: '/h1' });
      const h2 = await open(t2, { path: '/h2' });
      const errors1 = errorsOf(h1);
      const errors2 = errorsOf(h2);
      assert.strictEqual((await h1.applyRemote([x1])).applied, 1);
      assert.strictEqual((await h2.applyRemote([y1])).applied, 1);
      // Each host refuses the op that extends the other branch, never having
      // seen that branch's seq 1: not logged, not relayed, the vector unmoved…
      const length = h2.log.length;
      const refused = await h2.applyRemote([x2]);
      assert.deepStrictEqual([refused.applied, refused.equivocations, refused.gaps], [0, 1, 0]);
      assert.deepStrictEqual([h2.log.length, h2.vector[origin]], [length, 1]);
      assert.strictEqual((await h1.applyRemote([y2])).equivocations, 1);
      // …and takes the one that extends the branch it holds.
      assert.strictEqual((await h1.applyRemote([x2])).applied, 1);
      assert.strictEqual((await h2.applyRemote([y2])).applied, 1);
      assert.deepStrictEqual(await h1.get('doc'), { title: 'x2' });
      assert.deepStrictEqual(await h2.get('doc'), { title: 'y2' });
      // The evidence: the fingerprint held at seq 1 and the one the op names.
      const chain = errors2.find((error) => error.code === 'EQUIVOCATION');
      assert.deepStrictEqual(
        [chain.reason, chain.origin, chain.seq, chain.held, chain.received, chain.op.data.title],
        ['chain', origin, 2, entryOf(h2, origin, 1).fp, x2.prev, 'x2'],
      );
      assert.strictEqual(errors1.find((error) => error.code === 'EQUIVOCATION').received, y2.prev);
      // A fresh node holds neither: it takes the first op it is handed and
      // holds the chain to it from there, inside one page too.
      const h3 = await open(t2, { path: '/h3' });
      const page = await h3.applyRemote([y1, x2, y2]);
      assert.deepStrictEqual([page.applied, page.equivocations], [2, 1]);
      assert.deepStrictEqual(await h3.get('doc'), { title: 'y2' });
    },
  );

  await t.test(
    'prev is signed: a changed or stripped prev is FORGED, and a signed op that names none is refused where one is held',
    async (t2) => {
      const [m1, m2] = await forked(t2);
      const origin = m1.nodeId;
      await m1.set('doc', { title: 'x1' });
      await m2.set('doc', { title: 'y1' });
      await m1.set('doc', { title: 'x2' });
      const x2 = opOf(m1, origin, 2);
      const host = await open(t2, { path: '/h' });
      assert.strictEqual((await host.applyRemote([opOf(m2, origin, 1)])).applied, 1);
      const held = entryOf(host, origin, 1).fp;
      // Relabelled to pass the chain here: the signature no longer verifies.
      const relabelled = await host.applyRemote([{ ...x2, prev: held }]);
      assert.deepStrictEqual([relabelled.forged, relabelled.equivocations], [1, 0]);
      const stripped = { ...x2 };
      delete stripped.prev;
      assert.strictEqual((await host.applyRemote([stripped])).forged, 1);
      // Signed again by the key holder without a prev: it verifies, and is
      // refused all the same where the op before it is held.
      const privateKey = await m1.fsi.read('/m/keys', 'sign-private.pem');
      const bare = { ...x2 };
      delete bare.prev;
      delete bare.sig;
      const signed = await signOp(bare, privateKey);
      const unchained = await host.applyRemote([signed]);
      assert.deepStrictEqual([unchained.forged, unchained.equivocations], [0, 1]);
      assert.strictEqual(host.vector[origin], 1);
      // An unsigned op that names no predecessor is a hand-made one, taken as
      // its stream's next; one that names the wrong one is refused.
      const plain = (seq, extra) => ({
        origin: 'n1',
        seq,
        ts: Date.now(),
        type: 'write',
        id: 'r',
        data: { seq },
        ...extra,
      });
      assert.strictEqual((await host.applyRemote([plain(1), plain(2)])).applied, 2);
      const wrong = await host.applyRemote([plain(3, { prev: STRANGER })]);
      assert.deepStrictEqual([wrong.applied, wrong.equivocations], [0, 1]);
    },
  );

  await t.test('the chain heads survive a reopen and a roll that compacted the ops they name', async (t2) => {
    const tight = { sync: { log: { rollAfter: 1 }, retention: { ops: 1 } } };
    const mine = memory();
    const theirs = memory();
    let writer = await open(t2, { fsi: mine, path: '/w', ...tight });
    let reader = await open(t2, { fsi: theirs, path: '/r', ...tight });
    const key = writer.nodeId;
    for (let n = 1; n <= 6; n++) {
      await writer.set('doc', { n });
      assert.strictEqual((await reader.applyRemote([opOf(writer, key, n)])).applied, 1);
    }
    await writer.log.flush();
    await reader.log.flush();
    assert.ok(writer.log.floor > 1 && reader.log.floor > 1, 'both compacted');
    assert.strictEqual(entryOf(reader, key, 1), undefined, 'the reader dropped what it took first');
    const fp = entryOf(writer, key, 6).fp;
    assert.deepStrictEqual(writer.log.headOf(key), [6, fp]);
    assert.deepStrictEqual(reader.log.headOf(key), [6, fp], 'the receiver fingerprints as the writer does');
    await writer.close();
    await reader.close();
    const index = JSON.parse(await mine.read('/w/log', 'index.json'));
    assert.deepStrictEqual(index.heads[key], [6, fp], 'persisted beside the vector');
    writer = await open(t2, { fsi: mine, path: '/w', ...tight });
    reader = await open(t2, { fsi: theirs, path: '/r', ...tight });
    assert.deepStrictEqual(writer.log.headOf(key), [6, fp]);
    assert.deepStrictEqual(reader.log.headOf(key), [6, fp]);
    await writer.set('doc', { n: 7 });
    const seventh = opOf(writer, key, 7);
    assert.strictEqual(seventh.prev, fp, 'the next op chains to the last before the reopen');
    // Held, not guessed: one that names another predecessor is refused.
    const wrong = { ...seventh, prev: STRANGER };
    delete wrong.sig;
    assert.strictEqual((await reader.applyRemote([wrong])).equivocations, 1);
    assert.strictEqual((await reader.applyRemote([seventh])).applied, 1);
    assert.deepStrictEqual(reader.log.headOf(key), [7, entryOf(writer, key, 7).fp]);
  });

  await t.test('a group that fails takes its chain heads back with its seqs', async (t2) => {
    const inner = memory();
    let failing = false;
    const fsi = {
      ...inner,
      write: (dir, name, text) =>
        failing && dir.endsWith('/log/open') ? Promise.reject(new Error('disk full')) : inner.write(dir, name, text),
      append: (dir, name, text) =>
        failing && dir.endsWith('/log/open') ? Promise.reject(new Error('disk full')) : inner.append(dir, name, text),
    };
    const storage = await open(t2, { fsi, path: '/f' });
    const key = storage.nodeId;
    await storage.set('doc', { n: 1 });
    const first = entryOf(storage, key, 1).fp;
    failing = true;
    await assert.rejects(storage.set('doc', { n: 2 }), /disk full/);
    failing = false;
    assert.deepStrictEqual(storage.log.headOf(key), [1, first], 'the head went back with the seq');
    assert.strictEqual(storage.log.fingerprintOf(key, 2), undefined);
    await storage.set('doc', { n: 3 });
    const second = entryOf(storage, key, 2);
    assert.deepStrictEqual([second.op.data, second.op.prev], [{ n: 3 }, first], 'chained to what is durable');
    assert.deepStrictEqual(storage.log.headOf(key), [2, second.fp]);
    assert.strictEqual(storage.log.fingerprintOf(key, 2), second.fp);
  });

  await t.test('packOps carries prev in slot 19; a row of 18 slots reads it as absent', () => {
    const op = { origin: 'n1', seq: 2, ts: 5, type: 'write', id: 'r', data: { a: 1 }, prev: STRANGER };
    const [row] = packOps([op]);
    assert.strictEqual(row.length, 19);
    assert.strictEqual(row[18], op.prev);
    assert.deepStrictEqual(unpackOps([row]), [op]);
    const older = { ...op };
    delete older.prev;
    assert.deepStrictEqual(unpackOps([row.slice(0, 18)]), [older]);
    assert.strictEqual(packOps([older])[0][18], null);
  });
});
