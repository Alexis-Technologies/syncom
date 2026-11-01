'use strict';

// Encryption as blocks (@alexify/syncom/encryption):
//
// - `encryption` — the plugin behind `{ encrypted: true }`: a record sealed for
//   THIS node's RSA pair (`keys/public.pem`, `keys/private.pem`, made at the
//   first open), written outside the op log, never replicated. The core
//   calls the hooks `seal.encrypt(data)` and `seal.decrypt(text)`; without
//   the plugin an encrypted write is PLUGIN_MISSING. The envelope is
//   ./rsa.js's (node:crypto) or ./rsa.browser.js's (Web Crypto) — the same
//   bytes on both.
// - `atRest(fsi | engine, { key | password, salt })` — a backend wrapper, the way
//   RxDB wraps a storage: every file the storage writes through it — the
//   records, the log, the catalog, the tags, node.json, the lock, the keys —
//   is AES-256-GCM encrypted under one key, `enc1:` and base64(iv ‖
//   ciphertext ‖ tag), and decrypted on the way back; `exists`, `remove`,
//   `list` and `create` pass through. The key is 32 bytes given, or derived
//   from a password with PBKDF2-SHA-256 and a salt the caller keeps; it is
//   never written. Web Crypto on both platforms. The engine knows nothing of
//   it: a storage opened over the wrapper reads its own files, one opened
//   over the bare backend reads `enc1:…` and refuses the file
//   (DECRYPT_FAILED, reason 'plain' the other way round). Given an engine
//   (memory, IndexedDB, SQLite, MongoDB), the same over its stores — every
//   record, piece, copy, kv text and log entry a ciphertext bound to its
//   place (./at-rest-engine.js); the files engine is wrapped at its backend.

const { generateKeys, encrypt, decrypt, loadKeys } = require('./rsa.js');
const { checkFsi } = require('../backend.js');
const { isEngine } = require('../engine.js');
const { SyncomError } = require('../errors.js');
const { atRestEngine } = require('./at-rest-engine.js');

const encryption = Object.freeze({
  name: 'encryption',
  async setup({ db }) {
    const keys = await loadKeys('keys', { kv: db.kv });
    return {
      seal: {
        encrypt: (data) => encrypt(data, keys.publicKey),
        decrypt: (text) => decrypt(text, keys.privateKey),
      },
    };
  },
});

// ---------------------------------------------------------------------------
// At rest

// `enc1:` binds each ciphertext to its file name (the additional data of
// AES-GCM): a file copied over another one of the store does not decrypt.
const PREFIX = 'enc1:';
const IV_BYTES = 12;
const DEFAULT_ITERATIONS = 600_000;
const subtle = () => globalThis.crypto.subtle;

const toBase64 = (bytes) => {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
};
const fromBase64 = (text) => {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
};

const failed = (where, reason, cause) =>
  new SyncomError(
    'DECRYPT_FAILED',
    `${where}: ${reason === 'plain' ? 'not encrypted' : 'cannot be decrypted (the wrong key, or a torn file)'}`,
    { path: where, reason, cause },
  );

// The options, checked when the wrapper is made (a TypeError then, not at
// the first file): the key given, or what derives one.
const checkOptions = (options) => {
  if (options === null || typeof options !== 'object') throw new TypeError('atRest() takes an options object');
  const { key, password, salt, iterations = DEFAULT_ITERATIONS } = options;
  if (key !== undefined) {
    const isKey = typeof CryptoKey === 'function' && key instanceof CryptoKey;
    if (!isKey && !(key instanceof Uint8Array && key.length === 32)) {
      throw new TypeError('atRest(): key must be 32 bytes (a Uint8Array) or a CryptoKey');
    }
    return { key };
  }
  if (typeof password !== 'string' || password.length === 0) {
    throw new TypeError('atRest(): give a key (32 bytes) or a password with a salt');
  }
  if (typeof salt !== 'string' || salt.length < 8) {
    throw new TypeError('atRest(): a password needs a salt of 8 characters or more, kept by the caller');
  }
  if (!Number.isInteger(iterations) || iterations < 1000) {
    throw new TypeError('atRest(): iterations must be an integer of 1000 or more');
  }
  return { password, salt, iterations };
};

const keyOf = async ({ key, password, salt, iterations }) => {
  if (key !== undefined) {
    if (key instanceof Uint8Array) return subtle().importKey('raw', key, 'AES-GCM', false, ['encrypt', 'decrypt']);
    return key;
  }
  const encoder = new TextEncoder();
  const base = await subtle().importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveKey']);
  const params = { name: 'PBKDF2', hash: 'SHA-256', salt: encoder.encode(salt), iterations };
  return subtle().deriveKey(params, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
};

// The cipher of one key: `seal(name, text)` → `enc1:…` bound to `name` (the
// additional data of AES-GCM), `open(where, name, text)` the text back, or
// DECRYPT_FAILED naming `where`. The key is imported or derived once, at the
// first call (a failed import surfaces there, not as an unhandled rejection).
const createCipher = (options) => {
  const ready = keyOf(checkOptions(options));
  ready.catch(() => {});
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const bound = (name) => ({ additionalData: encoder.encode(name) });
  const seal = async (name, text) => {
    const key = await ready;
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const params = { name: 'AES-GCM', iv, ...bound(name) };
    const body = new Uint8Array(await subtle().encrypt(params, key, encoder.encode(text)));
    const out = new Uint8Array(iv.length + body.length);
    out.set(iv, 0);
    out.set(body, iv.length);
    return PREFIX + toBase64(out);
  };
  const open = async (where, name, text) => {
    if (typeof text !== 'string' || !text.startsWith(PREFIX)) throw failed(where, 'plain');
    const key = await ready;
    let bytes;
    try {
      bytes = fromBase64(text.slice(PREFIX.length));
    } catch (error) {
      throw failed(where, 'torn', error);
    }
    try {
      const iv = bytes.subarray(0, IV_BYTES);
      const params = { name: 'AES-GCM', iv, ...bound(name) };
      const plain = await subtle().decrypt(params, key, bytes.subarray(IV_BYTES));
      return decoder.decode(plain);
    } catch (error) {
      throw failed(where, 'key', error);
    }
  };
  return { seal, open };
};

// A backend whose every file is encrypted: the name, not the directory,
// binds the ciphertext — a store moved elsewhere still opens.
const atRestFsi = (fsi, options) => {
  const inner = checkFsi(fsi, 'atRest()');
  const { seal, open } = createCipher(options);
  const wrapped = {
    read: async (dir, filename) => open(`${dir}/${filename}`, filename, await inner.read(dir, filename)),
    write: async (dir, filename, content, writeOptions) =>
      inner.write(dir, filename, await seal(filename, content), writeOptions),
    exists: (dir, filename) => inner.exists(dir, filename),
    remove: (dir, filename) => inner.remove(dir, filename),
    list: (dir) => inner.list(dir),
  };
  if (typeof inner.sync === 'function') wrapped.sync = (dir, filename) => inner.sync(dir, filename);
  if (typeof inner.create === 'function') {
    wrapped.create = async (dir, filename, content) => inner.create(dir, filename, await seal(filename, content));
  }
  return wrapped;
};

/**
 * A backend — or an engine — whose every file, or value, is encrypted at
 * rest under one key: give it to `createDatabase({ fsi })` or
 * `createDatabase({ engine })`. `key` is 32 bytes (or a CryptoKey), or
 * `password` and `salt` derive one (PBKDF2-SHA-256, `iterations` 600 000 by
 * default). The files engine is wrapped at its backend: `filesEngine(atRest(fsi))`.
 */
const atRest = (target, options = {}) => {
  if (isEngine(target)) {
    const { seal, open } = createCipher(options);
    return atRestEngine(target, { seal, open: (name, text) => open(name, name, text) });
  }
  return atRestFsi(target, options);
};

module.exports = { encryption, atRest, generateKeys, encrypt, decrypt, loadKeys };
