'use strict';

// The write made at once (LOG-9) over the browser halves: the header hashed
// in JavaScript at once (src/crypto/sha256.js), so the browser takes the same
// path Node.js does — and its log reads back on a reopen.

const test = require('node:test');
const assert = require('node:assert');
const { installBrowserGlobals, requireBrowserAll } = require('./utils/browser-env.js');

test('a write is made at once over the browser halves too', async (t) => {
  const env = installBrowserGlobals();
  t.after(() => env.uninstall());
  const browser = requireBrowserAll();
  const { memory } = require('../src/memory/memory.js');
  const fsi = memory();
  const options = { path: '/fast', fsi, logger: false, lock: false, sync: { signatures: false } };
  const storage = await browser.open(options);
  const id = await storage.insert({ title: 'doc' });
  await storage.push(id, 'body', 'a');
  const next = storage.log.next;
  const typed = storage.splice(id, 'body', 1, 0, 'b');
  assert.strictEqual(storage.log.next, next + 1, 'the seq is taken at once: the write did not wait for the queue');
  await typed;
  assert.strictEqual((await storage.get(id)).body, 'ab');
  await storage.close();
  const reopened = await browser.open(options);
  assert.strictEqual((await reopened.get(id)).body, 'ab', 'the fingerprints read back');
  await reopened.close();
});
