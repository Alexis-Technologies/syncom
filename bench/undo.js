/**
 * Undo — what capturing a commit costs a write (the inverse patches, as
 * copies), and what an undo and a redo of one step cost: the patches
 * realized as ops through the usual write path. The record carries a
 * register, a counter, a set and a short text, so every kind of inverse is
 * in the step.
 *
 * Run with `node bench/undo.js` or `pnpm bench undo`.
 */

'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { bench } = require('./support/harness.js');
const { open } = require('../src/all/all.js');
const { createUndo } = require('../src/undo/undo.js');

const main = async () => {
  console.log(`Undo benchmark — Node ${process.version}\n`);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'syncom-bench-undo-'));
  try {
    const storage = await open({ path: root, lock: false });
    const id = await storage.insert({ title: 'a', n: 0 });
    await storage.inc(id, 'hits', 1);
    await storage.add(id, 'tags', ['x']);
    await storage.splice(id, 'body', 0, 0, 'hello world');
    let n = 0;
    await bench('update — no undo manager', () => storage.update(id, { n: n++ }), { warmup: 20 });
    const undo = createUndo(storage, { mergeInterval: 0, limit: 1000 });
    await bench('update — captured by the undo manager', () => storage.update(id, { n: n++ }), { warmup: 20 });
    undo.clear();
    await bench(
      'undo + redo — one step of four kinds',
      async () => {
        await storage.update(id, { n: n++ });
        await storage.inc(id, 'hits', 1);
        await storage.add(id, 'tags', [`t${n}`]);
        await storage.splice(id, 'body', 0, 1, 'H');
        await undo.undo();
        await undo.redo();
        undo.clear();
      },
      { warmup: 10, measureMs: 500 },
    );
    undo.stop();
    await storage.close();
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
