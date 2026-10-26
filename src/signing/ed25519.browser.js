'use strict';

// The browser half of the signing plugin (Web Crypto): the same questions
// as ./ed25519.js, answered with promises. One pair on disk is one id on
// both platforms — the raw public key, base64url, derived the same way.

const defaultFsi = require('../fsi.browser.js');
const { loadKeyPair, SIGNING_FILES } = require('../keys.js');
const { PUBLIC_KEY_HEADER, PUBLIC_KEY_FOOTER, PRIVATE_KEY_HEADER, PRIVATE_KEY_FOOTER } = require('../pem.js');
const { toBase64Url, fromBase64, toPem, cleanPem } = require('../pem.js');

const ED25519 = { name: 'Ed25519' };
// An Ed25519 SPKI is a fixed 12-byte header and the 32-byte key.
const SPKI_HEADER_BYTES = 12;

const HEX = [];
for (let i = 0; i < 256; i++) HEX.push(i.toString(16).padStart(2, '0'));

const calculateHash = async (data) => {
  const block = JSON.stringify(data);
  const dataBuffer = new TextEncoder().encode(block);
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', dataBuffer));
  let hex = '';
  for (let i = 0; i < hash.length; i++) hex += HEX[hash[i]];
  return hex;
};

// The signing key is imported once per PEM and kept, like the verifiers.
const signers = new Map();
const MAX_SIGNERS = 2;
const signerOf = (pem) => {
  const cached = signers.get(pem);
  if (cached !== undefined) return cached;
  const bytes = fromBase64(cleanPem(pem, PRIVATE_KEY_HEADER, PRIVATE_KEY_FOOTER));
  const key = crypto.subtle.importKey('pkcs8', bytes, ED25519, false, ['sign']);
  if (signers.size >= MAX_SIGNERS) signers.delete(signers.keys().next().value);
  signers.set(pem, key);
  key.catch(() => signers.delete(pem));
  return key;
};

const signingId = (publicKey) => {
  const der = fromBase64(cleanPem(publicKey, PUBLIC_KEY_HEADER, PUBLIC_KEY_FOOTER));
  return toBase64Url(der.subarray(SPKI_HEADER_BYTES));
};

const generateSigningKeys = async () => {
  const keyPair = await crypto.subtle.generateKey(ED25519, true, ['sign', 'verify']);
  const pubBuf = await crypto.subtle.exportKey('spki', keyPair.publicKey);
  const privBuf = await crypto.subtle.exportKey('pkcs8', keyPair.privateKey);
  return {
    publicKey: toPem(pubBuf, PUBLIC_KEY_HEADER, PUBLIC_KEY_FOOTER),
    privateKey: toPem(privBuf, PRIVATE_KEY_HEADER, PRIVATE_KEY_FOOTER),
    id: toBase64Url(await crypto.subtle.exportKey('raw', keyPair.publicKey)),
  };
};

// A verifier per origin this node hears from, by id, bounded.
const verifiers = new Map();
const MAX_VERIFIERS = 64;

const verifierOf = (id) => {
  const cached = verifiers.get(id);
  if (cached !== undefined) return cached;
  const key = crypto.subtle.importKey('raw', fromBase64(id), ED25519, false, ['verify']);
  if (verifiers.size >= MAX_VERIFIERS) verifiers.delete(verifiers.keys().next().value);
  verifiers.set(id, key);
  key.catch(() => verifiers.delete(id));
  return key;
};

const sign = async (message, privateKey) => {
  const key = await signerOf(privateKey);
  return toBase64Url(await crypto.subtle.sign(ED25519, key, new TextEncoder().encode(message)));
};

// False, never a throw: an id that is no key, a signature of the wrong
// length — a peer's claim, answered at the trust boundary.
const verify = async (message, signature, publicKey) => {
  try {
    const key = await verifierOf(publicKey);
    return await crypto.subtle.verify(ED25519, key, fromBase64(signature), new TextEncoder().encode(message));
  } catch {
    return false;
  }
};

// Web Crypto's verify is off the main thread already: the engine's verify is
// the public one (./ed25519.js has its own, on the thread pool).
const verifyAsync = verify;

const loadSigningKeys = async (basePath = 'keys', { fsi = defaultFsi } = {}) => {
  const keys = await loadKeyPair(basePath, fsi, generateSigningKeys, SIGNING_FILES);
  return { publicKey: keys.publicKey, privateKey: keys.privateKey, id: signingId(keys.publicKey) };
};

// Web Crypto signs off the main thread already.
const signAsync = sign;

module.exports = { calculateHash, generateSigningKeys, loadSigningKeys, sign, signAsync, verify, verifyAsync };
