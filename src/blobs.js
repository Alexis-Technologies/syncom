'use strict';

// The door of every blobs store (src/engine.js `blobs`): what a key and a
// blob must be before any medium sees them. A blob's key is its SHA-256 as
// hex — 64 lowercase characters, nothing else: a digest is a file name in the
// files engine and a filter everywhere else, and a register a peer wrote
// names one (src/attachments). A blob is a Uint8Array of at most
// MAX_BLOB_BYTES (64 MiB): what a peer may be asked for over `syncom/blob`,
// what every door that takes PLAIN bytes takes (attachments.put, fetchBlob, the
// at-rest wrapper's put) — the one cap, here; a store under the wrapper holds
// the sealed bytes, SEAL_OVERHEAD (an AES-GCM iv and tag) more, so an engine's
// store takes MAX_STORED_BYTES, and a blob at the cap is stored at rest. Required by the engines, the
// at-rest wrapper, the served store, the attachments plugin and the dialer's
// `fetchBlob`; a module of its own so that engine.js, which every block
// bundles, carries none of it. `checkBlobBytes` takes the caller's `typed`
// (src/errors.js) for BLOB_TOO_LARGE: a size is data. No requires.

const MAX_BLOB_BYTES = 64 * 1024 * 1024;
// What sealing a blob adds (src/encryption/encryption.js sealBytes: a 12-byte iv, a 16-byte tag).
const SEAL_OVERHEAD = 28;
const MAX_STORED_BYTES = MAX_BLOB_BYTES + SEAL_OVERHEAD;
const DIGEST = /^[0-9a-f]{64}$/;

/** Whether `value` is a blob's key: SHA-256 as 64 lowercase hex characters. */
const isDigest = (value) => typeof value === 'string' && value.length === 64 && DIGEST.test(value);

/** A digest, or a TypeError naming the store's method (`label`). */
const checkDigest = (value, label) => {
  if (!isDigest(value)) throw new TypeError(`${label}: ${JSON.stringify(value)} is not a digest (SHA-256 as hex)`);
  return value;
};

/**
 * A blob's bytes: a Uint8Array (a TypeError otherwise) within `max` — MAX_BLOB_BYTES at a door that takes plain bytes,
 * MAX_STORED_BYTES at an engine's store, which may hold them sealed (BLOB_TOO_LARGE past it).
 */
const checkBlobBytes = (typed, bytes, label, max = MAX_BLOB_BYTES) => {
  if (!(bytes instanceof Uint8Array)) throw new TypeError(`${label}: a blob is a Uint8Array`);
  if (bytes.length > max) {
    throw typed('BLOB_TOO_LARGE', `${label}: a blob of ${bytes.length} bytes is past the cap (${max})`, {
      length: bytes.length,
      max,
    });
  }
  return bytes;
};

module.exports = { MAX_BLOB_BYTES, MAX_STORED_BYTES, SEAL_OVERHEAD, isDigest, checkDigest, checkBlobBytes };
