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
// another name may share them) until `sweep()` — mark-and-sweep over the live
// records' registers, the tags' copies and the puts in flight, then every
// other digest of the store removed. A register is believed only as far as it is
// one (`validEntry`: a digest, a type, a length within MAX_BLOB_BYTES, an
// encoding the plugin knows — a peer writes registers too, and a digest is a
// key of the store): `ATTACHMENT_INVALID` from `get`/`has`, skipped by `list`.
// Requires errors.js, blobs.js, symbols.js, crypto/digest.js only: the id is
// checked where it enters the core (`get`, `update`, `unset`), as every id is.

const { SyncomError, typed } = require('../errors.js');
const { isDigest, checkBlobBytes, MAX_BLOB_BYTES } = require('../blobs.js');
const { SOURCE } = require('../symbols.js');
const { hashBytes } = require('../crypto/digest.js');

const FIELD = '_attachments';
const NAME = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$/;
const ENCODINGS = new Set(['gzip', 'deflate']);
const DEFAULT_TYPE = 'application/octet-stream';
// A sweep reads the live records this many at a time (one read of the engine each page).
const SWEEP_PAGE = 500;
const TAGS_FILE = 'tags.json';
// The copies a tag has not taken yet (src/versions/tags.js PENDING): records as they were, named by no tag yet.
const PENDING_TAG = '.pending';
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

const compress = async (bytes, encoding) => {
  const stream = new Blob([bytes]).stream().pipeThrough(new globalThis.CompressionStream(encoding));
  return new Uint8Array(await new Response(stream).arrayBuffer());
};
// The stored bytes inflated as far as the register's `length` and no further: the chunks counted as they come, the
// reader cancelled the moment they pass `limit` — null then. A register is a peer's word; a few KiB of gzip could
// name a few GiB otherwise.
const inflate = async (bytes, encoding, limit) => {
  const stream = new Blob([bytes]).stream().pipeThrough(new globalThis.DecompressionStream(encoding));
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (let i = 0; i < chunks.length; i++) {
    out.set(chunks[i], at);
    at += chunks[i].length;
  }
  return out;
};

// The digests a record's registers name, added to `marked`: what a sweep keeps. A reader's view nests the field
// (`_attachments: { name: entry }`); a stored record file keeps every path apart (`'_attachments/name': entry`).
const PREFIX = `${FIELD}/`;
const markOf = (data, marked) => {
  if (!isPlainObject(data)) return;
  const held = data[FIELD];
  if (isPlainObject(held)) {
    for (const name of Object.keys(held)) if (validEntry(held[name])) marked.add(held[name].digest);
  }
  for (const key of Object.keys(data)) {
    if (key.startsWith(PREFIX) && validEntry(data[key])) marked.add(data[key].digest);
  }
};

class Attachments {
  #storage;
  #db;
  #blobs;
  #encoding;
  #logger;
  // The invalid registers warned about, once each (`<id>/<name>`).
  #warned = new Set();
  // The digests of the puts in flight — between the blob's put and the register's landing — and how many each.
  #pending = new Map();
  constructor(storage, db, encoding, logger) {
    this.#storage = storage;
    this.#db = db;
    this.#blobs = db.blobs;
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
    // A sealed record takes none: the blobs store holds bytes the record's key does not cover.
    const row = this.#storage[SOURCE].row(id);
    if (row !== null && row.encrypted === true) {
      throw new SyncomError(
        'ENCRYPTED',
        `attachments.put(): record ${id} is sealed — its bytes would lie in the clear`,
        { id },
      );
    }
    // In flight: a sweep meanwhile keeps the blob the register is about to name.
    this.#pending.set(entry.digest, (this.#pending.get(entry.digest) ?? 0) + 1);
    try {
      await this.#blobs.put(entry.digest, stored);
      await this.#storage.update(id, { [field]: entry });
    } finally {
      const left = this.#pending.get(entry.digest) - 1;
      if (left === 0) this.#pending.delete(entry.digest);
      else this.#pending.set(entry.digest, left);
    }
    return entry;
  }

  /**
   * Mark-and-sweep over the blobs store: every digest a live record's register names, a tag's copy names (`tags`,
   * on by default; the pending copies among them) or a put in flight holds is kept, every other blob removed.
   * Answers `{ blobs, marked, removed, pending }`; `dryRun` counts and removes nothing. The log is not marked: a
   * `restore()` or `applyPatches()` that brings a swept register back names bytes a peer may still hold (fetched on
   * the read), else `BLOB_NOT_FOUND`. The writer's alone: `READ_ONLY` on a follower, `CLOSED` after close.
   */
  async sweep({ dryRun = false, tags = true } = {}) {
    const seam = this.#storage[SOURCE];
    seam.guard('a sweep');
    const started = Date.now();
    const marked = new Set();
    // The live records, a page at a time: a row that is gone names nothing.
    const ids = seam.all();
    let page = [];
    for (let i = 0; i <= ids.length; i++) {
      if (i < ids.length) {
        const row = seam.row(ids[i]);
        if (row === null || row.gone === true) continue;
        page.push(ids[i]);
      }
      if (page.length < SWEEP_PAGE && i < ids.length) continue;
      if (page.length > 0) {
        const found = await seam.loadMany(page);
        for (const data of found.values()) markOf(data, marked);
        page = [];
      }
    }
    // A tag's copies: the records as they were, their registers too (a sealed copy reads as none here).
    if (tags) {
      const names = [PENDING_TAG];
      const text = await this.#db.kv.get('', TAGS_FILE);
      if (text !== null) {
        let parsed = null;
        try {
          parsed = JSON.parse(text);
        } catch {
          // Unreadable tags are none: nothing of them to keep.
        }
        const held = Array.isArray(parsed?.tags) ? parsed.tags : [];
        for (let i = 0; i < held.length; i++) if (typeof held[i]?.name === 'string') names.push(held[i].name);
      }
      for (let i = 0; i < names.length; i++) {
        const copied = await this.#db.copies.ids(names[i]);
        for (let k = 0; k < copied.length; k++) {
          const raw = await this.#db.copies.get(names[i], copied[k]);
          if (raw === null) continue;
          let stored = null;
          try {
            stored = JSON.parse(raw);
          } catch {
            // A copy that does not read names nothing.
          }
          if (stored !== null && stored.encrypted !== true) markOf(stored.data, marked);
        }
      }
    }
    for (const digest of this.#pending.keys()) marked.add(digest);
    // The sweep: what the store holds and nothing names.
    const digests = await this.#blobs.list();
    let removed = 0;
    for (let i = 0; i < digests.length; i++) {
      if (marked.has(digests[i])) continue;
      if (!dryRun) await this.#blobs.remove(digests[i]);
      removed++;
    }
    const result = { blobs: digests.length, marked: marked.size, removed, pending: this.#pending.size };
    this.#logger.info({ event: 'attachments.sweep', ...result, dryRun, ms: Date.now() - started });
    return result;
  }

  /**
   * The attachment named: `{ bytes, type, length, digest, encoding? }`, or null where the record names none. Bytes
   * this node lacks are asked of the peers it dials (`fetch: false` to skip); none has them, `BLOB_NOT_FOUND`. The
   * bytes are what the register says or BLOB_MISMATCH: a plain blob of another length (`reason: 'length'`), a
   * compressed one that inflates past `length` (`'inflated'`, the inflating stopped there) or to another length.
   */
  async get(id, name, { fetch = true } = {}) {
    const entry = await this.#entry(id, name);
    if (entry === null) return null;
    let stored = await this.#blobs.get(entry.digest);
    if (stored === null) {
      if (fetch !== true) throw this.#missing(id, name, entry.digest);
      stored = await this.#fetch(entry.digest, id, name);
    }
    const bytes = entry.encoding === undefined ? stored : await inflate(stored, entry.encoding, entry.length);
    if (bytes === null) throw this.#mismatch(id, name, entry.digest, 'inflated');
    if (bytes.length !== entry.length) throw this.#mismatch(id, name, entry.digest, 'length');
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

  #mismatch(id, name, digest, reason) {
    return new SyncomError(
      'BLOB_MISMATCH',
      `The bytes of attachment ${name} of ${id} (${digest}) are not what the register says (${reason})`,
      { id, attachment: name, digest, reason },
    );
  }

  #missing(id, name, digest) {
    return new SyncomError('BLOB_NOT_FOUND', `The bytes of attachment ${name} of ${id} (${digest}) are not here`, {
      id,
      attachment: name,
      digest,
    });
  }

  // The bytes asked of the peers, through the sync plugin where it runs: checked by digest and kept there (once —
  // `fetchBlob` puts them into this node's store; a store that refuses is its warning), answered here.
  async #fetch(digest, id, name) {
    let sync = null;
    try {
      sync = this.#storage.sync;
    } catch {
      // No sync plugin: nobody to ask.
    }
    if (sync === null || typeof sync.fetchBlob !== 'function') throw this.#missing(id, name, digest);
    try {
      return await sync.fetchBlob(digest);
    } catch (error) {
      if (error?.code !== 'BLOB_NOT_FOUND') throw error;
      throw this.#missing(id, name, digest);
    }
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
      return { attachments: new Attachments(storage, db, compression, logger) };
    },
  });
};

module.exports = { attachments, Attachments, FIELD };
