/**
 * Full-text search — the trigram index on its own (no I/O), then `$text`
 * through the storage over 2000 records with a short title and a forty-word
 * body each, both searched. The index rows say what a put and a query cost;
 * the storage rows say what the catalog adds around them: the text joined
 * and kept on every write, the candidates seeded in rank order, the records
 * read for the rows.
 *
 * The corpus is deterministic (a fixed word pool, an LCG), so two runs rank
 * the same records the same way.
 *
 * Run with `node bench/search.js` or `pnpm bench search`.
 */

'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { bench } = require('./support/harness.js');
const { open } = require('../src/all/all.js');
const { createSearch } = require('../src/search/search.js');

const RECORDS = 2000;
const POOL = [];
for (let i = 0; i < 500; i++) POOL.push(`w${i.toString(36)}${'abcdefghij'[i % 10]}${'klmnopqrst'[(i * 7) % 10]}`);

const lcg = (seed) => {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
};

const corpus = () => {
  const random = lcg(20261022);
  const pick = () => POOL[Math.floor(random() * POOL.length)];
  const records = [];
  for (let i = 0; i < RECORDS; i++) {
    const body = [];
    for (let w = 0; w < 40; w++) body.push(pick());
    records.push({ group: `g${i % 20}`, title: `${pick()} ${pick()} ${pick()}`, body: body.join(' ') });
  }
  return records;
};

const main = async () => {
  console.log(`Search benchmark — Node ${process.version}\n`);
  const records = corpus();
  const word = records[7].title.split(' ')[0];
  const typo = `${word.slice(0, -2)}${word.at(-1)}${word.at(-2)}`;

  // The index alone: what the catalog calls on every write and every $text.
  const index = createSearch()('Item');
  for (let i = 0; i < records.length; i++) index.put(`r${i}`, `${records[i].title} ${records[i].body}`);
  let next = 0;
  await bench('index.put — a 43-word record', () => {
    const i = next++ % records.length;
    index.put(`r${i}`, `${records[i].title} ${records[i].body}`);
  });
  await bench(`index.query — one word over ${RECORDS}`, () => index.query(word));
  await bench(`index.query — two words over ${RECORDS}`, () =>
    index.query(`${word} ${records[9].title.split(' ')[1]}`));
  await bench(`index.query — a typo over ${RECORDS}`, () => index.query(typo));

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'syncom-bench-search-'));
  try {
    const schema = { entities: { Item: { index: ['group'], search: ['title', 'body'] } } };
    // Inserts into a store of their own: however many the row writes, the
    // queries below run over exactly the corpus.
    const scratch = await open({
      path: path.join(root, 'scratch'),
      lock: false,
      logger: false,
      schema,
      search: createSearch(),
    });
    let written = 0;
    await bench('insert — 2 search fields (43 words)', () => scratch.Item.insert(records[written++ % records.length]), {
      warmup: 20,
    });
    await scratch.close();
    const storage = await open({
      path: path.join(root, 'corpus'),
      lock: false,
      logger: false,
      schema,
      search: createSearch(),
    });
    for (const record of records) await storage.Item.insert(record);
    await bench(`select — $text one word over ${RECORDS}, limit 20`, () =>
      storage.Item.select({ $text: word }).limit(20).fetch());
    await bench(`select — $text + eq narrowing over ${RECORDS}`, () =>
      storage.Item.select({ $text: word, group: 'g7' }).fetch());
    await bench(`count — $text over ${RECORDS}`, () => storage.Item.count({ $text: word }));
    await storage.close();
    await bench(
      `open — catalog reloaded with text (${RECORDS} records)`,
      async () => {
        const reopened = await open({
          path: path.join(root, 'corpus'),
          lock: false,
          logger: false,
          schema,
          search: createSearch(),
        });
        await reopened.close();
      },
      { warmup: 1, measureMs: 2000 },
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
};

void main();
