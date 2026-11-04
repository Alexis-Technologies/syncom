'use strict';

// The at-rest wrapper over OPFS (the mock) with Web Crypto, under a storage
// with every shipped plugin — the sealed record and the chain go through it
// too — loaded through tests/utils/browser-env.js like the other browser
// wrappers.

const test = require('node:test');
const assert = require('node:assert');
const { installBrowserGlobals, requireBrowserAll, prime } = require('./utils/browser-env.js');
// Before the suite and everything it loads: the shared modules resolve to the browser halves.
prime();

test('encryption (browser)', async (t) => {
  const env = installBrowserGlobals();
  t.after(() => env.uninstall());
  const browser = requireBrowserAll();
  const opfs = require('../src/fsi.browser.js');
  const fsi = browser.atRest(opfs, { key: new Uint8Array(32).fill(3) });
  const storage = await browser.createDatabase({ path: 'enc-store', fsi, logger: false });
  const id = await storage.insert({ title: 'Secret' });
  const sealed = await storage.insert({ title: 'Sealed' }, { encrypted: true });
  assert.deepStrictEqual(await storage.get(id), { title: 'Secret' });
  assert.deepStrictEqual(await storage.get(sealed), { title: 'Sealed' });
  assert.strictEqual(await storage.validate(), true);
  await storage.close();
  // The mock OPFS holds enc1: text and no plain word.
  for (const [dir, file] of [
    ['enc-store/data', `${id}.json`],
    ['enc-store', 'node.json'],
    ['enc-store/keys', 'sign-public.pem'],
  ]) {
    const text = await opfs.read(dir, file);
    assert.ok(text.startsWith('enc1:') && !text.includes('Secret') && !text.includes('BEGIN'), `${dir}/${file}`);
  }
  const again = await browser.createDatabase({ path: 'enc-store', fsi, logger: false });
  assert.deepStrictEqual(await again.get(id), { title: 'Secret' });
  assert.deepStrictEqual(await again.get(sealed), { title: 'Sealed' });
  assert.strictEqual(again.nodeId, storage.nodeId);
  await again.close();
});
