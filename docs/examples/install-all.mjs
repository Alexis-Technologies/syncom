// The Installation page (docs/guide/install.md) shows the regions of this file.
// tests/package/docs-examples.test.js runs it from an empty temporary directory.
import assert from 'node:assert/strict';
// #region all
import { createDatabase } from '@alexify/syncom/all';

const db = await createDatabase({ path: 'board' });
console.log(db.plugins);
// [ 'text', 'tree', 'signing', 'chain', 'encryption', 'sync',
//   'schema', 'telemetry', 'query', 'versions', 'local' ]
// #endregion all
assert.deepEqual(db.plugins, [
  'text',
  'tree',
  'signing',
  'chain',
  'encryption',
  'sync',
  'schema',
  'telemetry',
  'query',
  'versions',
  'local',
]);
await db.close();
