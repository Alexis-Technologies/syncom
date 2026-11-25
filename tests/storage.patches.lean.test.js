'use strict';

// The Patches suite over the lean core with the plugins given by hand —
// `versions` first, then what the suite's records and peers need (text,
// tree, sync, encryption, chain, schema, query; no signing: the node ids are
// UUIDs).

const { describe } = require('node:test');
const assert = require('node:assert/strict');
const core = require('../index.js');
const { memory } = require('../src/memory/memory.js');
const { versions } = require('../src/versions/versions.js');
const { text } = require('../src/text/text.js');
const { tree } = require('../src/tree/tree.js');
const { sync } = require('../src/sync/sync.js');
const { encryption } = require('../src/encryption/encryption.js');
const { chain } = require('../src/chain/chain.js');
const { schema } = require('../src/schema/schema.js');
const { query } = require('../src/query/query.js');
const { runPatchTests } = require('./suites/patches.js');

describe('Patches (lean core, plugins by hand)', () => {
  // A Map in memory, no I/O: made as the suite is declared, shared by its tests (each under a path of its own).
  const fsi = memory();
  let n = 0;
  const paths = new Map();
  runPatchTests(assert, async (t2, name, options = {}) => {
    const key = `${t2.name}:${name}`;
    if (!paths.has(key)) paths.set(key, `patches-${n++}-${name}`);
    const plugins = [versions, text, tree, sync, encryption, chain, schema, query];
    const storage = await core.createDatabase({ path: paths.get(key), fsi, logger: false, plugins, ...options });
    t2.after(() => storage.close().catch(() => {}));
    return storage;
  });
});
