'use strict';

// Attachments (@alexify/syncom/attachments): bytes beside a record — a file,
// an image — kept in the engine's `blobs` store under their SHA-256 and named
// on the record as a register `_attachments/<name>` = `{ digest, type,
// length, encoding? }`, which replicates like any field. The bytes do not: a
// node that holds the name but not the bytes asks the peers it dials
// (`syncom/blob`, through the sync plugin), checks the digest and keeps
// them; none has them, `BLOB_NOT_FOUND`. `createDatabase({ plugins:
// [attachments()] })` hands the core `db.attachments`: `put(id, name, bytes,
// { type })`, `get(id, name, { fetch })`, `has`, `list(id)`, `remove(id,
// name)` — the engine must have a `blobs` store (`capabilities.blobs`).
// `attachments({ compression: 'gzip' | 'deflate' })` stores the bytes
// compressed through CompressionStream where the platform has it — the
// digest is the stored bytes', `encoding` on the register — and `get()`
// inflates. A removed name leaves its bytes in the store (another record,
// another name may share them). A register is believed only as far as it is
// one (`validEntry`: a digest, a type, a length within MAX_BLOB_BYTES, an
// encoding the plugin knows — a peer writes registers too, and a digest is a
// key of the store): `ATTACHMENT_INVALID` from `get`/`has`, skipped by `list`.
// Requires errors.js, blobs.js, crypto/digest.js only: the id is checked where
// it enters the core (`get`, `update`, `unset`), as every id is.

const { SyncomError, typed } = require('../errors.js');
const { isDigest, checkBlobBytes, MAX_BLOB_BYTES } = require('../blobs.js');
const { hashBytes } = require('../crypto/digest.js');

const FIELD = '_attachments';
const NAME = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$/;
const ENCODINGS = new Set(['gzip', 'deflate']);
const DEFAULT_TYPE = 'application/octet-stream';
const encoder = new TextEncoder();

const checkName = (name) => {
  if (typeof name !== 'string' || !NAME.test(name)) {
    throw new TypeError(
      `attachments: a name is a text of up to 128 letters, digits, '.', '_', '@' or '-' — not ${JSON.stringify(name)}`,
    );
  }
  return name;
};
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
// A register as a reader may believe it: `{ digest, type, length, encoding? }`, each field what it says.
const validEntry = (entry) =>
  isPlainObject(entry) &&
  isDigest(entry.digest) &&
  typeof entry.type === 'string' &&
  entry.type.length > 0 &&
  Number.isSafeInteger(entry.length) &&
  entry.length >= 0 &&
  entry.length <= MAX_BLOB_BYTES &&
  (entry.encoding === undefined || ENCODINGS.has(entry.encoding));
// The bytes as a Uint8Array: given as one, as an ArrayBuffer, or as text (UTF-8).
const bytesOf = (value) => {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (typeof value === 'string') return encoder.encode(value);
  throw new TypeError('attachments: the bytes are a Uint8Array, an ArrayBuffer or a string');
};

const through = async (bytes, Stream, encoding) => {
  const stream = new Blob([bytes]).stream().pipeThrough(new Stream(encoding));
  return new Uint8Array(await new Response(stream).arrayBuffer());
};
const compress = (bytes, encoding) => through(bytes, globalThis.CompressionStream, encoding);
const decompress = (bytes, encoding) => through(bytes, globalThis.DecompressionStream, encoding);

class Attachments {
  #storage;
  #blobs;
  #encoding;
  #logger;
  // The invalid registers warned about, once each (`<id>/<name>`).
  #warned = new Set();
  constructor(storage, blobs, encoding, logger) {
    this.#storage = storage;
    this.#blobs = blobs;
    this.#encoding = encoding;
    this.#logger = logger;
  }

  // The attachment's name rides as `attachment`: a field named `name` would be the error's own.
  #invalid(id, name) {
    return new SyncomError('ATTACHMENT_INVALID', `The register of attachment ${name} of ${id} is no register`, {
      id,
      attachment: name,
    });
  }

  // The register of a name on a record, as the record reads now: `{ digest, type, length, encoding? }`, null where
  // the record names none — ATTACHMENT_INVALID where it names something that is no register.
  async #entry(id, name) {
    const data = await this.#storage.get(id);
    const held = data?.[FIELD];
    if (!isPlainObject(held)) return null;
    const entry = held[checkName(name)];
    if (entry === undefined || entry === null) return null;
    if (!validEntry(entry)) throw this.#invalid(id, name);
    return entry;
  }

  /** The register's field of a name: `_attachments/<name>` — a name checked. */
  field(name) {
    return `${FIELD}/${checkName(name)}`;
  }

  /**
   * What a `put` would store and write, made without storing or writing: `{ stored, entry, field }` — the bytes as
   * the store keeps them (compressed where the plugin was told to), the register and its field name. A follower of
   * `@alexify/syncom/shared` puts the blob into the shared store itself and forwards the register to the leader.
   */
  async prepare(name, bytes, { type = DEFAULT_TYPE } = {}) {
    checkName(name);
    if (typeof type !== 'string' || type.length === 0) {
      throw new TypeError('attachments.put(): type must be a media type');
    }
    const plain = checkBlobBytes(typed, bytesOf(bytes), 'attachments.put()');
    const stored = this.#encoding === null ? plain : await compress(plain, this.#encoding);
    const digest = await hashBytes(stored);
    const entry = { digest, type, length: plain.length };
    if (this.#encoding !== null) entry.encoding = this.#encoding;
    return { stored, entry, field: this.field(name) };
  }

  /**
   * Keeps `bytes` under the record as `name`: the bytes in the engine's blobs store by their digest (compressed
   * where the plugin was told to), the name on the record. Answers `{ digest, type, length, encoding? }`.
   */
  async put(id, name, bytes, options) {
    const { stored, entry, field } = await this.prepare(name, bytes, options);
    await this.#blobs.put(entry.digest, stored);
    await this.#storage.update(id, { [field]: entry });
    return entry;
  }

  /**
   * The attachment named: `{ bytes, type, length, digest, encoding? }`, or null where the record names none. Bytes
   * this node lacks are asked of the peers it dials (`fetch: false` to skip); none has them, `BLOB_NOT_FOUND`.
   */
  async get(id, name, { fetch = true } = {}) {
    const entry = await this.#entry(id, name);
    if (entry === null) return null;
    let stored = await this.#blobs.get(entry.digest);
    if (stored === null) {
      if (fetch !== true) throw this.#missing(id, name, entry.digest);
      stored = await this.#fetch(entry.digest, id, name);
    }
    const bytes = entry.encoding === undefined ? stored : await decompress(stored, entry.encoding);
    const out = { bytes, type: entry.type, length: entry.length, digest: entry.digest };
    if (entry.encoding !== undefined) out.encoding = entry.encoding;
    return out;
  }

  /** Whether this node holds the bytes of the attachment named (not whether the record names it). */
  async has(id, name) {
    const entry = await this.#entry(id, name);
    return entry === null ? false : this.#blobs.has(entry.digest);
  }

  /** The record's attachments: `[{ name, digest, type, length, encoding? }]`, by name; a register that is none is left out, warned once. */
  async list(id) {
    const data = await this.#storage.get(id);
    const held = data?.[FIELD];
    const out = [];
    if (!isPlainObject(held)) return out;
    const names = Object.keys(held).sort();
    for (let i = 0; i < names.length; i++) {
      const entry = held[names[i]];
      if (validEntry(entry)) out.push({ name: names[i], ...entry });
      else if (entry !== null && entry !== undefined) {
        const key = `${id}/${names[i]}`;
        if (!this.#warned.has(key)) {
          this.#warned.add(key);
          this.#logger.warn({ event: 'attachments.register.invalid', id, name: names[i] });
        }
      }
    }
    return out;
  }

  /** Takes the name off the record (an `unset`: replicated); the bytes stay in the store. */
  async remove(id, name) {
    await this.#storage.unset(id, [this.field(name)]);
  }

  #missing(id, name, digest) {
    return new SyncomError('BLOB_NOT_FOUND', `The bytes of attachment ${name} of ${id} (${digest}) are not here`, {
      id,
      attachment: name,
      digest,
    });
  }

  // The bytes asked of the peers, through the sync plugin where it runs: checked by digest there, kept here.
  async #fetch(digest, id, name) {
    let sync = null;
    try {
      sync = this.#storage.sync;
    } catch {
      // No sync plugin: nobody to ask.
    }
    if (sync === null || typeof sync.fetchBlob !== 'function') throw this.#missing(id, name, digest);
    let bytes;
    try {
      bytes = await sync.fetchBlob(digest);
    } catch (error) {
      if (error?.code !== 'BLOB_NOT_FOUND') throw error;
      throw this.#missing(id, name, digest);
    }
    try {
      await this.#blobs.put(digest, bytes);
    } catch (error) {
      // Kept next time: the bytes are answered all the same.
      this.#logger.warn({ event: 'attachments.keep.failed', id, name, digest, err: error });
    }
    return bytes;
  }
}

/** The plugin: `db.attachments`. `compression` is `'gzip'`, `'deflate'` or none. */
const attachments = ({ compression = null } = {}) => {
  if (compression !== null && !ENCODINGS.has(compression)) {
    throw new TypeError("attachments(): compression is 'gzip', 'deflate' or null");
  }
  if (compression !== null && typeof globalThis.CompressionStream !== 'function') {
    throw new TypeError('attachments(): this platform has no CompressionStream');
  }
  return Object.freeze({
    name: 'attachments',
    setup({ db, storage, logger }) {
      if (db === null || db === undefined || db.blobs === undefined) {
        throw new TypeError('attachments: the engine has no blobs store (capabilities.blobs)');
      }
      return { attachments: new Attachments(storage, db.blobs, compression, logger) };
    },
  });
};

module.exports = { attachments, Attachments, FIELD };
