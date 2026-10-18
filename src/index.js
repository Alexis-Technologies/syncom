'use strict';

// Smart contracts are deliberately not here: `@alexify/syncom/contracts` is
// the subpath, so a process that never imports it never runs a block's code.
const chain = require('./chain.js');
const crdt = require('./crdt.js');
const crypto = require('./crypto.js');
const fsi = require('./fsi.js');
const storage = require('./storage.js');
const sync = require('./sync.js');
const log = require('./log.js');
const { applyOp, mergeEntry, isAlive } = require('./ops.js');
const ops = { applyOp, mergeEntry, isAlive };
const { HookError } = require('./hooks.js');
const hooks = { HookError };
const { ValidationError } = require('./schema.js');
const schema = { ValidationError };

module.exports = {
  ...chain,
  ...crdt,
  ...crypto,
  ...fsi,
  ...storage,
  ...sync,
  ...log,
  ...ops,
  ...hooks,
  ...schema,
};
