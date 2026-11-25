'use strict';

// Telemetry as a block: the OpenTelemetry adapter is the plugin's; the core
// records through a writer — one the plugin built from `{ api }` or
// `{ tracer, meter }`, or one the application hands in as it is — and
// through the disabled one otherwise, the write path bracketing its work
// the same way on or off.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const core = require('../index.js');
const { memory } = require('../src/memory/memory.js');
const { DISABLED } = require('../src/telemetry/writer.js');
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

describe('telemetry as a plugin', () => {
  it('should refuse an api or a tracer without the plugin with PLUGIN_MISSING, and take a writer as it is', async (t2) => {
    const fsi = memory();
    await assert.rejects(
      () => core.createDatabase({ path: 'api', fsi, logger: false, telemetry: { api: { trace: {}, metrics: {} } } }),
      {
        name: 'DataError',
        code: 'ALX_ERR_PLUGIN_MISSING',
        message:
          "createDatabase({ telemetry }) needs the telemetry plugin: createDatabase({ plugins: [telemetry] }) from '@alexify/syncom/telemetry'",
      },
    );
    await assert.rejects(
      () => core.createDatabase({ path: 'tracer', fsi, logger: false, telemetry: { tracer: createTracer() } }),
      {
        code: 'ALX_ERR_PLUGIN_MISSING',
      },
    );
    // The disabled writer is what a storage without telemetry records through.
    const plain = await core.createDatabase({ path: 'plain', fsi, logger: false });
    t2.after(() => plain.close().catch(() => {}));
    assert.strictEqual(plain.telemetry, DISABLED);
    await plain.insert({ a: 1 });
    // A writer of the contract, built elsewhere, is handed down unchanged.
    const tracer = createTracer();
    const writer = createTelemetry({ tracer });
    assert.notStrictEqual(writer, DISABLED);
    const traced = await core.createDatabase({ path: 'writer', fsi, logger: false, telemetry: writer });
    t2.after(() => traced.close().catch(() => {}));
    assert.strictEqual(traced.telemetry, writer);
    assert.strictEqual(traced.log.telemetry ?? writer, writer);
    await traced.insert({ a: 1 });
    assert.ok(
      tracer.spans.some((span) => span.name === 'syncom.commit' && span.ended),
      'the write was bracketed',
    );
  });

  it('should adapt the api and the pre-built instances with the plugin, on the lean core', async (t2) => {
    const fsi = memory();
    const tracer = createTracer();
    const storage = await core.createDatabase({
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
    // The insert alone: the update was made at once — counted (`stats().commits`, `syncom.commits`), never spanned.
    assert.strictEqual(commits.length, 1);
    assert.ok(commits.every((span) => span.ended));
    assert.deepStrictEqual(storage.stats().commits, { fast: 1, queued: 1, coalesced: 0 });
    // An empty bag, or an api with neither trace nor metrics: the disabled writer, no refusal.
    const quiet = await core.createDatabase({ path: 'quiet', fsi, logger: false, plugins: [telemetry], telemetry: {} });
    t2.after(() => quiet.close().catch(() => {}));
    assert.strictEqual(quiet.telemetry, DISABLED);
  });
});
