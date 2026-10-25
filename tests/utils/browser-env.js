'use strict';

// Runs the SHARED modules (storage.js, chain.js, ...) the way a bundler that
// honours package.json#browser would: every `./src/x.js` the map redirects is
// primed in require.cache with its `x.browser.js` twin BEFORE the shared
// module is loaded, so its nested requires resolve to the browser halves.
// Requiring `src/index.browser.js` alone does not do that under Node — it
// names the browser variants directly, but storage.js still says
// `require('./crypto.js')`, which Node resolves literally.
//
// Use this from a test file that never loads the node barrel: the cache
// priming is process-wide, and `node --test` gives every file its own process.

const path = require('node:path');
const Module = require('node:module');
const { webcrypto } = require('node:crypto');
const { installMockOpfs } = require('./mock-opfs.js');

const ROOT = path.join(__dirname, '..', '..');
const pkg = require('../../package.json');

const installBrowserGlobals = () => {
  const opfs = installMockOpfs();
  const prevCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  Object.defineProperty(globalThis, 'crypto', {
    value: webcrypto,
    configurable: true,
    writable: true,
    enumerable: true,
  });
  if (typeof globalThis.btoa !== 'function') {
    globalThis.btoa = (s) => Buffer.from(s, 'latin1').toString('base64');
  }
  if (typeof globalThis.atob !== 'function') {
    globalThis.atob = (s) => Buffer.from(s, 'base64').toString('latin1');
  }
  const uninstall = () => {
    opfs.uninstall();
    if (prevCrypto) Object.defineProperty(globalThis, 'crypto', prevCrypto);
    else delete globalThis.crypto;
  };
  return { opfs, uninstall };
};

// Primes the cache from the package.json#browser map, then returns the
// browser barrel — the same module graph a browser bundle contains.
const requireBrowserBarrel = () => {
  for (const [from, to] of Object.entries(pkg.browser)) {
    // Only the split leaves are primed; the barrel itself is required LAST,
    // once every twin is in place — requiring it first would load the whole
    // graph with the node halves before the loop reached them.
    if (!from.startsWith('./src/') || from === './src/index.js') continue;
    const nodePath = path.join(ROOT, from);
    if (require.cache[nodePath]) continue;
    const twin = new Module(nodePath, module);
    twin.filename = nodePath;
    twin.paths = Module._nodeModulePaths(path.dirname(nodePath));
    twin.exports = require(path.join(ROOT, to));
    twin.loaded = true;
    require.cache[nodePath] = twin;
  }
  return require('../../src/index.browser.js');
};

// The same graph with every shipped plugin registered (src/all/all.js): the
// barrel it requires is primed with the browser one first.
const requireBrowserAll = () => {
  const browser = requireBrowserBarrel();
  const nodePath = path.join(ROOT, 'src', 'index.js');
  if (!require.cache[nodePath]) {
    const twin = new Module(nodePath, module);
    twin.filename = nodePath;
    twin.paths = Module._nodeModulePaths(path.dirname(nodePath));
    twin.exports = browser;
    twin.loaded = true;
    require.cache[nodePath] = twin;
  }
  return require('../../src/all/all.js');
};

// A Web Locks API on the mock navigator: exclusive, by name, with the
// `ifAvailable` answer of `null` — what src/lock.js reads of the real one.
const installMockLocks = () => {
  const held = new Map();
  const request = async (name, options, callback) => {
    if (typeof options === 'function') [options, callback] = [{}, options];
    while (held.has(name)) {
      if (options.ifAvailable) return callback(null);
      await held.get(name);
    }
    let release = null;
    held.set(name, new Promise((resolve) => (release = resolve)));
    try {
      return await callback({ name, mode: 'exclusive' });
    } finally {
      held.delete(name);
      release();
    }
  };
  globalThis.navigator.locks = { request, held: () => [...held.keys()] };
  // What tells src/lock.js it is in a browser (Node has navigator.locks too).
  const hadSelf = Object.hasOwn(globalThis, 'self');
  if (!hadSelf) globalThis.self = globalThis;
  return {
    uninstall: () => {
      delete globalThis.navigator.locks;
      if (!hadSelf) delete globalThis.self;
    },
  };
};

module.exports = { installBrowserGlobals, requireBrowserBarrel, requireBrowserAll, installMockLocks };
