'use strict';

// What the storage lends its write paths and its plugins' methods (`core`,
// Storage#lend): every member named here, the object frozen. A member added
// or taken away changes this list on purpose — the core is a seam, and a
// seam that grows unnoticed is how it reached fifty-odd members.

const test = require('node:test');
const assert = require('node:assert');
const { open } = require('../../src/index.js');
const { memory } = require('../../src/memory/memory.js');

const MEMBERS = [
  'actorOf',
  'ahead',
  'alive',
  'catalog',
  'chain',
  'clock',
  'commit',
  'commitNow',
  'conflicts',
  'current',
  'cursor',
  'defer',
  'deferred',
  'definitionOf',
  'drain',
  'emit',
  'entities',
  'entries',
  'fingerprintOf',
  'flushDeferred',
  'forget',
  'hash',
  'hook',
  'hooks',
  'inflight',
  'invalid',
  'land',
  'landing',
  'limits',
  'listening',
  'log',
  'logger',
  'maxSkew',
  'nodeId',
  'observe',
  'otel',
  'persist',
  'pipelined',
  'plugins',
  'refresh',
  'run',
  'saveCatalog',
  'scopeOf',
  'scoped',
  'scrub',
  'seal',
  'seqOf',
  'settled',
  'sign',
  'signatures',
  'tags',
  'transact',
  'unpersisted',
  'verify',
  'version',
  'view',
];

test('the core a storage lends is frozen and has the members this list names, no more', async (t) => {
  let lent = null;
  const spy = { name: 'spy', setup: () => ({}), methods: { peek: async (core) => void (lent = core) } };
  const storage = await open({ fsi: memory(), lock: false, logger: false, plugins: [spy] });
  t.after(() => storage.close());
  await storage.peek();
  assert.ok(Object.isFrozen(lent));
  assert.deepStrictEqual(Object.keys(lent).sort(), MEMBERS);
});
