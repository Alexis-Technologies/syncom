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
//   place, a blob's bytes as bytes (iv ‖ ciphertext, no base64:
//   `sealBytes`/`openBytes`) (./at-rest-engine.js); the files engine is
//   wrapped at its backend.
// - `rotateAtRest(engine | { fsi, filesEngine }, { path, from, to, into })` —
//   the key rotated by a copy (engines/copy.js) into another path, engine or
//   backend; the source is then fenced with `moved.json` (createDatabase
//   refuses it as MOVED, naming where it went) until it is dropped.

const { generateKeys, encrypt, decrypt, loadKeys } = require('./rsa.js');
const { checkFsi } = require('../backend.js');
const { isEngine } = require('../engine.js');
const { SyncomError } = require('../errors.js');
const { atRestEngine } = require('./at-rest-engine.js');
const { copyEngine } = require('../engines/copy.js');

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
const TAG_BYTES = 16;
// The fence a rotated source carries in its root namespace (src/identity.js reads it: MOVED).
const MOVED_FILE = 'moved.json';
const DEFAULT_ITERATIONS = 600_000;
const subtle = () => globalThis.crypto.subtle;

// Base64 of bytes, three at a time into four letters, a chunk of text per
// 3 KB joined at the end: a string per byte was a heap of them for a record.
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_CHUNK = 3072;
const toBase64 = (bytes) => {
  const out = [];
  let chunk = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    chunk += B64[n >> 18] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
    if (chunk.length === (B64_CHUNK / 3) * 4) {
      out.push(chunk);
      chunk = '';
    }
  }
  if (i < bytes.length) {
    const second = i + 1 < bytes.length;
    const n = (bytes[i] << 16) | ((second ? bytes[i + 1] : 0) << 8);
    chunk += B64[n >> 18] + B64[(n >> 12) & 63] + (second ? B64[(n >> 6) & 63] : '=') + '=';
  }
  out.push(chunk);
  return out.join('');
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

// The cipher of one key: `sealBytes(name, bytes)` → iv ‖ ciphertext (the tag
// inside) bound to `name` (the additional data of AES-GCM), `openBytes(where,
// name, bytes)` the bytes back or DECRYPT_FAILED `key` naming `where` — what a
// blob is sealed as, its size its own; `seal(name, text)` → `enc1:` and the
// base64 of the same, `open(where, name, text)` the text back ('plain' for a
// text without the prefix, 'torn' for one that is no base64). The key is
// imported or derived once, at the first call (a failed import surfaces
// there, not as an unhandled rejection).
const createCipher = (options) => {
  const ready = keyOf(checkOptions(options));
  ready.catch(() => {});
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const bound = (name) => ({ additionalData: encoder.encode(name) });
  const sealBytes = async (name, bytes) => {
    const key = await ready;
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const params = { name: 'AES-GCM', iv, ...bound(name) };
    const body = new Uint8Array(await subtle().encrypt(params, key, bytes));
    const out = new Uint8Array(iv.length + body.length);
    out.set(iv, 0);
    out.set(body, iv.length);
    return out;
  };
  const openBytes = async (where, name, bytes) => {
    // Too short for an iv and a tag: never sealed here (a plain blob under the wrapper), or torn.
    if (!(bytes instanceof Uint8Array) || bytes.length < IV_BYTES + TAG_BYTES) throw failed(where, 'key');
    const key = await ready;
    try {
      const iv = bytes.subarray(0, IV_BYTES);
      const params = { name: 'AES-GCM', iv, ...bound(name) };
      return new Uint8Array(await subtle().decrypt(params, key, bytes.subarray(IV_BYTES)));
    } catch (error) {
      throw failed(where, 'key', error);
    }
  };
  const seal = async (name, text) => PREFIX + toBase64(await sealBytes(name, encoder.encode(text)));
  const open = async (where, name, text) => {
    if (typeof text !== 'string' || !text.startsWith(PREFIX)) throw failed(where, 'plain');
    let bytes;
    try {
      bytes = fromBase64(text.slice(PREFIX.length));
    } catch (error) {
      throw failed(where, 'torn', error);
    }
    return decoder.decode(await openBytes(where, name, bytes));
  };
  return { seal, open, sealBytes, openBytes };
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
    const { seal, open, sealBytes, openBytes } = createCipher(options);
    return atRestEngine(target, {
      seal,
      open: (name, text) => open(name, name, text),
      sealBytes,
      openBytes: (name, bytes) => openBytes(name, name, bytes),
    });
  }
  return atRestFsi(target, options);
};

/**
 * The at-rest key rotated by a copy: the database at `path`, sealed under `from`, copied whole — every record,
 * piece, copy, kv text, log entry and blob — into `into` (`{ path }` on the same engine or backend, `{ engine }`,
 * `{ fsi }`, or a path with either) sealed under `to`; the same node (its identity, epoch, vector and heads go with
 * it), so a peer resumes where it was. Over an engine (memory, IndexedDB, SQLite, MongoDB) `rotateAtRest(engine, …)`;
 * over a backend — the files engine, wrapped at its backend — `rotateAtRest({ fsi, filesEngine }, …)` with the files
 * engine's factory (`filesEngine` of the main entry: nothing of it is bundled here). Never in place: a copy cut short
 * leaves the source as it was and the target marked (`copy.json`), which the next copy takes away first
 * (`TARGET_NOT_EMPTY` for a target that holds a database). Once copied, the source is FENCED: `moved.json` in its root
 * namespace names where it went, and `createDatabase` there refuses `MOVED` until `dropDatabase` takes it — the same
 * node id never writes in two places. Open the database at its new place with `atRest(…, to)`.
 */
const rotateAtRest = async (target, { path, from, to, into, batch } = {}) => {
  const overBackend = target !== null && typeof target === 'object' && !isEngine(target) && 'fsi' in target;
  if (!overBackend && !isEngine(target)) {
    throw new TypeError('rotateAtRest(): an engine, or { fsi, filesEngine } for a backend');
  }
  if (typeof path !== 'string' || path.length === 0) throw new TypeError('rotateAtRest(): path');
  const named = into !== null && typeof into === 'object';
  if (!named || (into.engine === undefined && into.path === undefined && into.fsi === undefined)) {
    throw new TypeError(
      'rotateAtRest(): into names where the rotated database lands — { path }, { engine } or { fsi }',
    );
  }
  const targetPath = into.path ?? path;
  let source;
  let destination;
  let engineName;
  if (overBackend) {
    const { fsi, filesEngine } = target;
    checkFsi(fsi, 'rotateAtRest({ fsi })');
    if (typeof filesEngine !== 'function') {
      throw new TypeError(
        "rotateAtRest({ fsi, filesEngine }): the files engine's factory — filesEngine of '@alexify/syncom'",
      );
    }
    if (into.engine !== undefined) {
      throw new TypeError('rotateAtRest({ fsi }): into names a path or a backend (fsi), not an engine');
    }
    const other = into.fsi === undefined ? fsi : checkFsi(into.fsi, 'rotateAtRest(into.fsi)');
    if (other === fsi && targetPath === path) {
      throw new TypeError('rotateAtRest(): a database is not rotated in place — into another path or backend');
    }
    source = filesEngine(atRestFsi(fsi, from));
    destination = filesEngine(atRestFsi(other, to));
    engineName = 'files';
  } else {
    if (into.fsi !== undefined) {
      throw new TypeError('rotateAtRest(engine): into names a path or an engine, not a backend');
    }
    const engine = into.engine ?? target;
    if (engine === target && targetPath === path) {
      throw new TypeError('rotateAtRest(): a database is not rotated in place — into another path or engine');
    }
    source = atRest(target, from);
    destination = atRest(engine, to);
    engineName = engine.name;
  }
  const counts = await copyEngine(source, destination, { path, targetPath, batch });
  // The fence: the source says where it went (sealed under its own key), and opens nowhere until dropped.
  const moved = JSON.stringify({ to: { path: targetPath, engine: engineName }, at: Date.now() });
  const db = await source.open(path, {});
  try {
    await db.kv.put('', MOVED_FILE, moved, { atomic: true });
  } finally {
    await db.close();
  }
  return counts;
};

module.exports = { encryption, atRest, rotateAtRest, generateKeys, encrypt, decrypt, loadKeys };
