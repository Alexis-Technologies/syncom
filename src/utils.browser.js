'use strict';

// Browser twin of ./utils.js, wired in through package.json#browser. The
// filesystem predicates (fileExists / directoryExists) have no counterpart
// here: the browser storage layer goes through OPFS in ./fsi.browser.js.
const { Emitter } = require('./emitter.js');
const { createLogger } = require('./logger.js');

const generateUUID = () => crypto.randomUUID();

module.exports = { Emitter, createLogger, generateUUID };
