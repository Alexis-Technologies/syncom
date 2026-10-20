'use strict';

const test = require('node:test');
const fsi = require('../src/fsi.js');
const { createTemp, cleanupTemp } = require('./utils/temp.js');
const { runFsiTests } = require('./suites/fsi.js');

test('fsi module', async (t) => {
  await runFsiTests(t, fsi, {
    getRoot: createTemp,
    afterEach: cleanupTemp,
  });
});

test('fsi write makes the directory once, and again when it went away', async () => {
  const assert = require('node:assert');
  const fs = require('node:fs/promises');
  const path = require('node:path');
  const dir = await createTemp();
  try {
    const nested = path.join(dir, 'a', 'b');
    await fsi.write(nested, 'x.json', '1');
    await fsi.write(nested, 'y.json', '2');
    await fs.rm(nested, { recursive: true, force: true });
    await fsi.write(nested, 'z.json', '3');
    assert.deepStrictEqual(await fsi.list(nested), ['z.json']);
    await fsi.write(dir, 'private.pem', 'secret', { mode: 0o600 });
    const { mode } = await fs.stat(path.join(dir, 'private.pem'));
    if (process.platform !== 'win32') assert.strictEqual(mode & 0o777, 0o600);
  } finally {
    await cleanupTemp(dir);
  }
});
