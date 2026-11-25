'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');
const { Emitter, generateUUID, fileExists, directoryExists } = require('../src/utils.js');
const { createTemp, cleanupTemp } = require('./utils/temp.js');
const { runEmitterTests } = require('./suites/emitter.js');

describe('utils module', () => {
  describe('Emitter', () => runEmitterTests(assert, Emitter));

  it('should return a distinct UUID from generateUUID on every call', () => {
    const id = generateUUID();
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.notStrictEqual(id, generateUUID());
  });

  it('should tell a file from a directory with fileExists and directoryExists', async (t) => {
    const tempDir = await createTemp();
    t.after(() => cleanupTemp(tempDir));
    const file = path.join(tempDir, 'file.txt');
    await fs.writeFile(file, 'content');

    assert.strictEqual(await fileExists(file), true);
    assert.strictEqual(await fileExists(tempDir), false);
    assert.strictEqual(await fileExists(path.join(tempDir, 'missing')), false);

    assert.strictEqual(await directoryExists(tempDir), true);
    assert.strictEqual(await directoryExists(file), false);
    assert.strictEqual(await directoryExists(path.join(tempDir, 'missing')), false);
  });
});
