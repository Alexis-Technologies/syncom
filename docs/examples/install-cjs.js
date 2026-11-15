'use strict';

// The Installation page (docs/guide/install.md) shows the region of this file: the same package from CommonJS.
// tests/package/docs-examples.test.js runs it from an empty temporary directory.
const assert = require('node:assert/strict');

const main = async () => {
  // #region cjs
  const { createDatabase } = require('@alexify/syncom');
  const { memoryEngine } = require('@alexify/syncom/memory');

  const db = await createDatabase({ engine: memoryEngine(), path: 'board' });
  const id = await db.insert({ title: 'Opened from require()' });
  console.log(await db.get(id)); // { title: 'Opened from require()' }
  // #endregion cjs
  assert.deepEqual(await db.get(id), { title: 'Opened from require()' });
  await db.close();
};

main();
