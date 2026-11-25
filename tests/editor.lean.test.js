'use strict';

// Files land at once here (`defer: 0`): what these tests read of the disk is the engine's, not the window's — the window has tests of its own (storage.defer, storage.group).

// The editor binding over the lean core with the plugins it needs given by
// hand — the text kind and the sync plugin (the suite's two-node cases dial
// through a mesh) — and nothing else: no signing, no versions, no schema.

const { describe } = require('node:test');
const assert = require('node:assert/strict');
const core = require('../index.js');
const { memory } = require('../src/memory/memory.js');
const { text } = require('../src/text/text.js');
const { sync } = require('../src/sync/sync.js');
const { runEditorTests } = require('./suites/editor.js');

describe('Editor binding (lean core, plugins by hand)', () => {
  const fsi = memory();
  let n = 0;
  const paths = new Map();
  runEditorTests(assert, async (t2, name, options = {}) => {
    const key = `${t2.name}:${name}`;
    if (!paths.has(key)) paths.set(key, `editor-${n++}-${name}`);
    const storage = await core.createDatabase({
      defer: 0,
      path: paths.get(key),
      fsi,
      logger: false,
      plugins: [text, sync],
      ...options,
    });
    t2.after(() => storage.close().catch(() => {}));
    return storage;
  });
});
