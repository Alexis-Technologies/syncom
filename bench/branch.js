/**
 * Branches — what a fork costs (the parent's snapshot paged into a new
 * storage, a new key pair with it) and what a merge back costs per op
 * (the ops the other side lacks, through applyRemote in pages).
 *
 * Run with `node bench/branch.js` or `pnpm bench branch`.
 */

'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { bench } = require('./support/harness.js');
const { open } = require('../src/storage.js');
const { branch, merge, drop } = require('../src/branch/branch.js');

const RECORDS = 200;

const main = async () => {
  console.log(`Branch benchmark — Node ${process.version}\n`);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'syncom-bench-branch-'));
  try {
    const parent = await open({ path: path.join(root, 'parent'), lock: false });
    for (let i = 0; i < RECORDS; i++) await parent.insert({ n: i, title: `record ${i}` });
    let forks = 0;
    await bench(
      `branch — fork at the present (${RECORDS} records)`,
      async () => {
        const child = await branch(parent, { path: path.join(root, `fork-${forks++}`), lock: false });
        await drop(child);
      },
      { warmup: 2, measureMs: 1000 },
    );
    const child = await branch(parent, { path: path.join(root, 'child'), lock: false });
    const ids = await child.list();
    let n = 0;
    await bench(
      'merge — 20 ops from the branch into the parent',
      async () => {
        for (let i = 0; i < 20; i++) await child.update(ids[i % ids.length], { n: n++ });
        await merge(child, { into: parent });
      },
      { warmup: 3, measureMs: 1000 },
    );
    await bench('merge — nothing to hand over', () => merge(child, { into: parent }), { warmup: 5 });
    await drop(child);
    await parent.close();
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
