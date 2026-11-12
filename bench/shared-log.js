/**
 * The shared log (src/sync/shared.js) over the memory shared log of the tests:
 * what the relay costs a hub per write (an op offered, appended to the topic
 * with its position, the watermark moved), how long an op takes to reach a
 * second hub through the topic, and what a snapshot positioned at a marker
 * costs a writing hub under a burst of its own writes (review №7, E2).
 *
 * Run with `node bench/shared-log.js` or `pnpm bench`.
 */

'use strict';

const { bench } = require('./support/harness.js');
const { createDatabase, memoryEngine } = require('../src/all/all.js');
const { createMemorySharedLog } = require('../tests/utils/shared-log.js');
const { MemoryLink } = require('../tests/utils/memory-link.js');

const RECORDS = 5_000;

const main = async () => {
  console.log(`Shared log benchmark — Node ${process.version}\n`);
  const engine = memoryEngine();
  const shared = createMemorySharedLog();
  const h1 = await createDatabase({ engine, path: 'bench/H1', logger: false, defer: 0, sync: { sharedLog: shared } });
  const h2 = await createDatabase({ engine, path: 'bench/H2', logger: false, defer: 0, sync: { sharedLog: shared } });

  await bench('relay — one insert on a hub, offered and appended to the topic (the second hub applies it later)', () =>
    h1.insert({ n: 1 }));
  // Settle: everything appended, everything applied at H2.
  const settled = async () => {
    for (;;) {
      const a = h1.sync.shared();
      const b = h2.sync.shared();
      if (a.covered === 0 && !a.behind && b.entries >= a.relayed / 500) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  await settled();

  await bench(
    'lag — a write on one hub read on the other through the topic (insert, then wait for the record)',
    async () => {
      const id = await h1.insert({ n: 2 });
      while (!h2.hasRecord(id)) await new Promise((resolve) => setImmediate(resolve));
    },
    { warmup: 50, measureMs: 1500 },
  );

  for (let i = 0; i < RECORDS; i++) await h1.insert({ n: i, tag: `t${i % 20}` });
  await settled();
  const unit = h1.sync.unit({ access: 'public' });
  await bench(
    `snapshot positioned at a marker on the writing hub — ${RECORDS} records, the first page (500) under a burst of writes`,
    async () => {
      const link = new MemoryLink(unit);
      await link.call('syncom/hello', { node: 'probe', version: 1 });
      const burst = [];
      for (let i = 0; i < 20; i++) burst.push(h1.insert({ n: -i }));
      const page = await link.call('syncom/snapshot', { cursor: null });
      await Promise.all(burst);
      return page.records.length;
    },
    { warmup: 20, measureMs: 1500 },
  );
  await h1.close();
  await h2.close();
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
