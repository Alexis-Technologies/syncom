'use strict';

// The browser twin of ./index.js: it names the browser variant of every split
// module directly. The requires NESTED inside chain.js / storage.js / sync.js
// / log.js (./fsi.js, ./crypto.js, ./utils.js) are redirected by
// package.json#browser, so a bundler that ignores that field would still pull
// the Node halves in.
// The exports are spelled out — required modules spread whole, the rest by
// name — never a spread of a local: that is the shape Node.js reads a
// CommonJS module's names from when ESM imports it (cjs-module-lexer), so
// `import { open } from '@alexify/syncom'` works outside a bundler too.
//
// `verifyAsync` is the engine's (src/signing.js), not the API's: it is left
// out by name, and the root keeps one `verify`, synchronous in Node.js and a
// promise in the browser.
const {
  calculateHash,
  generateKeys,
  encrypt,
  decrypt,
  loadKeys,
  generateSigningKeys,
  loadSigningKeys,
  sign,
  verify,
} = require('./crypto.browser.js');
const { read, write, exists, remove, list } = require('./fsi.browser.js');
const { isFsi, createMemoryFsi } = require('./backend.js');
const { applyOp, mergeEntry, isAlive } = require('./ops.js');
const { HookError } = require('./hooks.js');
const { ValidationError } = require('./schema.js');
const { isSharedLog } = require('./shared-log.js');
const { SyncomError } = require('./errors.js');
const { createPlugins } = require('./plugin.js');

module.exports = {
  ...require('./chain.js'),
  ...require('./crdt.js'),
  calculateHash,
  generateKeys,
  encrypt,
  decrypt,
  loadKeys,
  generateSigningKeys,
  loadSigningKeys,
  sign,
  verify,
  read,
  write,
  exists,
  remove,
  list,
  isFsi,
  createMemoryFsi,
  ...require('./storage.js'),
  ...require('./sync.js'),
  ...require('./log.js'),
  applyOp,
  mergeEntry,
  isAlive,
  HookError,
  ValidationError,
  isSharedLog,
  SyncomError,
  createPlugins,
};
