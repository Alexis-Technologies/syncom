'use strict';

// The browser half of the encryption plugin (Web Crypto): the same envelope
// as ./rsa.js, so a record sealed on one platform opens on the other given
// the same key pair.

const defaultFsi = require('../fsi.browser.js');
const { loadKeyPair } = require('../keys.js');
const { SyncomError } = require('../errors.js');
const { PUBLIC_KEY_HEADER, PUBLIC_KEY_FOOTER, PRIVATE_KEY_HEADER, PRIVATE_KEY_FOOTER } = require('../pem.js');
const { toBase64, fromBase64, toPem, cleanPem } = require('../pem.js');

const RSA = { name: 'RSA-OAEP', hash: 'SHA-256' };
const AES = 'AES-GCM';
const ALG = 'RSA-OAEP-256+A256GCM';
const TAG_BYTES = 16;

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

// A storage uses one pair for its whole life; importing the PEM on every
// call was the cost of every sealed record. A few imported keys are kept,
// by usage and PEM text.
const imported = new Map();
const MAX_IMPORTED = 8;

const importKey = (pemKey, header, footer, format, usage) => {
  const cacheKey = `${usage}:${pemKey}`;
  const cached = imported.get(cacheKey);
  if (cached !== undefined) return cached;
  const bytes = fromBase64(cleanPem(pemKey, header, footer));
  const key = crypto.subtle.importKey(format, bytes, RSA, false, [usage]);
  if (imported.size >= MAX_IMPORTED) imported.delete(imported.keys().next().value);
  imported.set(cacheKey, key);
  key.catch(() => imported.delete(cacheKey));
  return key;
};

const importPublicKey = (pemKey) => importKey(pemKey, PUBLIC_KEY_HEADER, PUBLIC_KEY_FOOTER, 'spki', 'encrypt');
const importPrivateKey = (pemKey) => importKey(pemKey, PRIVATE_KEY_HEADER, PRIVATE_KEY_FOOTER, 'pkcs8', 'decrypt');

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

module.exports = { generateKeys, encrypt, decrypt, loadKeys };
