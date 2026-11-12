'use strict';

const fsp = require('node:fs/promises');
const crypto = require('node:crypto');

const { AsyncLocalStorage } = require('node:async_hooks');
const { Emitter } = require('./emitter.js');
const { createLogger } = require('./logger.js');

// A task's async context: `run(fn)` runs `fn` inside it, `inside()` says
// whether the caller is — what tells a write made from inside a transaction's
// function (which would wait for the queue the function holds) from one
// made meanwhile by anyone else. The context follows every timer and promise
// the function makes, so it carries a frame that is active only while the
// function runs: a write scheduled inside and made after it is not inside.
// Node's AsyncLocalStorage; the browser half has none and answers false.
const taskScope = () => {
  const store = new AsyncLocalStorage();
  const run = async (fn, frame) => {
    try {
      return await fn();
    } finally {
      frame.active = false;
    }
  };
  return {
    run: (fn) => {
      const frame = { active: true };
      return store.run(frame, () => run(fn, frame));
    },
    inside: () => store.getStore()?.active === true,
  };
};

const generateUUID = crypto.randomUUID;

const fileExists = async (path) => {
  const stats = await fsp.stat(path).catch(() => null);
  if (!stats) return false;
  return !stats.isDirectory();
};

const directoryExists = async (path) => {
  const stats = await fsp.stat(path).catch(() => null);
  if (!stats) return false;
  return stats.isDirectory();
};

// How much room the medium under `path` has: Node asks the file system (`statfs`; the directory, else the
// working directory, else nothing); what this database itself holds the file system does not say (`usage` null).
const estimateStorage = async (path) => {
  for (const at of [path, process.cwd()]) {
    try {
      const stats = await fsp.statfs(at);
      return { usage: null, quota: Number(stats.bavail) * Number(stats.bsize) };
    } catch {
      // Not a directory here: the next.
    }
  }
  return { usage: null, quota: null };
};
// Nothing to ask of a file system: what is written stays.
const persistStorage = async () => true;

module.exports = {
  Emitter,
  createLogger,
  generateUUID,
  taskScope,
  fileExists,
  directoryExists,
  estimateStorage,
  persistStorage,
};
