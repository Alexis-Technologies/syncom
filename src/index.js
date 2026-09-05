'use strict';

const chain = require('./chain.js');
const contract = require('./contract.js');
const crdt = require('./crdt.js');
const crypto = require('./crypto.js');
const fsi = require('./fsi.js');
const storage = require('./storage.js');
const sync = require('./sync.js');
const log = require('./log.js');
const { applyOp, mergeEntry, isAlive } = require('./ops.js');
const ops = { applyOp, mergeEntry, isAlive };

module.exports = { ...chain, ...contract, ...crdt, ...crypto, ...fsi, ...storage, ...sync, ...log, ...ops };
