'use strict';

// Smart contracts are deliberately not here: `@alexify/syncom/contracts` is
// the subpath, so a process that never imports it never runs a block's code.
const chain = require('./chain.js');
const crdt = require('./crdt.js');
const crypto = require('./crypto.js');
const { read, write, exists, remove, list } = require('./fsi.js');
const fsi = { read, write, exists, remove, list };
const { isFsi, createMemoryFsi } = require('./backend.js');
const backend = { isFsi, createMemoryFsi };
const storage = require('./storage.js');
const sync = require('./sync.js');
const log = require('./log.js');
const { applyOp, mergeEntry, isAlive } = require('./ops.js');
const ops = { applyOp, mergeEntry, isAlive };
const { HookError } = require('./hooks.js');
const hooks = { HookError };
const { ValidationError } = require('./schema.js');
const schema = { ValidationError };
const { isSharedLog } = require('./shared-log.js');
const sharedLog = { isSharedLog };
const { SyncomError } = require('./errors.js');
const errors = { SyncomError };

module.exports = {
  ...chain,
  ...crdt,
  ...crypto,
  ...fsi,
  ...backend,
  ...storage,
  ...sync,
  ...log,
  ...ops,
  ...hooks,
  ...schema,
  ...sharedLog,
  ...errors,
};
