'use strict';

// Smart contracts are deliberately not here: `@alexify/syncom/contracts` is
// the subpath, so a process that never imports it never runs a block's code.
// The exports are spelled out — required modules spread whole, the rest by
// name — never a spread of a local: that is the shape Node.js reads a
// CommonJS module's names from when ESM imports it (cjs-module-lexer), so
// `import { open } from '@alexify/syncom'` works outside a bundler too.
//
// `verifyAsync` is the engine's (src/signing/ed25519.js), not the API's: it is left
// out by name, and the root keeps one `verify`, synchronous in Node.js and a
// promise in the browser.
const { read, write, exists, remove, list } = require('./fsi.js');
const { isFsi } = require('./backend.js');
const { applyOp, mergeEntry, isAlive } = require('./ops.js');
const { HookError } = require('./hooks.js');
const { isSharedLog } = require('./shared-log.js');
const { isSyncLink } = require('./link.js');
const { outbound } = require('./outbound.js');
const { SyncomError, ValidationError } = require('./errors.js');
const { createPlugins } = require('./plugin.js');

module.exports = {
  ...require('./crdt.js'),
  read,
  write,
  exists,
  remove,
  list,
  isFsi,
  ...require('./storage.js'),
  ...require('./log.js'),
  applyOp,
  mergeEntry,
  isAlive,
  HookError,
  ValidationError,
  isSharedLog,
  isSyncLink,
  outbound,
  SyncomError,
  createPlugins,
};
