'use strict';

// The Node.js half of the signing plugin: Ed25519 key pairs on disk, the
// signature of a message and its check, and SHA-256 as hex. The browser
// half (./ed25519.browser.js, through package.json#browser) answers the
// same questions with promises — shared code awaits every one of these.

const crypto = require('node:crypto');
const defaultFsi = require('../fsi.js');
const { loadKeyPair, SIGNING_FILES } = require('../keys.js');

const calculateHash = (data) => {
  const block = JSON.stringify(data);
  return crypto.createHash('sha256').update(block).digest('hex');
};

// Ed25519 signs ops. The raw public key — 32 bytes, 43 base64url characters
// — is the node id, so a signature verifies against its op's origin with no
// key to look up. PEM on disk like an RSA pair; the id is derived from it.
const signingId = (publicKey) => crypto.createPublicKey(publicKey).export({ format: 'jwk' }).x;

const generateSigningKeys = () =>
  new Promise((resolve, reject) => {
    const format = 'pem';
    const options = { publicKeyEncoding: { type: 'spki', format }, privateKeyEncoding: { type: 'pkcs8', format } };
    crypto.generateKeyPair('ed25519', options, (error, publicKey, privateKey) => {
      if (error) return void reject(error);
      resolve({ publicKey, privateKey, id: signingId(publicKey) });
    });
  });

// A storage signs with one key for its life and verifies against every
// origin it hears from: parsing a PEM per op was most of a signature's cost.
const signers = new Map();
const verifiers = new Map();
const MAX_SIGNERS = 2;
const MAX_VERIFIERS = 64;

const signerOf = (privateKey) => {
  let key = signers.get(privateKey);
  if (key === undefined) {
    key = crypto.createPrivateKey(privateKey);
    if (signers.size >= MAX_SIGNERS) signers.delete(signers.keys().next().value);
    signers.set(privateKey, key);
  }
  return key;
};

const verifierOf = (id) => {
  let key = verifiers.get(id);
  if (key === undefined) {
    key = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: id }, format: 'jwk' });
    if (verifiers.size >= MAX_VERIFIERS) verifiers.delete(verifiers.keys().next().value);
    verifiers.set(id, key);
  }
  return key;
};

const sign = (message, privateKey) =>
  crypto.sign(null, Buffer.from(message), signerOf(privateKey)).toString('base64url');

// False, never a throw: an id that is no key, a signature of the wrong
// length — a peer's claim, answered at the trust boundary.
const verify = (message, signature, publicKey) => {
  try {
    return crypto.verify(null, Buffer.from(message), verifierOf(publicKey), Buffer.from(signature, 'base64url'));
  } catch {
    return false;
  }
};

// The engine's verify: the same answer as `verify`, off the main thread —
// with a callback, node:crypto runs the check on libuv's thread pool, so a
// page's checks run UV_THREADPOOL_SIZE (4 by default) at a time instead of
// one after another. Not on the subpath's surface: the public `verify`
// stays synchronous here, like every function of this half.
const verifyAsync = (message, signature, publicKey) =>
  new Promise((resolve) => {
    try {
      const data = Buffer.from(message);
      const sig = Buffer.from(signature, 'base64url');
      // A failure in the pool is a signature that does not check.
      crypto.verify(null, data, verifierOf(publicKey), sig, (error, ok) => resolve(!error && ok === true));
    } catch {
      resolve(false);
    }
  });

const loadSigningKeys = async (basePath, { fsi = defaultFsi } = {}) => {
  const keys = await loadKeyPair(basePath, fsi, generateSigningKeys, SIGNING_FILES);
  return { publicKey: keys.publicKey, privateKey: keys.privateKey, id: signingId(keys.publicKey) };
};

module.exports = { calculateHash, generateSigningKeys, loadSigningKeys, sign, verify, verifyAsync };
