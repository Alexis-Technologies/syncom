'use strict';

// Hand-made ops, signed: a peer with a key of its own, for the tests that
// need an op that verifies, one that was tampered with, one that was forged.
// The modules are required lazily — a browser wrapper primes the cache
// first, and the signer must sign with the half the storage verifies with.
// Like a node, the signer chains what it signs: an op names the one it signed
// last at the seq before it in its stream (`prev`).

const createSigner = async () => {
  const { generateSigningKeys } = require('../../src/signing/ed25519.js');
  const { signOp } = require('../../src/signing/sign.js');
  const { link } = require('../../src/commit.js');
  const { opKey } = require('../../src/vector.js');
  const keys = await generateSigningKeys();
  const made = new Map();
  const sign = async (op) => {
    const signed = { ...op, origin: keys.id };
    const fps = await link([signed], (key, seq) => made.get(`${seq} ${key}`), true);
    made.set(`${signed.seq} ${opKey(signed)}`, fps.get(signed));
    return signOp(signed, keys.privateKey);
  };
  return { id: keys.id, sign };
};

// The signature changed: a forgery.
const forge = (op) => ({ ...op, sig: (op.sig[0] === 'A' ? 'B' : 'A') + op.sig.slice(1) });

// The payload changed under a signature that was honest: tampering.
const tamper = (op) => ({ ...op, data: { ...op.data, tampered: true } });

module.exports = { createSigner, forge, tamper };
