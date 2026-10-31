'use strict';

// What names an op is the same SHA-256 on both platforms: the browser half
// (src/crypto/digest.browser.js) hashes a header in JavaScript, at once
// (src/crypto/sha256.js), and a large text through Web Crypto — every one
// node:crypto's digest.

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const node = require('../src/crypto/digest.js');
const browser = require('../src/crypto/digest.browser.js');
const { sha256Now } = require('../src/crypto/sha256.js');
const { prng } = require('./utils/mesh.js');

test('an op is named by the same SHA-256 on both platforms, the browser’s at once', async () => {
  const random = prng(7);
  const texts = ['', 'a', 'abc', 'é', '😀', 'a\ud800b', '\udc00', '\u0000￿'];
  // Every length around a block's end (55 bytes and the length fit; 56 do not), ASCII and wide.
  for (let n = 50; n < 140; n++) texts.push('x'.repeat(n), 'é'.repeat(n >> 1) + 'x'.repeat(n & 1));
  for (let k = 0; k < 300; k++) {
    let text = '';
    const length = Math.floor(random() * 600);
    for (let i = 0; i < length; i++) {
      const pick = random();
      text += String.fromCharCode(pick < 0.8 ? 32 + Math.floor(random() * 95) : Math.floor(random() * 0xffff));
    }
    texts.push(text);
  }
  for (const text of texts) {
    const want = crypto.hash('sha256', text, 'base64url');
    assert.strictEqual(browser.hashText(text), want, `hashText of ${JSON.stringify(text.slice(0, 20))}`);
    assert.strictEqual(node.hashText(text), want);
    assert.deepStrictEqual(Buffer.from(sha256Now(text)), crypto.hash('sha256', text, 'buffer'));
  }
  // `hashOf` at once up to 64 KiB of JSON, through Web Crypto past it — the same digest.
  const small = { header: [1, 'origin', 2, 3, 'splice', 'id'] };
  assert.strictEqual(browser.hashOf(small), node.hashOf(small));
  const large = { text: 'y'.repeat(70_000) };
  const pending = browser.hashOf(large);
  assert.ok(typeof pending.then === 'function', 'a promise past 64 KiB');
  assert.strictEqual(await pending, node.hashOf(large));
  assert.strictEqual(await browser.sha256(small), await node.sha256(small));
});
