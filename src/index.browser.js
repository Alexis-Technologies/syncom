'use strict';

// The browser twin of ./index.js: it names the browser variant of every split
// module directly. The requires NESTED inside chain.js / storage.js / sync.js
// / log.js (./fsi.js, ./crypto.js, ./utils.js) are redirected by
// package.json#browser, so a bundler that ignores that field would still pull
// the Node halves in.
const chain = require('./chain.js');
const contract = require('./contract.js');
const crdt = require('./crdt.js');
const crypto = require('./crypto.browser.js');
const fsi = require('./fsi.browser.js');
const storage = require('./storage.js');
const sync = require('./sync.js');
const log = require('./log.js');
const { applyOp, mergeEntry, isAlive } = require('./ops.js');
const ops = { applyOp, mergeEntry, isAlive };

module.exports = { ...chain, ...contract, ...crdt, ...crypto, ...fsi, ...storage, ...sync, ...log, ...ops };
