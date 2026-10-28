'use strict';

// The schema suite over the lean core with the plugins given by hand —
// `schema` first, then what the suite's records and peers need (text, tree,
// sync, chain, encryption; no signing: the node ids are UUIDs) — the way an
// application that picks its blocks opens a storage.

const test = require('node:test');
const assert = require('node:assert');
const core = require('../index.js');
const { memory } = require('../src/memory/memory.js');
const { schema } = require('../src/schema/schema.js');
const { text } = require('../src/text/text.js');
const { tree } = require('../src/tree/tree.js');
const { sync } = require('../src/sync/sync.js');
const { chain } = require('../src/chain/chain.js');
const { encryption } = require('../src/encryption/encryption.js');
const { runSchemaTests } = require('./suites/schema.js');

test('Schema (lean core, plugins by hand)', async (t) => {
  const fsi = memory();
  let n = 0;
  const paths = new Map();
  await runSchemaTests(t, assert, async (t2, name, options = {}) => {
    const key = `${t2.name}:${name}`;
    if (!paths.has(key)) paths.set(key, `schema-${n++}-${name}`);
    const plugins = [schema, text, tree, sync, chain, encryption];
    const storage = await core.open({ path: paths.get(key), fsi, logger: false, plugins, ...options });
    t2.after(() => storage.close().catch(() => {}));
    return storage;
  });
});
