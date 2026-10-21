'use strict';

// The error model: an operational failure is a SyncomError with a `code` a
// caller can switch on (and the fields the code documents), a wrong argument
// is a TypeError without one, and a host's refusal on the wire is a numeric
// code with a `reason` beside it. Each code here is reached the way an
// application would reach it.

const test = require('node:test');
const assert = require('node:assert');
const syncom = require('..');
const { typed } = require('../src/errors.js');
const { createMemoryFsi } = require('../src/backend.js');
const { createTemp, cleanupTemp } = require('./utils/temp.js');
const { MemoryLink } = require('./utils/memory-link.js');

const { SyncomError, HookError, ValidationError } = syncom;

const openTemp = async (t, options = {}) => {
  const dir = await createTemp();
  t.after(() => cleanupTemp(dir));
  const storage = await syncom.open({ path: dir, logger: false, ...options });
  t.after(() => storage.close().catch(() => {}));
  return storage;
};

test('SyncomError', async (t) => {
  await t.test('carries a code, its fields and a cause; the two older classes are SyncomErrors', () => {
    const cause = new Error('disk');
    const error = new SyncomError('CORRUPT', 'node.json is unreadable', { cause, file: 'node.json' });
    assert.ok(error instanceof Error);
    assert.strictEqual(error.name, 'SyncomError');
    assert.strictEqual(error.code, 'CORRUPT');
    assert.strictEqual(error.file, 'node.json');
    assert.strictEqual(error.cause, cause);
    assert.strictEqual(error.message, 'node.json is unreadable');
    assert.match(error.stack, /^SyncomError: node.json is unreadable/);
    const bare = new SyncomError('CLOSED', 'Storage is closed');
    assert.strictEqual('cause' in bare, false, 'no cause property when none was given');
    assert.deepStrictEqual(Object.keys(bare), ['name', 'code']);

    const hook = new HookError('beforeWrite', new Error('no'));
    assert.ok(hook instanceof SyncomError);
    assert.strictEqual(hook.name, 'HookError');
    assert.strictEqual(hook.code, 'HOOK_FAILED');
    assert.strictEqual(hook.hook, 'beforeWrite');
    assert.strictEqual(hook.cause.message, 'no');
    const validation = new ValidationError('Post', [{ path: ['title'], message: 'is required' }]);
    assert.ok(validation instanceof SyncomError);
    assert.strictEqual(validation.name, 'ValidationError');
    assert.strictEqual(validation.code, 'VALIDATION_FAILED');
    assert.strictEqual(validation.entity, 'Post');
    assert.strictEqual(validation.issues.length, 1);

    const data = typed('INVALID_ID', 'Invalid record id');
    assert.ok(data instanceof TypeError);
    assert.strictEqual(data.code, 'INVALID_ID');
  });

  await t.test('the storage: CLOSED, IN_HOOK, NOT_FOUND, FIELD_KIND, ENCRYPTED, TYPE_IMMUTABLE', async (t2) => {
    let store = null;
    const hooks = {
      beforeWrite: async (ctx) => {
        if (ctx.id === 'from-hook') await store.set('other', { a: 1 });
      },
    };
    const storage = await openTemp(t2, { hooks });
    store = storage;
    const id = await storage.insert({ name: 'a', $type: 'Thing' });
    await storage.inc(id, 'hits');
    await assert.rejects(() => storage.update(id, { hits: 5 }), {
      name: 'SyncomError',
      code: 'FIELD_KIND',
      field: 'hits',
      kind: 'counter',
      message: /is a counter; use inc\(\)/,
    });
    await assert.rejects(() => storage.inc(id, 'name'), {
      code: 'FIELD_KIND',
      field: 'name',
      kind: 'register',
      message: /is a register; use update\(\)/,
    });
    await storage.add(id, 'tags', ['x']);
    await assert.rejects(() => storage.update(id, { tags: [] }), {
      code: 'FIELD_KIND',
      field: 'tags',
      kind: 'set',
      message: /is a set; use add\(\) or remove\(\)/,
    });
    await assert.rejects(() => storage.remove(id, 'hits', ['x']), { code: 'FIELD_KIND', kind: 'counter' });
    await assert.rejects(() => storage.set(id, { $type: 'Other' }), {
      name: 'TypeError',
      code: 'TYPE_IMMUTABLE',
    });
    await assert.rejects(() => storage.update('nope', { a: 1 }), {
      code: 'NOT_FOUND',
      message: 'Record nope not found',
    });
    await assert.rejects(() => storage.swap('nope', { a: 1 }, { a: 0 }), { code: 'NOT_FOUND' });
    // A write from inside a write hook is refused where the deadlock would start.
    await assert.rejects(
      () => storage.set('from-hook', { a: 1 }),
      (error) => {
        assert.strictEqual(error.code, 'HOOK_FAILED');
        assert.strictEqual(error.cause.code, 'IN_HOOK');
        assert.ok(error.cause instanceof SyncomError);
        return true;
      },
    );
    const sealed = await storage.insert({ secret: 1 }, { encrypted: true });
    await assert.rejects(() => storage.inc(sealed, 'n'), { code: 'ENCRYPTED', message: /needs a replicated record/ });
    await assert.rejects(() => storage.add(sealed, 'tags', ['x']), { code: 'ENCRYPTED', message: /add needs/ });
    await assert.rejects(() => storage.set(id, { a: 1 }, { encrypted: true }), {
      code: 'ENCRYPTED',
      message: /cannot become encrypted/,
    });
    await storage.close();
    await assert.rejects(() => storage.set('late', { a: 1 }), { code: 'CLOSED', message: 'Storage is closed' });
    await assert.rejects(() => storage.applyRemote([]), { code: 'CLOSED' });
  });

  await t.test('the files: CORRUPT, BLOCK_NOT_FOUND, BAD_ENVELOPE', async (t2) => {
    const fsi = createMemoryFsi();
    const first = await syncom.open({ path: 'store', fsi, logger: false });
    await first.set('r1', { a: 1 });
    await first.close();
    await fsi.write('store', 'node.json', '{not json');
    await assert.rejects(
      () => syncom.open({ path: 'store', fsi, logger: false }),
      (error) => {
        assert.strictEqual(error.code, 'CORRUPT');
        assert.ok(error instanceof SyncomError);
        assert.ok(error.cause instanceof SyntaxError, 'the parse error is the cause');
        return true;
      },
    );
    const chain = await new syncom.Blockchain('store/blockchain', { fsi });
    await assert.rejects(() => chain.readBlock('nope'), { code: 'BLOCK_NOT_FOUND', hash: 'nope' });
    const { privateKey } = await syncom.generateKeys();
    assert.throws(() => syncom.decrypt(JSON.stringify({ v: 2, alg: 'none' }), privateKey), {
      code: 'BAD_ENVELOPE',
      message: 'Unsupported ciphertext envelope',
    });
    const half = createMemoryFsi();
    await half.write('k', 'public.pem', 'x');
    await assert.rejects(() => syncom.loadKeys('k', { fsi: half }), { name: 'SyncomError', code: 'KEYS_INCOMPLETE' });
  });

  await t.test('the host: a refusal is a numeric code on the wire with a reason beside it', async (t2) => {
    const refusals = [];
    const logger = { debug() {}, info() {}, warn: (entry) => refusals.push(entry), error() {} };
    const other = await openTemp(t2, { logger, sync: { autoStart: false } });
    const unit = other.sync.unit({ access: 'public', authorize: (context, hello) => hello.node !== 'banned' });
    const link = new MemoryLink(unit);
    await assert.rejects(() => link.call('syncom/push', { ops: [] }), { code: 428, reason: 'HELLO_FIRST' });
    await assert.rejects(() => link.call('syncom/hello', {}), { code: 400, reason: 'BAD_HELLO' });
    await assert.rejects(() => link.call('syncom/hello', { node: 'peer', version: 99 }), {
      code: 400,
      reason: 'PROTOCOL',
    });
    await assert.rejects(() => link.call('syncom/hello', { node: other.nodeId }), { code: 409, reason: 'SELF' });
    await assert.rejects(() => link.call('syncom/hello', { node: 'banned' }), { code: 403, reason: 'UNAUTHORIZED' });
    const logged = refusals.filter((entry) => entry.event === 'sync.hello.refused');
    assert.deepStrictEqual(
      logged.map((entry) => [entry.code, entry.reason, entry.node]),
      [
        [400, 'BAD_HELLO', null],
        [400, 'PROTOCOL', 'peer'],
        [409, 'SELF', other.nodeId],
        [403, 'UNAUTHORIZED', 'banned'],
      ],
      '428 is only counted, every other refusal is logged with its reason',
    );
  });
});
