/**
 * History: the past read out of the log — `history()` over a record with
 * two thousand ops, a version a thousand ops back, and the diff against it
 * — over the memory backend. The fold is the whole record's; `limit` bounds
 * what is handed out, not what is folded.
 *
 * Run with `node bench/history.js` or `pnpm bench`.
 */

'use strict';

const { bench } = require('./support/harness.js');
const { createMemoryFsi } = require('../src/backend.js');
const { open } = require('../src/storage.js');

const main = async () => {
  console.log(`History benchmark — Node ${process.version}\n`);
  const storage = await open({ path: '/bench', fsi: createMemoryFsi(), logger: false });
  const id = await storage.insert({ n: 0, title: 'a' });
  for (let i = 1; i <= 2000; i++) await storage.update(id, { n: i });
  await storage.splice(id, 'body', 0, 0, 'hello world');
  const all = await storage.history(id, { limit: Infinity });
  const back = all.versions[1000].eventId;
  await bench('history(id, { limit: 50 }) — a record with 2 000 ops', () => storage.history(id, { limit: 50 }));
  await bench('history(id, { limit: Infinity }) — every version materialized', () =>
    storage.history(id, { limit: Infinity }));
  await bench('get(id, { at: eventId }) — 1 000 ops back', () => storage.get(id, { at: back }));
  await bench('get(id, { at: { vector } }) — the present, folded', () =>
    storage.get(id, { at: { vector: storage.vector } }));
  await bench('diff(id, at) — against 1 000 ops back', () => storage.diff(id, back));
  await storage.close();
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
