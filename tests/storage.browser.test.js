'use strict';

// Storage over the BROWSER halves: OPFS for files, Web Crypto for hashing and
// encryption. The shared storage.js is loaded through tests/utils/browser-env.js
// so its nested requires resolve the way package.json#browser says they would.

const test = require('node:test');
const assert = require('node:assert');
const { installBrowserGlobals, requireBrowserAll } = require('./utils/browser-env.js');

test('Storage on the browser halves', async (t) => {
  const env = installBrowserGlobals();
  t.after(() => env.uninstall());
  const browser = requireBrowserAll();

  await t.test('the shared modules see the browser crypto and fsi', async () => {
    assert.ok(browser.calculateHash({ a: 1 }) instanceof Promise);
    const storage = await browser.open({ path: 'store-basic' });
    const id = await storage.insert({ title: 'Draft', hits: 0 });
    assert.deepStrictEqual(await storage.get(id), { title: 'Draft', hits: 0 });
    assert.strictEqual(await storage.validate(), true);
    // Written to the mock OPFS, not to disk.
    assert.strictEqual(await browser.exists('store-basic/data', `${id}.json`), true);
  });

  await t.test('the node id is the signing key here too, derived by Web Crypto', async () => {
    const storage = await browser.open({ path: 'store-identity' });
    assert.match(storage.nodeId, /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/);
    assert.strictEqual(storage.nodeId, (await browser.loadSigningKeys('store-identity/keys')).id);
    assert.deepStrictEqual(JSON.parse(await browser.read('store-identity', 'node.json')), {
      id: storage.nodeId,
      plugins: ['text', 'tree'],
    });
    await storage.close();
    const reopened = await browser.open({ path: 'store-identity' });
    assert.strictEqual(reopened.nodeId, storage.nodeId);
    await reopened.close();
  });

  await t.test('encryption at rest awaits the async Web Crypto', async () => {
    const storage = await browser.open({ path: 'store-encrypted' });
    const secret = { ssn: '123-45-6789' };
    await storage.saveData('s1', secret, { encrypted: true });

    // The on-disk entry holds ciphertext, not a serialized pending promise.
    const raw = JSON.parse(await browser.read('store-encrypted/data', 's1.json'));
    assert.strictEqual(raw.encrypted, true);
    assert.strictEqual(typeof raw.data, 'string');
    assert.notDeepStrictEqual(raw.data, {});

    // A cold read (fresh Storage, empty cache) decrypts it back.
    await storage.close();
    const reopened = await browser.open({ path: 'store-encrypted' });
    assert.deepStrictEqual(await reopened.get('s1'), secret);
  });
});

test('Storage telemetry on the browser halves', async (t) => {
  const env = installBrowserGlobals();
  t.after(() => env.uninstall());
  const browser = requireBrowserAll();
  const { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } = require('@opentelemetry/sdk-trace-base');

  await t.test('a commit is spanned with nothing but the injected tracer', async () => {
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
    const storage = await browser.open({ path: 'store-telemetry', telemetry: { tracer: provider.getTracer('t') } });
    const id = await storage.insert({ title: 'Traced' });
    // The open rebuilt the catalog under a span of its own; the commit is the one we want.
    const span = exporter.getFinishedSpans().find((candidate) => candidate.name === 'syncom.commit');
    assert.ok(span);
    assert.strictEqual(span.attributes['syncom.op.type'], 'write');
    assert.strictEqual(span.attributes['syncom.record.id'], id);
    assert.strictEqual(span.attributes['syncom.result'], 'applied');
  });
});
