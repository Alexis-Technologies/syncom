'use strict';

// The key pairs on disk, shared by both crypto halves: `public.pem` and
// `private.pem` — the RSA pair that seals records — and `sign-public.pem`
// and `sign-private.pem` — the Ed25519 pair that signs ops and whose public
// key is the node id — under `basePath`. A pair is read when both halves are
// there, made when neither is, refused when one is. No requires beyond
// ./errors.js: the generator and the backend are handed in.

const { SyncomError } = require('./errors.js');

const KEY_FILES = { public: 'public.pem', private: 'private.pem' };
const SIGNING_FILES = { public: 'sign-public.pem', private: 'sign-private.pem' };

const incomplete = (basePath, hasPublic, files) => {
  const missing = hasPublic ? files.private : files.public;
  return new SyncomError('KEYS_INCOMPLETE', `Key pair at ${basePath} is incomplete: ${missing} is missing`);
};

// Half a pair is refused, not replaced: without private.pem every sealed
// record is already unreadable, without public.pem the next one would be,
// and a fresh pair would hide both behind records that decrypt to garbage.
// The signing pair the same: without its private half the node cannot sign
// as itself, and a fresh pair would be another node to every peer.
const loadKeyPair = async (basePath, fsi, generateKeys, files = KEY_FILES) => {
  const hasPublic = await fsi.exists(basePath, files.public);
  const hasPrivate = await fsi.exists(basePath, files.private);
  if (hasPublic !== hasPrivate) throw incomplete(basePath, hasPublic, files);
  if (hasPublic) {
    return { publicKey: await fsi.read(basePath, files.public), privateKey: await fsi.read(basePath, files.private) };
  }
  const keys = await generateKeys();
  await fsi.write(basePath, files.public, keys.publicKey);
  // Owner-only where the backend has permissions; a hint elsewhere.
  await fsi.write(basePath, files.private, keys.privateKey, { mode: 0o600 });
  return { publicKey: keys.publicKey, privateKey: keys.privateKey };
};

module.exports = { loadKeyPair, KEY_FILES, SIGNING_FILES };
