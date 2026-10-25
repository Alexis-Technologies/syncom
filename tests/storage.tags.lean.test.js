'use strict';

// Files land at once here (`defer: 0`): what these tests read of the disk is the engine's, not the window's — the window has tests of its own (storage.defer, storage.group).

// The Tags suite over the lean core with the plugins given by hand —
// `versions` first, then what the suite's records and peers need (text,
// tree, sync, encryption, chain, schema, query; no signing: the node ids are
// UUIDs).

const test = require('node:test');
const assert = require('node:assert');
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
const { runTagTests } = require('./suites/tags.js');

test('Tags (lean core, plugins by hand)', async (t) => {
  const fsi = memory();
  let n = 0;
  const paths = new Map();
  await runTagTests(t, assert, async (t2, name, options = {}) => {
    const key = `${t2.name}:${name}`;
    if (!paths.has(key)) paths.set(key, `tags-${n++}-${name}`);
    const plugins = [versions, text, tree, sync, encryption, chain, schema, query];
    const storage = await core.open({ defer: 0, path: paths.get(key), fsi, logger: false, plugins, ...options });
    t2.after(() => storage.close().catch(() => {}));
    return storage;
  });
});
