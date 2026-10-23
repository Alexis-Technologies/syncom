'use strict';

const test = require('node:test');
const { installMockOpfs } = require('./utils/mock-opfs.js');
const { runFsiTests } = require('./suites/fsi.js');

test('fsi.browser module (OPFS mock)', async (t) => {
  const opfs = installMockOpfs();
  t.after(() => opfs.uninstall());

  const fsiBrowser = require('../src/fsi.browser.js');

  await runFsiTests(t, fsiBrowser, {
    getRoot: async () => `vfs-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`,
    joinPath: (root, ...parts) => [root, ...parts].join('/'),
  });

  await t.test('exists/remove swallow only "not there"', async (t2) => {
    const assert = require('node:assert');
    const fsi = fsiBrowser;
    await fsi.write('narrow/dir', 'a.txt', 'x');
    assert.strictEqual(await fsi.exists('narrow/dir', 'a.txt'), true);
    assert.strictEqual(await fsi.exists('narrow/dir', 'missing.txt'), false, 'NotFoundError is "not there"');
    assert.strictEqual(await fsi.exists('narrow', 'dir'), false, 'a directory under that name is "not there" too');
    await fsi.remove('narrow/dir', 'missing.txt');
    // A storage that is denied or broken is not "not there": the error surfaces.
    const denied = {
      kind: 'directory',
      getDirectoryHandle: async () => denied,
      getFileHandle: async () => {
        throw new DOMException('denied', 'NotAllowedError');
      },
      removeEntry: async () => {
        throw new DOMException('busy', 'InvalidModificationError');
      },
    };
    const { storage } = globalThis.navigator;
    const { getDirectory } = storage;
    storage.getDirectory = async () => denied;
    t2.after(() => {
      storage.getDirectory = getDirectory;
    });
    // A directory not seen before: resolved through the denied root (a cached
    // handle would still answer for `narrow/dir`).
    await assert.rejects(() => fsi.exists('denied/dir', 'a.txt'), { name: 'NotAllowedError' });
    await assert.rejects(() => fsi.remove('denied/dir', 'a.txt'), { name: 'InvalidModificationError' });
  });
});
