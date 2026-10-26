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

test('fsi append holds a few descriptors: more files than it holds, a remove, a directory gone, a failure', async () => {
  const assert = require('node:assert');
  const fs = require('node:fs/promises');
  const path = require('node:path');
  const dir = await createTemp();
  try {
    // Twelve files, more than the eight it holds: the least recently used is closed, never lost.
    const names = Array.from({ length: 12 }, (_, i) => `f${i}.jsonl`);
    for (const line of ['a\n', 'b\n']) for (const name of names) await fsi.append(dir, name, line);
    for (const name of names) assert.strictEqual(await fsi.read(dir, name), 'a\nb\n', name);
    // A remove closes its own descriptor first: the next append is a new file, not the unlinked one.
    await fsi.remove(dir, 'f11.jsonl');
    await fsi.append(dir, 'f11.jsonl', 'c\n');
    assert.strictEqual(await fsi.read(dir, 'f11.jsonl'), 'c\n');
    // A directory removed behind its back is made again.
    const nested = path.join(dir, 'n');
    await fsi.append(nested, 'x.jsonl', '1');
    await fsi.remove(nested, 'x.jsonl');
    await fs.rm(nested, { recursive: true, force: true });
    await fsi.append(nested, 'x.jsonl', '2');
    assert.strictEqual(await fsi.read(nested, 'x.jsonl'), '2');
    // A descriptor that failed is not kept: once the cause is gone, the next append opens again.
    await fs.mkdir(path.join(dir, 'busy.jsonl'));
    await assert.rejects(() => fsi.append(dir, 'busy.jsonl', 'x'), { code: 'EISDIR' });
    await fs.rmdir(path.join(dir, 'busy.jsonl'));
    await fsi.append(dir, 'busy.jsonl', 'y');
    assert.strictEqual(await fsi.read(dir, 'busy.jsonl'), 'y');
    for (const name of [...names, 'busy.jsonl']) await fsi.remove(dir, name);
    await fsi.remove(nested, 'x.jsonl');
  } finally {
    await cleanupTemp(dir);
  }
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
