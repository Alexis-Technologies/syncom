'use strict';

// The Node.js half of the encryption plugin: an RSA pair on disk, and the
// hybrid envelope a sealed record is kept in — the record AES-256-GCM
// encrypted under a fresh random key, that key RSA-OAEP(SHA-256) wrapped
// with the storage's public key. RSA alone caps the payload at a couple of
// hundred bytes; this caps nothing. The same envelope as ./rsa.browser.js,
// so ciphertext is portable between the halves given the same pair.

const crypto = require('node:crypto');
const defaultFsi = require('../fsi.js');
const { loadKeyPair } = require('../crypto/keys.js');
const { SyncomError } = require('../errors.js');

const ALG = 'RSA-OAEP-256+A256GCM';
const OAEP = { padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' };

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
  if (envelope.v !== 1 || envelope.alg !== ALG) {
    throw new SyncomError('BAD_ENVELOPE', 'Unsupported ciphertext envelope');
  }
  const key = crypto.privateDecrypt({ key: privateKey, ...OAEP }, Buffer.from(envelope.key, 'base64'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  const plain = Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]);
  return JSON.parse(plain.toString());
};

const loadKeys = async (basePath, { fsi = defaultFsi } = {}) => loadKeyPair(basePath, fsi, generateKeys);

module.exports = { generateKeys, encrypt, decrypt, loadKeys };
