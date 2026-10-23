'use strict';

const defaultFsi = require('./fsi.browser.js');
const { loadKeyPair, SIGNING_FILES } = require('./keys.js');
const { SyncomError } = require('./errors.js');

const PUBLIC_KEY_HEADER = '-----BEGIN PUBLIC KEY-----';
const PUBLIC_KEY_FOOTER = '-----END PUBLIC KEY-----';
const PRIVATE_KEY_HEADER = '-----BEGIN PRIVATE KEY-----';
const PRIVATE_KEY_FOOTER = '-----END PRIVATE KEY-----';

const RSA = { name: 'RSA-OAEP', hash: 'SHA-256' };
const AES = 'AES-GCM';
const ED25519 = { name: 'Ed25519' };
// An Ed25519 SPKI is a fixed 12-byte header and the 32-byte key.
const SPKI_HEADER_BYTES = 12;
const PADDING = /=+$/;
// The same envelope as src/crypto.js, so a record encrypted on one platform
// decrypts on the other given the same key pair.
const ALG = 'RSA-OAEP-256+A256GCM';
const TAG_BYTES = 16;

const calculateHash = async (data) => {
  const block = JSON.stringify(data);
  const dataBuffer = new TextEncoder().encode(block);
  const hashBuffer = await crypto.subtle.digest('SHA-256', dataBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
};

const toBase64 = (buffer) => {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
};

const toBase64Url = (buffer) => toBase64(buffer).replaceAll('+', '-').replaceAll('/', '_').replace(PADDING, '');

// Accepts standard AND url-safe base64: keys written by an earlier version
// of this file were url-safe, and node's PEMs are standard.
const fromBase64 = (base64) => {
  const normalized = base64.replaceAll('-', '+').replaceAll('_', '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
};

// Standard PEM: 64-character base64 lines, which is what node:crypto parses.
const toPem = (buffer, header, footer) => {
  const lines = toBase64(buffer).match(/.{1,64}/g) ?? [];
  return [header, ...lines, footer].join('\n');
};

const cleanPemKey = (pemKey, header, footer) => {
  const s = pemKey.replace(header, '').replace(footer, '');
  return s.replaceAll(/\s/g, '');
};

const generateKeys = async () => {
  const keyPair = await crypto.subtle.generateKey(
    { ...RSA, modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) },
    true,
    ['encrypt', 'decrypt'],
  );
  const pubBuf = await crypto.subtle.exportKey('spki', keyPair.publicKey);
  const privBuf = await crypto.subtle.exportKey('pkcs8', keyPair.privateKey);
  return {
    publicKey: toPem(pubBuf, PUBLIC_KEY_HEADER, PUBLIC_KEY_FOOTER),
    privateKey: toPem(privBuf, PRIVATE_KEY_HEADER, PRIVATE_KEY_FOOTER),
  };
};

// A storage uses one pair of each kind for its whole life; importing the
// PEM on every call was the cost of every sealed record and every signed op.
// A few imported keys are kept, by usage and PEM text — the usage names the
// algorithm, so one PEM never comes back as the other kind of key.
const imported = new Map();
const MAX_IMPORTED = 8;

const importKey = (pemKey, header, footer, format, algorithm, usage) => {
  const cacheKey = `${usage}:${pemKey}`;
  const cached = imported.get(cacheKey);
  if (cached !== undefined) return cached;
  const bytes = fromBase64(cleanPemKey(pemKey, header, footer));
  const key = crypto.subtle.importKey(format, bytes, algorithm, false, [usage]);
  if (imported.size >= MAX_IMPORTED) imported.delete(imported.keys().next().value);
  imported.set(cacheKey, key);
  key.catch(() => imported.delete(cacheKey));
  return key;
};

const importPublicKey = (pemKey) => importKey(pemKey, PUBLIC_KEY_HEADER, PUBLIC_KEY_FOOTER, 'spki', RSA, 'encrypt');
const importPrivateKey = (pemKey) => importKey(pemKey, PRIVATE_KEY_HEADER, PRIVATE_KEY_FOOTER, 'pkcs8', RSA, 'decrypt');
const importSigningKey = (pemKey) =>
  importKey(pemKey, PRIVATE_KEY_HEADER, PRIVATE_KEY_FOOTER, 'pkcs8', ED25519, 'sign');

const encrypt = async (data, publicKey) => {
  const rsa = await importPublicKey(publicKey);
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aes = await crypto.subtle.importKey('raw', raw, AES, false, ['encrypt']);
  const plaintext = new TextEncoder().encode(JSON.stringify(data));
  // Web Crypto appends the GCM tag to the ciphertext; the envelope keeps
  // them apart, the way node:crypto hands them over.
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: AES, iv }, aes, plaintext));
  const body = sealed.subarray(0, sealed.length - TAG_BYTES);
  const tag = sealed.subarray(sealed.length - TAG_BYTES);
  const wrapped = await crypto.subtle.encrypt(RSA, rsa, raw);
  return JSON.stringify({
    v: 1,
    alg: ALG,
    key: toBase64(wrapped),
    iv: toBase64(iv),
    tag: toBase64(tag),
    data: toBase64(body),
  });
};

const decrypt = async (text, privateKey) => {
  const envelope = JSON.parse(text);
  if (envelope.v !== 1 || envelope.alg !== ALG) {
    throw new SyncomError('BAD_ENVELOPE', 'Unsupported ciphertext envelope');
  }
  const rsa = await importPrivateKey(privateKey);
  const raw = await crypto.subtle.decrypt(RSA, rsa, fromBase64(envelope.key));
  const aes = await crypto.subtle.importKey('raw', raw, AES, false, ['decrypt']);
  const body = fromBase64(envelope.data);
  const tag = fromBase64(envelope.tag);
  const sealed = new Uint8Array(body.length + tag.length);
  sealed.set(body, 0);
  sealed.set(tag, body.length);
  const plain = await crypto.subtle.decrypt({ name: AES, iv: fromBase64(envelope.iv) }, aes, sealed);
  return JSON.parse(new TextDecoder().decode(plain));
};

const loadKeys = async (basePath = 'keys', { fsi = defaultFsi } = {}) => loadKeyPair(basePath, fsi, generateKeys);

// Ed25519 signs ops; the raw public key, base64url, is the node id — the
// same derivation as src/crypto.js, so one pair on disk is one id on both
// platforms.
const signingId = (publicKey) => {
  const der = fromBase64(cleanPemKey(publicKey, PUBLIC_KEY_HEADER, PUBLIC_KEY_FOOTER));
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

// A verifier per origin this node hears from, by id, bounded like the PEMs.
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
  const key = await importSigningKey(privateKey);
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
// the public one (src/crypto.js has its own, on the thread pool).
const verifyAsync = verify;

const loadSigningKeys = async (basePath = 'keys', { fsi = defaultFsi } = {}) => {
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
  verifyAsync,
};
