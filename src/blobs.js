'use strict';

// The door of every blobs store (src/engine.js `blobs`): what a key and a
// blob must be before any medium sees them. A blob's key is its SHA-256 as
// hex — 64 lowercase characters, nothing else: a digest is a file name in the
// files engine and a filter everywhere else, and a register a peer wrote
// names one (src/attachments). A blob is a Uint8Array of at most
// MAX_BLOB_BYTES (64 MiB): what a peer may be asked for over `syncom/blob`,
// what every store takes — the one cap, here. Required by the engines, the
// at-rest wrapper, the served store, the attachments plugin and the dialer's
// `fetchBlob`; a module of its own so that engine.js, which every block
// bundles, carries none of it. `checkBlobBytes` takes the caller's `typed`
// (src/errors.js) for BLOB_TOO_LARGE: a size is data. No requires.

const MAX_BLOB_BYTES = 64 * 1024 * 1024;
const DIGEST = /^[0-9a-f]{64}$/;

/** Whether `value` is a blob's key: SHA-256 as 64 lowercase hex characters. */
const isDigest = (value) => typeof value === 'string' && value.length === 64 && DIGEST.test(value);

/** A digest, or a TypeError naming the store's method (`label`). */
const checkDigest = (value, label) => {
  if (!isDigest(value)) throw new TypeError(`${label}: ${JSON.stringify(value)} is not a digest (SHA-256 as hex)`);
  return value;
};

/** A blob's bytes: a Uint8Array (a TypeError otherwise) within MAX_BLOB_BYTES (BLOB_TOO_LARGE past it). */
const checkBlobBytes = (typed, bytes, label) => {
  if (!(bytes instanceof Uint8Array)) throw new TypeError(`${label}: a blob is a Uint8Array`);
  if (bytes.length > MAX_BLOB_BYTES) {
    throw typed(
      'BLOB_TOO_LARGE',
      `${label}: a blob of ${bytes.length} bytes is past MAX_BLOB_BYTES (${MAX_BLOB_BYTES})`,
      {
        length: bytes.length,
        max: MAX_BLOB_BYTES,
      },
    );
  }
  return bytes;
};

module.exports = { MAX_BLOB_BYTES, isDigest, checkDigest, checkBlobBytes };
