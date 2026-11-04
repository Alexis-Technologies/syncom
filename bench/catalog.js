/**
 * The record catalog in memory — src/catalog.js over the sorted indexes of
 * src/sorted.js (chunked sorted arrays): what a put costs with two sorted
 * indexes to keep up (a new row; a field changed, which re-keys only the
 * indexes that read it), what a load builds once, what a definition made
 * after the open rebuilds, what a scan reads by prefix — and, through the
 * database over the memory engine, what a page after its edge costs when
 * the scan seeks it, and a count the index answers. 100k rows in the
 * catalog; 20k records in the database.
 *
 * Run with `node bench/catalog.js` or `pnpm bench`.
 */

'use strict';

const { bench } = require('./support/harness.js');
const { Catalog } = require('../src/catalog.js');
const { normalizeSchema } = require('../src/schema/define.js');
const { memory } = require('../src/memory/memory.js');
const { createDatabase, memoryEngine } = require('../src/all/all.js');

const ROWS = 100_000;
const RECORDS = 20_000;

const entitiesOf = (schema) => normalizeSchema(schema).entities;
const idOf = (i) => `r${String(i).padStart(7, '0')}`;
const rowOf = (i, n) => ({ type: 'Post', v: 1, data: { org: `o${i % 100}`, n } });

const main = async () => {
  console.log(`Catalog benchmark — Node ${process.version}\n`);

  const schema = { entities: { Post: { index: ['org', 'n'] } } };
  const fsi = memory();
  const catalog = new Catalog({ fsi, path: 'bench', entities: entitiesOf(schema) });
  for (let i = 0; i < ROWS; i++) catalog.put(idOf(i), rowOf(i, i % 1000));

  let extra = ROWS;
  await bench(
    `insert, then remove — a row among ${ROWS}, two sorted indexes`,
    () => {
      const id = idOf(extra++);
      catalog.put(id, rowOf(extra, extra % 1000));
      catalog.put(id, null);
    },
    { opsPerIteration: 2 },
  );

  let changed = 0;
  await bench(`put — a field changed, ${ROWS} rows (the index that reads it re-keyed, the other kept)`, () => {
    const i = changed++ % ROWS;
    catalog.put(idOf(i), rowOf(i, (i + changed) % 1000));
  });

  await catalog.save('bench.1');
  await bench(
    `load — ${ROWS} rows, two sorted indexes built once`,
    async () => {
      const loaded = new Catalog({ fsi, path: 'bench', entities: entitiesOf(schema) });
      await loaded.load();
    },
    { warmup: 1, measureMs: 3000, opsPerIteration: ROWS },
  );

  const defs = [
    entitiesOf({ entities: { Post: { index: ['org', ['org', 'n']] } } }).get('Post'),
    entitiesOf({ entities: { Post: { index: ['org', 'n'] } } }).get('Post'),
  ];
  let turn = 0;
  await bench(
    `define — ${ROWS} rows under another key (the rows bare, the indexes built once)`,
    () => catalog.define('Post', defs[turn++ % 2]),
    { warmup: 1, measureMs: 3000, opsPerIteration: ROWS },
  );
  catalog.define('Post', defs[1]);
  for (let i = 0; i < ROWS; i++) catalog.put(idOf(i), rowOf(i, i % 1000));

  const plan = { index: ['org'], prefix: ['o7'], in: null, range: null, desc: false };
  await bench(
    `scan — 20 rows by prefix, of ${ROWS} (two seeks, the entries pulled)`,
    () => {
      const scanned = catalog.scan('Post', plan);
      for (let k = 0; k < 20; k++) scanned.next();
    },
    { opsPerIteration: 20 },
  );

  // Through the database: a page sought after its edge, a count the index answers.
  const db = await createDatabase({
    path: 'bench',
    engine: memoryEngine(),
    lock: false,
    chain: false,
    logger: false,
    sync: { signatures: false },
    schema: { entities: { Post: { index: [['org', 'n']] } } },
  });
  try {
    for (let i = 0; i < RECORDS; i++) await db.insert({ $type: 'Post', org: 'o1', n: i });
    const cursor = db.Post.select({ org: 'o1' }).order('n').limit(100);
    let page = await cursor.page();
    for (let i = 0; i < 99; i++) page = await cursor.after(page.next).page();
    const edge = page.next;
    await bench(
      `page — 100 rows after the edge of page 100, of ${RECORDS} (sought, not filtered)`,
      () => cursor.after(edge).fetch(),
      {
        opsPerIteration: 100,
      },
    );
    await bench(`count — by a prefix and a range, of ${RECORDS} (the index's, no record read)`, () =>
      db.Post.select({ org: 'o1', n: { $gte: 5000 } }).count());
  } finally {
    await db.close();
  }
};

void main();
