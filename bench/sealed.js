/**
 * Sealed records in queries — src/catalog.js `sealed(type)` and the cursor's
 * merged page (src/query/cursor.js): what the sealed listing costs after a
 * plain write of the collection (a set kept per put, never a walk of the rows),
 * what an indexed count costs right after a write, and what an ordered, limited
 * page costs with one sealed record among 100k plain ones against none — the
 * page stays the index's, the sealed record read once (review №7, E1).
 *
 * Run with `node bench/sealed.js` or `pnpm bench`.
 */

'use strict';

const { bench } = require('./support/harness.js');
const { Catalog } = require('../src/catalog.js');
const { normalizeSchema } = require('../src/schema/define.js');
const { memory } = require('../src/memory/memory.js');
const { createDatabase, memoryEngine } = require('../src/all/all.js');

const ROWS = 100_000;
const RECORDS = 100_000;

const entitiesOf = (schema) => normalizeSchema(schema).entities;
const idOf = (i) => `r${String(i).padStart(7, '0')}`;

const main = async () => {
  console.log(`Sealed records benchmark — Node ${process.version}\n`);

  const schema = { entities: { Note: { index: ['tag', 'n'] } } };
  const catalog = new Catalog({ fsi: memory(), path: 'bench', entities: entitiesOf(schema) });
  for (let i = 0; i < ROWS; i++) catalog.put(idOf(i), { type: 'Note', v: 1, data: { tag: `t${i % 50}`, n: i } });
  catalog.put('sealed-1', { type: 'Note', encrypted: true });

  let changed = 0;
  await bench(`Catalog.sealed() after a plain write — ${ROWS} rows, one sealed: the listing kept, not rebuilt`, () => {
    const i = changed++ % ROWS;
    catalog.put(idOf(i), { type: 'Note', v: 1, data: { tag: `t${i % 50}`, n: i + changed } });
    return catalog.sealed('Note');
  });

  const engine = memoryEngine();
  const db = await createDatabase({ engine, path: 'bench/sealed', logger: false, defer: 0, schema });
  const ids = [];
  await db.transact(async (tx) => {
    for (let i = 0; i < RECORDS; i++) ids.push(await tx.insert({ $type: 'Note', tag: `t${i % 50}`, n: i }));
  });
  let n = RECORDS;
  await bench(`count({ tag }) right after a write — ${RECORDS} records, no sealed: the index's estimate`, async () => {
    await db.update(ids[n++ % 50], { n });
    return db.Note.count({ tag: 't7' });
  });
  await bench(`order('n').limit(10) — ${RECORDS} records, no sealed record`, () =>
    db.Note.select({}).order('n').limit(10).fetch());
  await db.insert({ $type: 'Note', tag: 't7', n: 50.5 }, { encrypted: true });
  await bench(`order('n').limit(10) — ${RECORDS} records, ONE sealed record: the page stays the index's`, () =>
    db.Note.select({}).order('n').limit(10).fetch());
  await bench(`count({ tag }) right after a write — ${RECORDS} records, one sealed record`, async () => {
    await db.update(ids[n++ % 50], { n });
    return db.Note.count({ tag: 't7' });
  });
  await db.close();
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
