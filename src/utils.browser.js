'use strict';

// Browser twin of ./utils.js, wired in through package.json#browser. The
// filesystem predicates (fileExists / directoryExists) have no counterpart
// here: the browser storage layer goes through OPFS in ./fsi.browser.js.
const { Emitter } = require('./emitter.js');
const { createLogger } = require('./logger.js');

const generateUUID = () => crypto.randomUUID();

// No async context in the browser: a write from inside a transaction's function is not told apart
// from one made meanwhile (it waits for the queue the function holds — the documented caveat).
const taskScope = () => ({ run: (fn) => fn(), inside: () => false });

module.exports = { Emitter, createLogger, generateUUID, taskScope };
