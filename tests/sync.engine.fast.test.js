'use strict';

// The convergence properties with the write path as an application runs it:
// the deferred window on (`defer: 16`) and nothing signed (`sync: { signatures:
// false }`), so a local write is made at once (Storage#fastCommit, LOG-9) and
// keystrokes sent without waiting fold into one op (LOG-11). The other wrappers
// land files at once (`defer: 0`) and sign, which keeps both off. The same
// suite: the fast path changes nothing of what converges.

const test = require('node:test');
const assert = require('node:assert');
const core = require('../index.js');
const { text } = require('../src/text/text.js');
const { tree } = require('../src/tree/tree.js');
const { signing } = require('../src/signing/signing.js');
const { sync } = require('../src/sync/sync.js');
const { versions } = require('../src/versions/versions.js');
const { runSyncEngineTests } = require('./suites/sync-engine.js');
const { memory } = require('../src/memory/memory.js');

test('Sync engine (the fast path on: deferred files, nothing signed)', async (t) => {
  const fsi = memory();
  let n = 0;
  const paths = new Map();
  await runSyncEngineTests(t, assert, async (t2, name, options = {}) => {
    const key = `${t2.name}:${name}`;
    if (!paths.has(key)) paths.set(key, `fast-${n++}-${name}`);
    // The compaction test counts the segments its rolls seal — with the window on, a roll seals whatever landed
    // since the last flush as one segment, and retention keeps it whole; the window has tests of its own.
    const defer = t2.name.includes('history is compacted') ? 0 : 16;
    const storage = await core.open({
      defer,
      sync: { signatures: false },
      path: paths.get(key),
      fsi,
      logger: false,
      plugins: [text, tree, signing, sync, versions],
      ...options,
    });
    t2.after(() => storage.close().catch(() => {}));
    return storage;
  });
});
