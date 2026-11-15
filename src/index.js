'use strict';

// Smart contracts are deliberately not here: `@alexify/syncom/contracts` is
// the subpath, so a process that never imports it never runs a block's code.
// The exports are spelled out — required modules spread whole, the rest by
// name — never a spread of a local: that is the shape Node.js reads a
// CommonJS module's names from when ESM imports it (cjs-module-lexer), so
// `import { createDatabase } from '@alexify/syncom'` works outside a bundler too.
//
// `verifyAsync` is the engine's (src/signing/ed25519.js), not the API's: it is left
// out by name, and the root keeps one `verify`, synchronous in Node.js and a
// promise in the browser.
//
// The platform's backend: its five functions by name, and `defaultFsi`, the whole of it — node:fs with the three an
// adapter may add (`sync`, fsync, what `durable` calls; `create`, exclusive, what the lock prefers; `append`, what the
// journal prefers), so a backend built from it (a spy, `layered()`, `atRest()`) loses none. Not the three by name:
// `sync` is the replication plugin's name in `/all` and `/sync`.
const fsi = require('./fsi.js');

const { read, write, exists, remove, list } = fsi;
const defaultFsi = Object.freeze({ ...fsi });
const { isFsi } = require('./backend.js');
const { isEngine } = require('./engine.js');
const { filesEngine } = require('./files/files.js');
const { applyOp, mergeEntry, isAlive } = require('./ops.js');
const { HookError } = require('./hooks.js');
const { isSharedLog } = require('./sync/shared-log.js');
const { isSyncLink } = require('./sync/link.js');
const { OpLog } = require('./log.js');
const { outbound } = require('./sync/outbound.js');
const { compareVectors } = require('./vector.js');
const { SyncomError, ValidationError } = require('./errors.js');
const { createPlugins } = require('./plugin.js');

module.exports = {
  ...require('./crdt.js'),
  read,
  write,
  exists,
  remove,
  list,
  defaultFsi,
  isFsi,
  isEngine,
  filesEngine,
  ...require('./database.js'),
  OpLog,
  applyOp,
  mergeEntry,
  isAlive,
  HookError,
  ValidationError,
  isSharedLog,
  isSyncLink,
  outbound,
  compareVectors,
  SyncomError,
  createPlugins,
};
