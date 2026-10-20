'use strict';

const crypto = require('node:crypto');
const defaultFsi = require('./fsi.js');

const calculateHash = (data) => {
  const block = JSON.stringify(data);
  return crypto.createHash('sha256').update(block).digest('hex');
};

const generateKeys = () =>
  new Promise((resolve, reject) => {
    const format = 'pem';
    const options = {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format },
      privateKeyEncoding: { type: 'pkcs8', format },
    };
    crypto.generateKeyPair('rsa', options, (error, publicKey, privateKey) => {
      if (error) return void reject(error);
      resolve({ publicKey, privateKey });
    });
  });

// Hybrid envelope, the same on both halves so ciphertext is portable between
// them: the record is AES-256-GCM encrypted under a fresh random key, and
// that key is RSA-OAEP(SHA-256) wrapped with the storage's public key. RSA
// alone caps the payload at a couple of hundred bytes; this caps nothing.
const ALG = 'RSA-OAEP-256+A256GCM';
const OAEP = { padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' };

const encrypt = (data, publicKey) => {
  const key = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(data))), cipher.final()]);
  const tag = cipher.getAuthTag();
  const wrapped = crypto.publicEncrypt({ key: publicKey, ...OAEP }, key);
  return JSON.stringify({
    v: 1,
    alg: ALG,
    key: wrapped.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    data: body.toString('base64'),
  });
};

const decrypt = (text, privateKey) => {
  const envelope = JSON.parse(text);
  if (envelope.v !== 1 || envelope.alg !== ALG) throw new Error('Unsupported ciphertext envelope');
  const key = crypto.privateDecrypt({ key: privateKey, ...OAEP }, Buffer.from(envelope.key, 'base64'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  const plain = Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]);
  return JSON.parse(plain.toString());
};

// Half a pair is refused, not replaced: without private.pem every sealed
// record is already unreadable, without public.pem the next one would be,
// and a fresh pair would hide both behind records that decrypt to garbage.
const incomplete = (basePath, hasPublic) => {
  const missing = hasPublic ? 'private' : 'public';
  const error = new Error(`Key pair at ${basePath} is incomplete: ${missing}.pem is missing`);
  error.code = 'KEYS_INCOMPLETE';
  return error;
};

const loadKeys = async (basePath, { fsi = defaultFsi } = {}) => {
  let publicKey, privateKey;
  const hasPublic = await fsi.exists(basePath, 'public.pem');
  const hasPrivate = await fsi.exists(basePath, 'private.pem');
  if (hasPublic !== hasPrivate) throw incomplete(basePath, hasPublic);
  if (hasPublic) {
    publicKey = await fsi.read(basePath, 'public.pem');
    privateKey = await fsi.read(basePath, 'private.pem');
  } else {
    const keys = await generateKeys();
    await fsi.write(basePath, 'public.pem', keys.publicKey);
    // Owner-only where the backend has permissions; a hint elsewhere.
    await fsi.write(basePath, 'private.pem', keys.privateKey, { mode: 0o600 });
    publicKey = keys.publicKey;
    privateKey = keys.privateKey;
  }
  return { publicKey, privateKey };
};

module.exports = { calculateHash, generateKeys, encrypt, decrypt, loadKeys };
