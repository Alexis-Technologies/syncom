'use strict';

// The hook primitives and the contained event path, in isolation.

const test = require('node:test');
const assert = require('node:assert');
const { Emitter } = require('../src/utils.js');
const { HookError, normalizeHooks, runHook, notify } = require('../src/hooks.js');

const ALLOWED = ['beforeWrite', 'afterWrite'];

test('normalizeHooks', async (t) => {
  await t.test('absent hooks normalize to a map of nulls', () => {
    assert.deepStrictEqual(normalizeHooks(undefined, ALLOWED, 'Storage'), { beforeWrite: null, afterWrite: null });
    assert.deepStrictEqual(normalizeHooks(null, ALLOWED, 'Storage'), { beforeWrite: null, afterWrite: null });
    assert.deepStrictEqual(normalizeHooks({}, ALLOWED, 'Storage'), { beforeWrite: null, afterWrite: null });
  });

  await t.test('keeps every allowed name, functions or null', () => {
    const beforeWrite = () => {};
    const hooks = normalizeHooks({ beforeWrite, afterWrite: undefined }, ALLOWED, 'Storage');
    assert.deepStrictEqual(hooks, { beforeWrite, afterWrite: null });
  });

  await t.test('an unknown name, a non-object or a non-function throws a TypeError naming the label', () => {
    assert.throws(() => normalizeHooks({ beforeWrtie: () => {} }, ALLOWED, 'Storage'), {
      name: 'TypeError',
      message: "Storage: unknown hook 'beforeWrtie'",
    });
    assert.throws(() => normalizeHooks({ beforeWrite: 'nope' }, ALLOWED, 'SyncManager'), {
      name: 'TypeError',
      message: 'SyncManager: hooks.beforeWrite must be a function',
    });
    assert.throws(() => normalizeHooks('nope', ALLOWED, 'Storage'), /Storage: hooks must be an object/);
    assert.throws(() => normalizeHooks([], ALLOWED, 'Storage'), /Storage: hooks must be an object/);
  });
});

test('runHook', async (t) => {
  await t.test('an absent hook is a no-op that resolves undefined', async () => {
    assert.strictEqual(await runHook({ beforeWrite: null }, 'beforeWrite', 1), undefined);
  });

  await t.test('passes the arguments through and returns what the hook returns', async () => {
    const seen = [];
    const hooks = {
      beforeWrite: async (...args) => {
        seen.push(args);
        return 'replacement';
      },
    };
    assert.strictEqual(await runHook(hooks, 'beforeWrite', 'a', 2), 'replacement');
    assert.deepStrictEqual(seen, [['a', 2]]);
  });

  await t.test('a throw becomes a HookError naming the hook, with the original as cause', async () => {
    const original = new Error('nope');
    const hooks = { beforeWrite: () => Promise.reject(original) };
    const error = await runHook(hooks, 'beforeWrite').then(
      () => assert.fail('should reject'),
      (e) => e,
    );
    assert.ok(error instanceof HookError);
    assert.ok(error instanceof Error);
    assert.strictEqual(error.name, 'HookError');
    assert.strictEqual(error.code, 'HOOK_FAILED');
    assert.strictEqual(error.hook, 'beforeWrite');
    assert.strictEqual(error.cause, original);
    assert.strictEqual(error.message, 'The beforeWrite hook failed: nope');
    // A rejection with a non-error is wrapped the same way.
    // oxlint-disable-next-line prefer-promise-reject-errors -- a non-Error cause is the point
    const sync = await runHook({ afterWrite: () => Promise.reject('text') }, 'afterWrite').catch((e) => e);
    assert.strictEqual(sync.cause, 'text');
    assert.strictEqual(sync.message, 'The afterWrite hook failed: text');
  });
});

test('notify', async (t) => {
  const stubLogger = () => {
    const entries = [];
    return { entries, warn: (entry) => entries.push(entry), info() {}, debug() {}, error() {} };
  };

  await t.test('with no listener nothing is emitted — not even error, which the Emitter would throw on', () => {
    const emitter = new Emitter();
    const logger = stubLogger();
    assert.throws(() => emitter.emit('error', new Error('unheard')), /Unhandled error/);
    assert.doesNotThrow(() => notify(emitter, logger, 'error', new Error('unheard')));
    assert.strictEqual(notify(emitter, logger, 'change', 1), undefined);
    assert.strictEqual(logger.entries.length, 0);
  });

  await t.test('listeners run at once with the arguments, and are not awaited', async () => {
    const emitter = new Emitter();
    const seen = [];
    let resolveSlow;
    emitter.on('change', (a, b) => seen.push([a, b]));
    emitter.on('change', () => new Promise((resolve) => (resolveSlow = resolve)));
    notify(emitter, stubLogger(), 'change', 'op', null);
    assert.deepStrictEqual(seen, [['op', null]], 'the synchronous listener already ran');
    resolveSlow();
  });

  await t.test('a throwing or rejecting listener is contained and logged as a warning', async () => {
    const emitter = new Emitter();
    const logger = stubLogger();
    const seen = [];
    emitter.on('change', () => {
      throw new Error('sync boom');
    });
    emitter.on('change', () => seen.push('other listener still ran'));
    emitter.once('error', async () => {
      throw new Error('async boom');
    });
    assert.doesNotThrow(() => notify(emitter, logger, 'change', 1));
    assert.doesNotThrow(() => notify(emitter, logger, 'error', new Error('reported')));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepStrictEqual(seen, ['other listener still ran']);
    assert.deepStrictEqual(
      logger.entries.map((entry) => [entry.event, entry.name, entry.err.message]),
      [
        ['listener.error', 'change', 'sync boom'],
        ['listener.error', 'error', 'async boom'],
      ],
    );
  });
});
