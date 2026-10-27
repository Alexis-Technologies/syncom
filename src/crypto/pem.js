'use strict';

// Base64 and PEM for the browser crypto halves: the bytes of a key as the
// standard 64-column PEM node:crypto parses, and back; base64url for a
// signature and a node id. `btoa`/`atob` are globals in browsers and in
// Node.js alike. No requires.

const PUBLIC_KEY_HEADER = '-----BEGIN PUBLIC KEY-----';
const PUBLIC_KEY_FOOTER = '-----END PUBLIC KEY-----';
const PRIVATE_KEY_HEADER = '-----BEGIN PRIVATE KEY-----';
const PRIVATE_KEY_FOOTER = '-----END PRIVATE KEY-----';
const PADDING = /=+$/;

const toBase64 = (buffer) => {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
};

const toBase64Url = (buffer) => toBase64(buffer).replaceAll('+', '-').replaceAll('/', '_').replace(PADDING, '');

// Accepts standard AND url-safe base64: keys written by an earlier version
// of this package were url-safe, and node's PEMs are standard.
const fromBase64 = (base64) => {
  const normalized = base64.replaceAll('-', '+').replaceAll('_', '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
};

// Standard PEM: 64-character base64 lines, which is what node:crypto parses.
const toPem = (buffer, header, footer) => {
  const lines = toBase64(buffer).match(/.{1,64}/g) ?? [];
  return [header, ...lines, footer].join('\n');
};

const cleanPem = (pem, header, footer) => pem.replace(header, '').replace(footer, '').replaceAll(/\s/g, '');

module.exports = {
  PUBLIC_KEY_HEADER,
  PUBLIC_KEY_FOOTER,
  PRIVATE_KEY_HEADER,
  PRIVATE_KEY_FOOTER,
  toBase64,
  toBase64Url,
  fromBase64,
  toPem,
  cleanPem,
};
