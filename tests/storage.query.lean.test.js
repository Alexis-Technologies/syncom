'use strict';

// The query suite over the lean core with the plugins given by hand —
// `query` first, then what the suite's records and peers need (schema,
// text, tree, sync, encryption; no signing: the node ids are UUIDs).

const test = require('node:test');
const assert = require('node:assert');
const core = require('../index.js');
const { memory } = require('../src/memory/memory.js');
const { query } = require('../src/query/query.js');
const { schema } = require('../src/schema/schema.js');
const { text } = require('../src/text/text.js');
const { tree } = require('../src/tree/tree.js');
const { sync } = require('../src/sync/sync.js');
const { encryption } = require('../src/encryption/encryption.js');
const { runQueryTests } = require('./suites/query.js');

test('Queries (lean core, plugins by hand)', async (t) => {
  const fsi = memory();
  let n = 0;
  const paths = new Map();
  await runQueryTests(t, assert, async (t2, name, options = {}) => {
    const key = `${t2.name}:${name}`;
    if (!paths.has(key)) paths.set(key, `query-${n++}-${name}`);
    const plugins = [query, schema, text, tree, sync, encryption];
    const storage = await core.open({ path: paths.get(key), fsi, logger: false, plugins, ...options });
    t2.after(() => storage.close().catch(() => {}));
    return storage;
  });
});
