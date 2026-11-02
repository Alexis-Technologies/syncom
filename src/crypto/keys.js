'use strict';

// The key pairs on disk, shared by both crypto halves: `public.pem` and
// `private.pem` — the RSA pair that seals records — and `sign-public.pem`
// and `sign-private.pem` — the Ed25519 pair that signs ops and whose public
// key is the node id — in `store`, one namespace (src/engine.js: the `keys`
// namespace of a database's kv, or a directory of an fsi). A pair is read
// when both halves are there, made when neither is, refused when one is. No
// requires beyond ../errors.js: the generator and the store are handed in.

const { SyncomError } = require('../errors.js');

// The mode a private key file is written with — owner-only where the store has permissions — kept by a copy (src/engines/copy.js).
const KEY_FILE_MODE = 0o600;

const KEY_FILES = { public: 'public.pem', private: 'private.pem' };
const SIGNING_FILES = { public: 'sign-public.pem', private: 'sign-private.pem' };

const incomplete = (where, hasPublic, files) => {
  const missing = hasPublic ? files.private : files.public;
  return new SyncomError('KEYS_INCOMPLETE', `Key pair at ${where} is incomplete: ${missing} is missing`);
};

// Half a pair is refused, not replaced: without private.pem every sealed
// record is already unreadable, without public.pem the next one would be,
// and a fresh pair would hide both behind records that decrypt to garbage.
// The signing pair the same: without its private half the node cannot sign
// as itself, and a fresh pair would be another node to every peer.
const loadKeyPair = async (store, where, generateKeys, files = KEY_FILES) => {
  const hasPublic = await store.has(files.public);
  const hasPrivate = await store.has(files.private);
  if (hasPublic !== hasPrivate) throw incomplete(where, hasPublic, files);
  if (hasPublic) return { publicKey: await store.get(files.public), privateKey: await store.get(files.private) };
  const keys = await generateKeys();
  await store.put(files.public, keys.publicKey);
  // Owner-only where the store has permissions; a hint elsewhere.
  await store.put(files.private, keys.privateKey, { mode: KEY_FILE_MODE });
  return { publicKey: keys.publicKey, privateKey: keys.privateKey };
};

module.exports = { loadKeyPair, KEY_FILES, SIGNING_FILES, KEY_FILE_MODE };
