'use strict';

const fsi = require('./fsi.browser.js');

const PUBLIC_KEY_HEADER = '-----BEGIN PUBLIC KEY-----';
const PUBLIC_KEY_FOOTER = '-----END PUBLIC KEY-----';
const PRIVATE_KEY_HEADER = '-----BEGIN PRIVATE KEY-----';
const PRIVATE_KEY_FOOTER = '-----END PRIVATE KEY-----';

const RSA = { name: 'RSA-OAEP', hash: 'SHA-256' };
const AES = 'AES-GCM';
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

const importPublicKey = async (pemKey) => {
  const bytes = fromBase64(cleanPemKey(pemKey, PUBLIC_KEY_HEADER, PUBLIC_KEY_FOOTER));
  return crypto.subtle.importKey('spki', bytes, RSA, false, ['encrypt']);
};

const importPrivateKey = async (pemKey) => {
  const bytes = fromBase64(cleanPemKey(pemKey, PRIVATE_KEY_HEADER, PRIVATE_KEY_FOOTER));
  return crypto.subtle.importKey('pkcs8', bytes, RSA, false, ['decrypt']);
};

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
  if (envelope.v !== 1 || envelope.alg !== ALG) throw new Error('Unsupported ciphertext envelope');
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

const loadKeys = async (basePath = 'keys') => {
  let publicKey, privateKey;
  // Both halves of the pair, or neither: a public.pem left behind without
  // its private.pem used to surface as an ENOENT from the second read.
  const hasPublic = await fsi.exists(basePath, 'public.pem');
  const hasPrivate = await fsi.exists(basePath, 'private.pem');
  if (hasPublic && hasPrivate) {
    publicKey = await fsi.read(basePath, 'public.pem');
    privateKey = await fsi.read(basePath, 'private.pem');
  } else {
    const keys = await generateKeys();
    ({ publicKey, privateKey } = keys);
    await fsi.write(basePath, 'public.pem', publicKey);
    await fsi.write(basePath, 'private.pem', privateKey);
  }
  return { publicKey, privateKey };
};

module.exports = { calculateHash, generateKeys, encrypt, decrypt, loadKeys };
