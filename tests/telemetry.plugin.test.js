'use strict';

// Telemetry as a block: the OpenTelemetry adapter is the plugin's; the core
// records through a writer — one the plugin built from `{ api }` or
// `{ tracer, meter }`, or one the application hands in as it is — and
// through the disabled one otherwise, the write path bracketing its work
// the same way on or off.

const test = require('node:test');
const assert = require('node:assert');
const core = require('../index.js');
const { memory } = require('../src/memory/memory.js');
const { DISABLED } = require('../src/telemetry.js');
const { telemetry, createTelemetry } = require('../src/telemetry/telemetry.js');

// A tracer of the duck-typed shape: every span it starts is kept.
const createTracer = () => {
  const spans = [];
  return {
    spans,
    startSpan(name) {
      const span = {
        name,
        ended: false,
        attributes: {},
        end: () => (span.ended = true),
        setAttribute: (k, v) => (span.attributes[k] = v),
      };
      spans.push(span);
      return span;
    },
  };
};

test('telemetry as a plugin', async (t) => {
  await t.test('without the plugin an api or a tracer is PLUGIN_MISSING; a writer is taken as it is', async (t2) => {
    const fsi = memory();
    await assert.rejects(
      () => core.open({ path: 'api', fsi, logger: false, telemetry: { api: { trace: {}, metrics: {} } } }),
      {
        name: 'TypeError',
        code: 'PLUGIN_MISSING',
        message:
          "open({ telemetry }) needs the telemetry plugin: open({ plugins: [telemetry] }) from '@alexify/syncom/telemetry'",
      },
    );
    await assert.rejects(
      () => core.open({ path: 'tracer', fsi, logger: false, telemetry: { tracer: createTracer() } }),
      {
        code: 'PLUGIN_MISSING',
      },
    );
    // The disabled writer is what a storage without telemetry records through.
    const plain = await core.open({ path: 'plain', fsi, logger: false });
    t2.after(() => plain.close().catch(() => {}));
    assert.strictEqual(plain.telemetry, DISABLED);
    await plain.insert({ a: 1 });
    // A writer of the contract, built elsewhere, is handed down unchanged.
    const tracer = createTracer();
    const writer = createTelemetry({ tracer });
    assert.notStrictEqual(writer, DISABLED);
    const traced = await core.open({ path: 'writer', fsi, logger: false, telemetry: writer });
    t2.after(() => traced.close().catch(() => {}));
    assert.strictEqual(traced.telemetry, writer);
    assert.strictEqual(traced.log.telemetry ?? writer, writer);
    await traced.insert({ a: 1 });
    assert.ok(
      tracer.spans.some((span) => span.name === 'syncom.commit' && span.ended),
      'the write was bracketed',
    );
  });

  await t.test('with the plugin the api and the pre-built instances are adapted, on the lean core', async (t2) => {
    const fsi = memory();
    const tracer = createTracer();
    const storage = await core.open({
      path: 'adapted',
      fsi,
      logger: false,
      plugins: [telemetry],
      telemetry: { tracer },
    });
    t2.after(() => storage.close().catch(() => {}));
    assert.deepStrictEqual(storage.plugins, ['telemetry']);
    assert.strictEqual(storage.telemetry.enabled, true);
    const id = await storage.insert({ a: 1 });
    await storage.update(id, { a: 2 });
    const commits = tracer.spans.filter((span) => span.name === 'syncom.commit');
    assert.strictEqual(commits.length, 2);
    assert.ok(commits.every((span) => span.ended));
    // An empty bag, or an api with neither trace nor metrics: the disabled writer, no refusal.
    const quiet = await core.open({ path: 'quiet', fsi, logger: false, plugins: [telemetry], telemetry: {} });
    t2.after(() => quiet.close().catch(() => {}));
    assert.strictEqual(quiet.telemetry, DISABLED);
  });
});
