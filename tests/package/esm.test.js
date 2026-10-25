'use strict';

// The package is CommonJS; Node.js hands an ESM importer the names it can
// read off each entry without running it (cjs-module-lexer). Every entry must
// spell its exports in a shape that lexer reads, or `import { open } from
// '@alexify/syncom'` throws outside a bundler.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const ENTRIES = [
  'index.js',
  'src/wrpc/wrpc.js',
  'src/search/search.js',
  'src/order/order.js',
  'src/undo/undo.js',
  'src/branch/branch.js',
  'src/presence/presence.js',
  'src/contracts/contracts.js',
  'src/idb/idb.js',
  'src/all/all.js',
  'src/text/text.js',
  'src/tree/tree.js',
  'src/signing/signing.js',
  'src/chain/chain.js',
  'src/encryption/encryption.js',
  'src/memory/memory.js',
  'src/layered/layered.js',
  'src/sync/sync.js',
  'src/schema/schema.js',
  'src/telemetry/telemetry.js',
  'src/query/query.js',
  'src/versions/versions.js',
];

for (const entry of ENTRIES) {
  test(`ESM sees every export of ${entry}`, async () => {
    const file = path.join(ROOT, entry);
    const required = require(file);
    const imported = await import(file);
    const named = Object.keys(imported).filter((name) => name !== 'default' && name !== 'module.exports');
    assert.deepStrictEqual(named.sort(), Object.keys(required).sort());
    for (const name of named) assert.strictEqual(imported[name], required[name], name);
  });
}

test('the root keeps verifyAsync to the engine', () => {
  assert.strictEqual(require(path.join(ROOT, 'index.js')).verifyAsync, undefined);
});
