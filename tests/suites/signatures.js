'use strict';

// Signed ops at the trust boundary: what a node signs, what it verifies and
// the three modes of `sync.signatures` — against whichever halves the
// wrapper loads. Hand-made unsigned ops stand for older peers and for the
// many tests that inject them.

const { settle, waitUntil } = require('../utils/mesh.js');
const { createSigner, forge, tamper } = require('../utils/signed.js');

const nothing = { applied: 0, skipped: 0, duplicates: 0, gaps: 0, malformed: 0, unsigned: 0, forged: 0 };
const unsignedOp = (origin, seq, id, data) => ({ origin, seq, ts: Date.now() + seq, type: 'write', id, data });
const SIGNATURE = /^[A-Za-z0-9_-]{86}$/;

const runSignatureTests = async (t, assert, createStorage) => {
  await t.test("'verify', the default: own ops signed; a forged op refused, an unsigned one taken", async (t2) => {
    const storage = await createStorage(t2, 'A');
    assert.strictEqual(storage.signatures, 'verify');
    const errors = [];
    storage.on('error', (error) => errors.push(error));
    const changes = [];
    storage.on('change', (op) => changes.push(op));
    await storage.insert({ n: 1 });
    assert.match(changes[0].sig, SIGNATURE, 'this node signs its own');
    // An unsigned hand-made op applies: an older peer's, or a test's.
    const plain = await storage.applyRemote([unsignedOp('n1', 1, 'r1', { a: 1 })]);
    assert.deepStrictEqual(plain, { ...nothing, applied: 1 });
    // A signed op applies, and leaves with its signature as it came.
    const peer = await createSigner();
    const good = await peer.sign(unsignedOp(null, 1, 'r2', { b: 1 }));
    assert.strictEqual((await storage.applyRemote([good])).applied, 1);
    assert.deepStrictEqual(
      [changes.at(-1).sig, changes.at(-1).digest, changes.at(-1).nonce],
      [good.sig, good.digest, good.nonce],
    );
    assert.deepStrictEqual(await storage.get('r2'), { b: 1 });
    // Tampered, forged, or signed under an origin that is no key: refused —
    // not logged, not relayed, the vector untouched, the record as it was.
    const before = storage.log.length;
    const bad = [
      tamper(await peer.sign(unsignedOp(null, 2, 'r2', { b: 2 }))),
      forge(await peer.sign(unsignedOp(null, 2, 'r2', { b: 3 }))),
      { ...good, origin: 'n1' },
    ];
    assert.deepStrictEqual(await storage.applyRemote(bad), { ...nothing, forged: 3 });
    assert.strictEqual(storage.log.length, before);
    assert.strictEqual(storage.vector[peer.id], 1);
    assert.deepStrictEqual(await storage.get('r2'), { b: 1 });
    assert.strictEqual(changes.length, 3, 'nothing refused was announced');
    // One error event per page: the first refused op and the count.
    assert.strictEqual(errors.length, 1);
    assert.deepStrictEqual(
      [errors[0].code, errors[0].count, errors[0].op.id, errors[0].op.data.tampered],
      ['BAD_SIGNATURE', 3, 'r2', true],
    );
    assert.match(errors[0].message, /does not verify against its origin \(3 in this page\)/);
    // The refused op was the stream's next: what follows is a gap until it
    // comes again, intact. (Made in seq order: the stamps follow the clock.)
    const second = await peer.sign(unsignedOp(null, 2, 'r2', { b: 2 }));
    const later = await peer.sign(unsignedOp(null, 3, 'r2', { b: 4 }));
    assert.deepStrictEqual(await storage.applyRemote([later]), { ...nothing, gaps: 1 });
    assert.strictEqual((await storage.applyRemote([second, later])).applied, 2);
    assert.deepStrictEqual(await storage.get('r2'), { b: 4 });
    assert.strictEqual(errors.length, 1);
  });

  await t.test("'require': unsigned ops and keyless origins are refused too", async (t2) => {
    const storage = await createStorage(t2, 'A', { sync: { signatures: 'require' } });
    assert.strictEqual(storage.signatures, 'require');
    const errors = [];
    storage.on('error', (error) => errors.push(error));
    const peer = await createSigner();
    const good = await peer.sign(unsignedOp(null, 1, 'r1', { a: 1 }));
    const page = [
      unsignedOp('n1', 1, 'r2', { b: 1 }),
      unsignedOp('n1', 2, 'r2', { b: 2 }),
      good,
      { ...good, origin: 'n2' },
    ];
    assert.deepStrictEqual(await storage.applyRemote(page), { ...nothing, applied: 1, unsigned: 2, forged: 1 });
    assert.deepStrictEqual(
      errors.map((error) => [error.code, error.count, error.op.origin]),
      [
        ['BAD_SIGNATURE', 1, 'n2'],
        ['UNSIGNED', 2, 'n1'],
      ],
    );
    assert.match(errors[1].message, /carries no signature; sync.signatures is 'require'/);
    assert.deepStrictEqual(await storage.get('r1'), { a: 1 });
    assert.strictEqual(await storage.get('r2'), null);
    assert.deepStrictEqual(storage.vector, { [peer.id]: 1 });
    // Its own ops are signed, as in every mode but false.
    const changes = [];
    storage.on('change', (op) => changes.push(op));
    await storage.insert({ n: 1 });
    assert.match(changes[0].sig, SIGNATURE);
    // A malformed op is malformed before it is anything else.
    assert.deepStrictEqual(await storage.applyRemote([{ ...good, seq: 'x' }]), { ...nothing, malformed: 1 });
  });

  await t.test('false: nothing signed, nothing verified; the id is the key all the same', async (t2) => {
    const storage = await createStorage(t2, 'A', { sync: { signatures: false } });
    assert.strictEqual(storage.signatures, false);
    assert.match(storage.nodeId, /^[A-Za-z0-9_-]{43}$/);
    const changes = [];
    storage.on('change', (op) => changes.push(op));
    await storage.insert({ n: 1 });
    assert.strictEqual('sig' in changes[0], false);
    assert.strictEqual('digest' in changes[0], false);
    const peer = await createSigner();
    const tampered = tamper(await peer.sign(unsignedOp(null, 1, 'r1', { a: 1 })));
    assert.deepStrictEqual(await storage.applyRemote([tampered]), { ...nothing, applied: 1 });
    assert.deepStrictEqual(await storage.get('r1'), { a: 1, tampered: true });
  });

  await t.test('the option is checked at open()', async (t2) => {
    await assert.rejects(() => createStorage(t2, 'bad', { sync: { signatures: 'yes' } }), {
      name: 'TypeError',
      message: "open({ sync }): signatures must be 'verify', 'require' or false",
    });
    await assert.rejects(() => createStorage(t2, 'bad2', { sync: { signatures: true } }), TypeError);
  });

  await t.test('a signed op relays intact through a node that does not verify, into one that requires', async (t2) => {
    const { MemoryLink } = require('../utils/memory-link.js');
    const a = await createStorage(t2, 'A', { sync: { signatures: false } });
    const peer = await createSigner();
    const good = await peer.sign(unsignedOp(null, 1, 'r1', { a: 1 }));
    await a.applyRemote([good]);
    const connect = () => new MemoryLink(a.sync.unit({ access: 'public' }));
    const c = await createStorage(t2, 'C', { sync: { signatures: 'require', connect } });
    await c.sync.addNode({ url: 'mem://A' });
    await settle([a, c]);
    // The vector moves at the log append, the record file after it: wait
    // for the record, not for the vectors alone.
    await waitUntil(async () => (await c.get('r1')) !== null);
    assert.deepStrictEqual(await c.get('r1'), { a: 1 });
    const relayed = c.log.since(undefined).find((entry) => entry.op.origin === peer.id);
    assert.deepStrictEqual([relayed.op.sig, relayed.op.digest, relayed.op.nonce], [good.sig, good.digest, good.nonce]);
    // A's own ops are unsigned: C, requiring, refuses them and says so.
    const errors = [];
    c.on('error', (error) => errors.push(error.code));
    const own = await a.insert({ own: true });
    await waitUntil(() => errors.includes('UNSIGNED'));
    assert.strictEqual(await c.get(own), null);
  });
};

module.exports = { runSignatureTests };
