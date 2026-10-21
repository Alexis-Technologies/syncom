'use strict';

/**
 * One cold start of one library, in a fresh process: load the library, open
 * a store of SEED records on disk that bench/compare.js prepared, read one
 * record. What a command-line tool, a serverless function or a page that
 * reloads pays once. Prints `{ open, firstRead, total }` in milliseconds;
 * `open` includes loading the library, which every adapter does on first use.
 *
 * Usage (spawned by bench/compare.js):
 *   node bench/compare/coldstart-worker.js prepare <adapter> <dir>   → { id }
 *   node bench/compare/coldstart-worker.js measure <adapter> <dir> <id>
 */

const { performance } = require('node:perf_hooks');
const fs = require('node:fs');
const path = require('node:path');

const main = async () => {
  const [mode, adapterId, dir, id] = process.argv.slice(2);
  const start = performance.now();
  const { getAdapter } = require('./adapters/index.js');
  const { SEED, recordOf } = require('./scenarios.js');
  const line = getAdapter(adapterId).lines.disk;
  const at = path.join(dir, 'store');
  if (mode === 'prepare') {
    fs.mkdirSync(dir, { recursive: true });
    const store = await line.open(at);
    const records = [];
    for (let i = 0; i < SEED; i++) records.push(recordOf(i));
    const ids = await store.bulk(records);
    await store.close();
    return { id: ids[SEED >> 1] };
  }
  const store = await line.open(at);
  const opened = performance.now();
  const record = await store.get(id);
  const read = performance.now();
  if (!record || record.title !== recordOf(SEED >> 1).title) {
    throw new Error(`${adapterId}: the record did not read back after a cold open (${JSON.stringify(record)})`);
  }
  await store.close();
  return { open: opened - start, firstRead: read - opened, total: read - start };
};

main().then(
  (result) => {
    // To the file bench/compare.js names; stdout belongs to the libraries.
    const text = `${JSON.stringify(result)}\n`;
    if (process.env.SYNCOM_COMPARE_OUT) fs.writeFileSync(process.env.SYNCOM_COMPARE_OUT, text);
    else process.stdout.write(text);
    process.exit(0);
  },
  (error) => {
    process.stderr.write(`${error?.stack ?? error}\n`);
    process.exit(1);
  },
);
