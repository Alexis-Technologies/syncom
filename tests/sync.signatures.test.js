'use strict';

const { describe } = require('node:test');
const assert = require('node:assert/strict');
const syncom = require('../src/all/all.js');
const { createTemp, cleanupTemp } = require('./utils/temp.js');
const { runSignatureTests } = require('./suites/signatures.js');

describe('Signatures (node)', () => {
  runSignatureTests(assert, async (t2, name, options = {}) => {
    const dir = await createTemp();
    t2.after(() => cleanupTemp(dir));
    const storage = await syncom.createDatabase({ path: dir, logger: false, ...options });
    t2.after(() => storage.close().catch(() => {}));
    return storage;
  });
});
