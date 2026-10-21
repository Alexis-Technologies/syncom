'use strict';

const crypto = require('node:crypto');
const defaultFsi = require('./fsi.js');
const { loadKeyPair, SIGNING_FILES } = require('./keys.js');
const { SyncomError } = require('./errors.js');

const calculateHash = (data) => {
  const block = JSON.stringify(data);
  return crypto.createHash('sha256').update(block).digest('hex');
};

const generateKeys = () =>
  new Promise((resolve, reject) => {
    const format = 'pem';
    const options = {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format },
      privateKeyEncoding: { type: 'pkcs8', format },
    };
    crypto.generateKeyPair('rsa', options, (error, publicKey, privateKey) => {
      if (error) return void reject(error);
      resolve({ publicKey, privateKey });
    });
  });

// Hybrid envelope, the same on both halves so ciphertext is portable between
// them: the record is AES-256-GCM encrypted under a fresh random key, and
// that key is RSA-OAEP(SHA-256) wrapped with the storage's public key. RSA
// alone caps the payload at a couple of hundred bytes; this caps nothing.
const ALG = 'RSA-OAEP-256+A256GCM';
const OAEP = { padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' };

const encrypt = (data, publicKey) => {
  const key = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(data))), cipher.final()]);
  const tag = cipher.getAuthTag();
  const wrapped = crypto.publicEncrypt({ key: publicKey, ...OAEP }, key);
  return JSON.stringify({
    v: 1,
    alg: ALG,
    key: wrapped.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    data: body.toString('base64'),
  });
};

const decrypt = (text, privateKey) => {
  const envelope = JSON.parse(text);
  if (envelope.v !== 1 || envelope.alg !== ALG) {
    throw new SyncomError('BAD_ENVELOPE', 'Unsupported ciphertext envelope');
  }
  const key = crypto.privateDecrypt({ key: privateKey, ...OAEP }, Buffer.from(envelope.key, 'base64'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  const plain = Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]);
  return JSON.parse(plain.toString());
};

const loadKeys = async (basePath, { fsi = defaultFsi } = {}) => loadKeyPair(basePath, fsi, generateKeys);

// Ed25519 signs ops. The raw public key — 32 bytes, 43 base64url characters
// — is the node id, so a signature verifies against its op's origin with no
// key to look up. PEM on disk like the RSA pair; the id is derived from it.
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

const loadSigningKeys = async (basePath, { fsi = defaultFsi } = {}) => {
  const keys = await loadKeyPair(basePath, fsi, generateSigningKeys, SIGNING_FILES);
  return { publicKey: keys.publicKey, privateKey: keys.privateKey, id: signingId(keys.publicKey) };
};

module.exports = {
  calculateHash,
  generateKeys,
  encrypt,
  decrypt,
  loadKeys,
  generateSigningKeys,
  loadSigningKeys,
  sign,
  verify,
};
