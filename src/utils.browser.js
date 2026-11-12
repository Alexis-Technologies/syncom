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

// The storage estimate and the persistence request of the Storage API, where the browser has them.
const estimateStorage = async () => {
  const storage = globalThis.navigator?.storage;
  if (!storage || typeof storage.estimate !== 'function') return { usage: null, quota: null };
  const estimate = await storage.estimate();
  return { usage: estimate?.usage ?? null, quota: estimate?.quota ?? null };
};
const persistStorage = async () => {
  const storage = globalThis.navigator?.storage;
  if (!storage || typeof storage.persist !== 'function') return false;
  return (await storage.persist()) === true;
};

module.exports = { Emitter, createLogger, generateUUID, taskScope, estimateStorage, persistStorage };
