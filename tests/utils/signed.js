'use strict';

// Hand-made ops, signed: a peer with a key of its own, for the tests that
// need an op that verifies, one that was tampered with, one that was forged.
// The modules are required lazily — a browser wrapper primes the cache
// first, and the signer must sign with the half the storage verifies with.

const createSigner = async () => {
  const { generateSigningKeys } = require('../../src/signing/ed25519.js');
  const { signOp } = require('../../src/signing/sign.js');
  const keys = await generateSigningKeys();
  return { id: keys.id, sign: (op) => signOp({ ...op, origin: keys.id }, keys.privateKey) };
};

// The signature changed: a forgery.
const forge = (op) => ({ ...op, sig: (op.sig[0] === 'A' ? 'B' : 'A') + op.sig.slice(1) });

// The payload changed under a signature that was honest: tampering.
const tamper = (op) => ({ ...op, data: { ...op.data, tampered: true } });

module.exports = { createSigner, forge, tamper };
