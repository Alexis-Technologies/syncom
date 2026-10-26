'use strict';

// Signed ops at the trust boundary: what a node signs, what it verifies and
// the three modes of `sync.signatures` — against whichever halves the
// wrapper loads. Hand-made unsigned ops stand for older peers and for the
// many tests that inject them.

const { settle, waitUntil } = require('../utils/mesh.js');
const { createSigner, forge, tamper } = require('../utils/signed.js');

const nothing = { applied: 0, skipped: 0, duplicates: 0, gaps: 0, malformed: 0, unsigned: 0, forged: 0, outOfScope: 0 };
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

  await t.test('an op nested deeper than the bound is malformed before its signature is read', async (t2) => {
    const { MAX_JSON_DEPTH } = require('../../src/shape.js');
    const deep = (levels) => {
      let value = 1;
      for (let i = 0; i < levels; i++) value = { a: value };
      return value;
    };
    const verifying = await createStorage(t2, 'A');
    const relay = await createStorage(t2, 'R', { sync: { signatures: false } });
    for (const storage of [verifying, relay]) storage.on('error', () => {});
    const peer = await createSigner();
    // What a relay that does not verify once logged: thousands of levels and
    // a signature of the right shape. Checking it overflowed the stack — a
    // throw out of the page, PAGE_FAILED three times, the peer STUCK.
    const probe = {
      ...unsignedOp(peer.id, 1, 'r1', { d: deep(5800) }),
      sig: 'S'.repeat(86),
      digest: 'd'.repeat(64),
      nonce: 'n'.repeat(22),
    };
    for (const storage of [verifying, relay]) {
      assert.deepStrictEqual(await storage.applyRemote([probe]), { ...nothing, malformed: 1 });
      assert.strictEqual(storage.log.length, 0, 'not logged, so not relayed');
    }
    // The bound leaves room for what an op and a meta wrap around a value
    // the API takes: an op whose field nests 16 levels past it is malformed,
    // signed or not; one at it applies.
    const limit = MAX_JSON_DEPTH + 16;
    const over = await peer.sign(unsignedOp(null, 1, 'r1', { d: deep(limit) }));
    const at = await peer.sign(unsignedOp(null, 1, 'r1', { d: deep(limit - 1) }));
    assert.deepStrictEqual(await verifying.applyRemote([over]), { ...nothing, malformed: 1 });
    assert.deepStrictEqual(await verifying.applyRemote([at]), { ...nothing, applied: 1 });
    // A write deeper than MAX_JSON_DEPTH is refused where it is made, so a
    // node never logs what its peers would refuse; one at it reaches them.
    const changes = [];
    verifying.on('change', (op) => changes.push(op));
    await assert.rejects(() => verifying.insert({ d: deep(MAX_JSON_DEPTH) }), {
      name: 'TypeError',
      message: new RegExp(`nests deeper than ${MAX_JSON_DEPTH} levels`),
    });
    await assert.rejects(() => verifying.update('r1', { d: deep(MAX_JSON_DEPTH) }), TypeError);
    await assert.rejects(() => verifying.add('r1', 'tags', [deep(MAX_JSON_DEPTH)]), TypeError);
    const id = await verifying.insert({ d: deep(MAX_JSON_DEPTH - 1) });
    await verifying.add(id, 'tags', [deep(MAX_JSON_DEPTH - 1)]);
    assert.strictEqual(changes.length, 2);
    const result = await relay.applyRemote(changes);
    assert.strictEqual(result.applied, 2);
    assert.deepStrictEqual(await relay.get(id), await verifying.get(id));
    // Data a hook hands back is held to what a peer takes, too.
    const hooked = await createStorage(t2, 'H', { hooks: { beforeWrite: () => ({ d: deep(limit) }) } });
    await assert.rejects(() => hooked.insert({ d: 1 }), { name: 'TypeError', message: /nests deeper than/ });
    // A signature check that throws refuses its op alone, as FORGED: the
    // page goes on, and the op is a gap in its stream until it comes again.
    const { SIGNER } = require('../../src/symbols.js');
    const identity = verifying[SIGNER];
    const verify = identity.verify;
    identity.verify = (op, mode) => {
      if (op.seq === 2) throw new RangeError('Maximum call stack size exceeded');
      return verify(op, mode);
    };
    const second = await peer.sign(unsignedOp(null, 2, 'r1', { e: 1 }));
    const third = await peer.sign(unsignedOp(null, 3, 'r1', { e: 2 }));
    assert.deepStrictEqual(await verifying.applyRemote([second, third]), { ...nothing, gaps: 1, forged: 1 });
    identity.verify = verify;
    assert.strictEqual((await verifying.applyRemote([second, third])).applied, 2);
  });

  await t.test('the option is checked at open()', async (t2) => {
    await assert.rejects(() => createStorage(t2, 'bad', { sync: { signatures: 'yes' } }), {
      name: 'TypeError',
      message: "open({ sync }): signatures must be 'verify', 'require' or false",
    });
    await assert.rejects(() => createStorage(t2, 'bad2', { sync: { signatures: true } }), TypeError);
  });

  await t.test(
    'hosting: a push with refused signatures is announced; a require host refuses a keyless hello',
    async (t2) => {
      const { MemoryLink } = require('../utils/memory-link.js');
      const { packOps } = require('../../src/ops.js');
      const host = await createStorage(t2, 'H');
      const refused = [];
      host.sync.on('refused', (event) => refused.push(event));
      host.on('error', () => {});
      const peer = await createSigner();
      const link = new MemoryLink(host.sync.unit({ access: 'public' }));
      await link.call('syncom/hello', { node: peer.id, version: 1 });
      const good = await peer.sign(unsignedOp(null, 1, 'r1', { a: 1 }));
      const bad = tamper(await peer.sign(unsignedOp(null, 2, 'r1', { a: 2 })));
      const answer = await link.call('syncom/push', { ops: packOps([good, bad]) });
      assert.deepStrictEqual([answer.applied, answer.forged, answer.unsigned], [1, 1, 0]);
      assert.deepStrictEqual(refused, [{ node: peer.id, reason: 'forged', count: 1 }]);
      assert.deepStrictEqual(await host.get('r1'), { a: 1 });
      // A 'verify' host greets anyone; a 'require' one needs a key for a node id.
      const plain = new MemoryLink(host.sync.unit({ access: 'public' }));
      await plain.call('syncom/hello', { node: 'peer', version: 1 });
      const strict = await createStorage(t2, 'S', { sync: { signatures: 'require' } });
      strict.on('error', () => {});
      const strictRefused = [];
      strict.sync.on('refused', (event) => strictRefused.push(event));
      const unit = strict.sync.unit({ access: 'public' });
      await assert.rejects(() => new MemoryLink(unit).call('syncom/hello', { node: 'peer', version: 1 }), {
        code: 403,
        reason: 'UNSIGNED',
      });
      const keyed = new MemoryLink(unit);
      await keyed.call('syncom/hello', { node: peer.id, version: 1 });
      const ops = packOps([good, unsignedOp(peer.id, 2, 'r1', { b: 1 })]);
      const pushed = await keyed.call('syncom/push', { ops });
      assert.deepStrictEqual([pushed.applied, pushed.unsigned], [1, 1]);
      assert.deepStrictEqual(strictRefused, [{ node: peer.id, reason: 'unsigned', count: 1 }]);
    },
  );

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
