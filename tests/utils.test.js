'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs/promises');
const { Emitter, generateUUID, between, fileExists, directoryExists } = require('../src/utils.js');
const { createTemp, cleanupTemp } = require('./utils/temp.js');
const { runEmitterTests } = require('./suites/emitter.js');

test('Emitter', async (t) => {
  await runEmitterTests(t, assert, Emitter);
});

test('generateUUID', () => {
  const id = generateUUID();
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.notStrictEqual(id, generateUUID());
});

test('between', () => {
  assert.strictEqual(between('ws://peer.example.com:9000', '://', ':'), 'peer.example.com');
  assert.strictEqual(between('abc', 'a'), 'bc');
  assert.strictEqual(between('abc', 'z'), '');
  assert.strictEqual(between('abc', 'a', 'z'), '');
});

test('fileExists and directoryExists', async (t) => {
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
