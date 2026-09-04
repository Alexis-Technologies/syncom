'use strict';

const chain = require('./src/chain.js');
const crypto = require('./src/crypto.js');
const crdt = require('./src/crdt.js');
const contract = require('./src/contract.js');
const storage = require('./src/storage.js');

module.exports = { ...chain, ...contract, ...crdt, ...crypto, ...storage };
