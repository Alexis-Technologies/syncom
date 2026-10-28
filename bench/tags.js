/**
 * Tags: a tag taken over a thousand records (the catalog copied under the
 * log position), writes under a tag (the first one of a record copies its
 * file, the rest write as usual), a read at the tag, and a tag dropped —
 * over the memory backend.
 *
 * Run with `node bench/tags.js` or `pnpm bench`.
 */

'use strict';

const { bench } = require('./support/harness.js');
const { memory } = require('../src/memory/memory.js');
const { open } = require('../src/all/all.js');

const main = async () => {
  console.log(`Tags benchmark — Node ${process.version}\n`);
  const storage = await open({ path: '/bench', fsi: memory(), logger: false });
  const ids = [];
  for (let i = 0; i < 1000; i++) ids.push(await storage.insert({ n: i, group: i % 10 }));
  let k = 0;
  await bench('tag() + untag() — over 1 000 records (memory fsi)', async () => {
    await storage.tag(`t${k}`);
    await storage.untag(`t${k++}`);
  });
  await storage.tag('cow');
  let j = 0;
  await bench('update — under a tag; the first write of a record copies its file', () =>
    storage.update(ids[j++ % ids.length], { n: j }));
  await bench('at(tag).get — a record copied at the tag', () => storage.at('cow').get(ids[j++ % ids.length]));
  await bench('get(id, { at: { tag } }) — through the read hooks', () =>
    storage.get(ids[j++ % ids.length], { at: { tag: 'cow' } }));
  await bench('at(tag).list — the tag’s catalog, 1 000 ids', async () => (await storage.at('cow').list()).length);
  await storage.close();
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
