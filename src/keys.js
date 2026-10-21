'use strict';

// The key pair on disk, shared by both crypto halves: `public.pem` and
// `private.pem` under `basePath`, read when both are there, made when
// neither is, refused when one is. No requires: the generator and the
// backend are handed in.

const incomplete = (basePath, hasPublic) => {
  const missing = hasPublic ? 'private' : 'public';
  const error = new Error(`Key pair at ${basePath} is incomplete: ${missing}.pem is missing`);
  error.code = 'KEYS_INCOMPLETE';
  return error;
};

// Half a pair is refused, not replaced: without private.pem every sealed
// record is already unreadable, without public.pem the next one would be,
// and a fresh pair would hide both behind records that decrypt to garbage.
const loadKeyPair = async (basePath, fsi, generateKeys) => {
  const hasPublic = await fsi.exists(basePath, 'public.pem');
  const hasPrivate = await fsi.exists(basePath, 'private.pem');
  if (hasPublic !== hasPrivate) throw incomplete(basePath, hasPublic);
  if (hasPublic) {
    return { publicKey: await fsi.read(basePath, 'public.pem'), privateKey: await fsi.read(basePath, 'private.pem') };
  }
  const keys = await generateKeys();
  await fsi.write(basePath, 'public.pem', keys.publicKey);
  // Owner-only where the backend has permissions; a hint elsewhere.
  await fsi.write(basePath, 'private.pem', keys.privateKey, { mode: 0o600 });
  return { publicKey: keys.publicKey, privateKey: keys.privateKey };
};

module.exports = { loadKeyPair };
