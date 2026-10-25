'use strict';

// The canonical form a signature covers, and the verdicts on a peer's op —
// against whichever crypto half the wrapper loads.

const runSigningTests = async (t, assert, signing, cryptoMod) => {
  const { canonical, payloadOf, signedMessage, signOp, verifyOp, OK, UNSIGNED, FORGED, HEADER_VERSION } = signing;

  await t.test('canonical: JSON with sorted keys, whatever order the object came in', () => {
    assert.strictEqual(
      canonical({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: null } }),
      '{"a":{"c":null,"d":[1,{"y":2,"z":1}]},"b":1}',
    );
    assert.strictEqual(canonical({ b: 1, a: 2 }), canonical({ a: 2, b: 1 }));
    assert.strictEqual(canonical([3, 'x', true, null, undefined, () => 1]), '[3,"x",true,null,null,null]');
    assert.strictEqual(canonical({ a: undefined, b: () => 1, c: Symbol('s'), d: 1 }), '{"d":1}');
    assert.strictEqual(canonical('ünï"\\n'), JSON.stringify('ünï"\\n'));
    assert.strictEqual(canonical(1e21), '1e+21');
    assert.strictEqual(canonical(NaN), 'null');
    assert.strictEqual(canonical(new Date(0)), '"1970-01-01T00:00:00.000Z"');
    assert.strictEqual(canonical(undefined), undefined);
    const poisoned = JSON.parse('{"__proto__":{"x":1},"a":2}');
    assert.strictEqual(canonical(poisoned), '{"__proto__":{"x":1},"a":2}');
    assert.strictEqual(Object.hasOwn(Object.prototype, 'x'), false);
  });

  await t.test('payloadOf and signedMessage: the split between what is digested and what is signed', () => {
    const op = { origin: 'A', seq: 3, ts: 9, type: 'set', id: 'r', data: { x: 1 }, actor: 'u', v: 2 };
    assert.deepStrictEqual(payloadOf(op), { data: { x: 1 } });
    assert.strictEqual(payloadOf({ origin: 'A', seq: 1, ts: 1, type: 'delete', id: 'r' }), null);
    assert.deepStrictEqual(payloadOf({ type: 'advance', vector: { B: 2 }, from: 'B' }), { vector: { B: 2 } });
    assert.strictEqual(
      signedMessage({ ...op, digest: 'd' }),
      JSON.stringify([HEADER_VERSION, 'A', 3, 9, 'set', 'r', null, null, 2, 'u', 'd', null]),
    );
    assert.strictEqual(
      signedMessage({ origin: 'A', seq: 1, ts: 1, type: 'advance', vector: {}, from: 'B' }),
      '[1,"A",1,1,"advance",null,null,"B",null,null,null,null]',
    );
    // The same op with its keys in another order: the same message.
    const shuffled = { v: 2, data: { x: 1 }, actor: 'u', id: 'r', type: 'set', ts: 9, seq: 3, origin: 'A' };
    assert.strictEqual(signedMessage(shuffled), signedMessage(op));
  });

  await t.test('signOp fills nonce, digest and sig; verifyOp answers every row of the table', async () => {
    const keys = await Promise.resolve(cryptoMod.generateSigningKeys());
    const other = await Promise.resolve(cryptoMod.generateSigningKeys());
    const make = () => ({ origin: keys.id, seq: 1, ts: 5, type: 'write', id: 'r', data: { secret: 'low entropy' } });
    const op = await signOp(make(), keys.privateKey);
    assert.deepStrictEqual(Object.keys(op).sort(), [
      'data',
      'digest',
      'id',
      'nonce',
      'origin',
      'seq',
      'sig',
      'ts',
      'type',
    ]);
    assert.match(op.sig, /^[A-Za-z0-9_-]{86}$/);
    assert.match(op.digest, /^[0-9a-f]{64}$/);
    assert.match(op.nonce, /^[A-Za-z0-9_-]{16,64}$/);
    assert.strictEqual(await verifyOp(op, 'verify'), OK);
    assert.strictEqual(await verifyOp(op, 'require'), OK);
    // The nonce salts the digest: the same payload signed twice differs.
    const again = await signOp(make(), keys.privateKey);
    assert.notStrictEqual(again.digest, op.digest);
    assert.notStrictEqual(again.sig, op.sig);
    // The key order of the payload plays no part.
    const reordered = { ...op, data: JSON.parse('{"secret":"low entropy"}') };
    assert.strictEqual(await verifyOp(reordered, 'require'), OK);
    // Every header field is covered.
    for (const [field, value] of [
      ['origin', other.id],
      ['seq', 2],
      ['ts', 6],
      ['type', 'set'],
      ['id', 'other'],
      ['scope', 's'],
      ['from', 'B'],
      ['v', 1],
      ['actor', 'mallory'],
    ]) {
      assert.strictEqual(await verifyOp({ ...op, [field]: value }, 'verify'), FORGED, field);
    }
    // And the payload, through the digest.
    assert.strictEqual(await verifyOp({ ...op, data: { secret: 'other' } }, 'verify'), FORGED);
    assert.strictEqual(await verifyOp({ ...op, key: 'n', value: 1 }, 'verify'), FORGED, 'a field added');
    assert.strictEqual(await verifyOp({ ...op, nonce: op.nonce.slice(0, -1) + 'x' }, 'verify'), FORGED);
    const flipped = (op.digest[0] === 'f' ? 'e' : 'f') + op.digest.slice(1);
    assert.strictEqual(await verifyOp({ ...op, digest: flipped }, 'verify'), FORGED);
    // Scrubbed: the payload and the nonce gone, the header still verifies.
    const { data, nonce, ...scrubbed } = op;
    assert.strictEqual(await verifyOp(scrubbed, 'require'), OK);
    // Stripped half-way: the payload without its nonce, or a nonce with no payload.
    assert.strictEqual(await verifyOp({ ...scrubbed, data }, 'verify'), FORGED);
    assert.strictEqual(await verifyOp({ ...scrubbed, nonce }, 'verify'), FORGED);
    assert.strictEqual(await verifyOp({ ...op, digest: undefined }, 'verify'), FORGED);
    // Unsigned: accepted under 'verify', refused under 'require'.
    const { sig, ...unsigned } = op;
    assert.strictEqual(await verifyOp(unsigned, 'verify'), OK);
    assert.strictEqual(await verifyOp(unsigned, 'require'), UNSIGNED);
    assert.strictEqual(await verifyOp({ origin: 'n1', seq: 1, ts: 1, type: 'delete', id: 'r' }, 'verify'), OK);
    assert.strictEqual(await verifyOp({ origin: 'n1', seq: 1, ts: 1, type: 'delete', id: 'r' }, 'require'), UNSIGNED);
    // A signature on an origin that is no key, or a signature of another key.
    assert.strictEqual(await verifyOp({ ...op, origin: 'n1' }, 'verify'), FORGED);
    const theirs = await signOp(make(), other.privateKey);
    assert.strictEqual(await verifyOp(theirs, 'verify'), FORGED, 'signed by a key that is not the origin');
    // Ops without a payload: no nonce, no digest, signed all the same.
    const gone = await signOp({ origin: keys.id, seq: 2, ts: 6, type: 'delete', id: 'r' }, keys.privateKey);
    assert.deepStrictEqual(Object.keys(gone).sort(), ['id', 'origin', 'seq', 'sig', 'ts', 'type']);
    assert.strictEqual(await verifyOp(gone, 'require'), OK);
    const advance = await signOp(
      { origin: keys.id, seq: 1, ts: 7, type: 'advance', vector: { B: 3 }, from: 'B' },
      keys.privateKey,
    );
    assert.ok(advance.digest && advance.nonce, 'a vector is a payload');
    assert.strictEqual(await verifyOp(advance, 'require'), OK);
    assert.strictEqual(await verifyOp({ ...advance, vector: { B: 4 } }, 'require'), FORGED);
  });
};

module.exports = { runSigningTests };
