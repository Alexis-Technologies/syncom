'use strict';

const test = require('node:test');
const assert = require('node:assert');
const syncom = require('../src/all/all.js');
const { createTemp, cleanupTemp } = require('./utils/temp.js');
const { runSignatureTests } = require('./suites/signatures.js');

test('Signatures (node)', async (t) => {
  await runSignatureTests(t, assert, async (t2, name, options = {}) => {
    const dir = await createTemp();
    t2.after(() => cleanupTemp(dir));
    const storage = await syncom.open({ path: dir, logger: false, ...options });
    t2.after(() => storage.close().catch(() => {}));
    return storage;
  });
});
