// The Faster open page (docs/guide/open-cost.md) shows the regions of this file.
// tests/package/docs-examples.test.js runs it from an empty temporary directory.
import assert from 'node:assert/strict';
import { createDatabase } from '@alexify/syncom/all';

const schema = { entities: { Task: { index: ['done'] } } };
const seed = await createDatabase({ path: 'board', schema, logger: false });
await seed.Task.bulkInsert(Array.from({ length: 2000 }, (_, i) => ({ title: `task ${i}`, done: i % 2 === 0 })));
await seed.close(); // close() saves the catalog: the next open reads it instead of every record

// #region measure
const open = async (options) => {
  const events = [];
  const logger = { debug: (entry) => events.push(entry), warn: console.warn, error: console.error };
  const started = performance.now();
  const db = await createDatabase({ path: 'board', logger, ...options });
  const ms = Math.round(performance.now() - started);
  const rebuilt = events.find((entry) => entry.event === 'catalog.rebuild');
  console.log(`${ms} ms`, rebuilt ? `catalog rebuilt (${rebuilt.reason})` : 'catalog reused', db.stats().log.length);
  return { db, rebuilt };
};

const warm = await open({ schema }); // … ms catalog reused 2000
await warm.db.close();

const changed = await open({ schema: { entities: { Task: { index: ['done', 'title'] } } } });
// … ms catalog rebuilt (no catalog) 2000   another index set: every record read once
await changed.db.close();
// #endregion measure
assert.equal(warm.rebuilt, undefined);
assert.equal(changed.rebuilt.event, 'catalog.rebuild');
