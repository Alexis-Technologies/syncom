'use strict';

// The error model: an operational failure is a SyncomError with a `code` a
// caller can switch on (and the fields the code documents), a wrong argument
// is a TypeError without one, and a host's refusal on the wire is a numeric
// code with a `reason` beside it. Each code here is reached the way an
// application would reach it.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const syncom = require('../src/all/all.js');
const { ArgumentError, ArgumentRangeError, DataError } = require('../src/errors.js');
const { memory } = require('../src/memory/memory.js');
const { createTemp, cleanupTemp } = require('./utils/temp.js');
const { MemoryLink } = require('./utils/memory-link.js');

const { SyncomError, HookError, ValidationError } = syncom;

const openTemp = async (t, options = {}) => {
  const dir = await createTemp();
  t.after(() => cleanupTemp(dir));
  const storage = await syncom.createDatabase({ path: dir, logger: false, ...options });
  t.after(() => storage.close().catch(() => {}));
  return storage;
};

describe('SyncomError', () => {
  it('should carry a code, its fields and a cause, the two older classes being SyncomErrors', () => {
    const cause = new Error('disk');
    const error = new SyncomError('node.json is unreadable', { code: 'ALX_ERR_CORRUPT', cause, file: 'node.json' });
    assert.ok(error instanceof Error);
    assert.strictEqual(error.name, 'SyncomError');
    assert.strictEqual(error.code, 'ALX_ERR_CORRUPT');
    assert.strictEqual(error.file, 'node.json');
    assert.strictEqual(error.cause, cause);
    assert.strictEqual(error.message, 'node.json is unreadable');
    assert.match(error.stack, /^SyncomError: node.json is unreadable/);
    const bare = new SyncomError('Storage is closed', { code: 'ALX_ERR_CLOSED' });
    assert.strictEqual('cause' in bare, false, 'no cause property when none was given');
    assert.deepStrictEqual(Object.keys(bare), ['name', 'code']);

    const hook = new HookError('The beforeWrite hook failed: no', { hook: 'beforeWrite', cause: new Error('no') });
    assert.ok(hook instanceof SyncomError);
    assert.strictEqual(hook.name, 'HookError');
    assert.strictEqual(hook.code, 'ALX_ERR_HOOK_FAILED');
    assert.strictEqual(hook.hook, 'beforeWrite');
    assert.strictEqual(hook.cause.message, 'no');
    const issues = [{ path: ['title'], message: 'is required' }];
    const validation = new ValidationError('Post failed validation', { entity: 'Post', issues });
    assert.ok(validation instanceof SyncomError);
    assert.strictEqual(validation.name, 'ValidationError');
    assert.strictEqual(validation.code, 'ALX_ERR_VALIDATION_FAILED');
    assert.strictEqual(validation.entity, 'Post');
    assert.strictEqual(validation.issues, issues);
    assert.deepStrictEqual(
      [new ValidationError('Record failed validation').entity, new ValidationError('x').issues],
      [null, []],
      'no entity is null, no issues an empty list',
    );
    // A class with a fixed code keeps it whatever the options say: the code is the class's.
    assert.strictEqual(new HookError('no', { code: 'ALX_ERR_CLOSED' }).code, 'ALX_ERR_HOOK_FAILED');
    assert.strictEqual(new SyncomError('gone', { code: 'ALX_ERR_NOT_FOUND', cause: undefined }).cause, undefined);
    assert.strictEqual(
      'cause' in new SyncomError('gone', { code: 'ALX_ERR_NOT_FOUND', cause: undefined }),
      false,
      'a cause passed on as undefined is none',
    );

    const data = new DataError('Invalid record id', {
      code: 'ALX_ERR_INVALID_ID',
      details: { entity: 'Task', field: 'key' },
    });
    assert.ok(data instanceof TypeError);
    assert.strictEqual(data.name, 'DataError');
    assert.strictEqual(data.code, 'ALX_ERR_INVALID_ID');
    assert.deepStrictEqual(data.details, { entity: 'Task', field: 'key' });
    assert.strictEqual(new DataError('no chain', { code: 'ALX_ERR_NO_CHAIN' }).details, null);
    const wrong = new ArgumentError('createDatabase(): path is a string', { cause: data });
    assert.ok(wrong instanceof TypeError);
    assert.deepStrictEqual([wrong.name, wrong.code, wrong.cause], ['ArgumentError', 'ALX_ERR_INVALID_ARGUMENT', data]);
    const range = new ArgumentRangeError('between(): the bounds are not in order');
    assert.ok(range instanceof RangeError);
    assert.deepStrictEqual([range.name, range.code], ['ArgumentRangeError', 'ALX_ERR_INVALID_ARGUMENT']);
  });

  it('should raise the storage codes CLOSED, IN_HOOK, NOT_FOUND, FIELD_KIND, CYCLE, ENCRYPTED, TYPE_IMMUTABLE', async (t2) => {
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
      code: 'ALX_ERR_FIELD_KIND',
      field: 'hits',
      kind: 'counter',
      message: /is a counter; use inc\(\)/,
    });
    await assert.rejects(() => storage.inc(id, 'name'), {
      code: 'ALX_ERR_FIELD_KIND',
      field: 'name',
      kind: 'register',
      message: /is a register; use update\(\)/,
    });
    await storage.add(id, 'tags', ['x']);
    await assert.rejects(() => storage.update(id, { tags: [] }), {
      code: 'ALX_ERR_FIELD_KIND',
      field: 'tags',
      kind: 'set',
      message: /is a set; use add\(\) or remove\(\)/,
    });
    await assert.rejects(() => storage.remove(id, 'hits', ['x']), { code: 'ALX_ERR_FIELD_KIND', kind: 'counter' });
    await storage.treeMove(id, 'outline', 'n');
    await storage.treeMove(id, 'outline', 'm', 'n');
    await assert.rejects(() => storage.treeMove(id, 'outline', 'n', 'm'), {
      name: 'SyncomError',
      code: 'ALX_ERR_CYCLE',
      id,
      field: 'outline',
      node: 'n',
      parent: 'm',
      message: /cannot go under m, a node under it/,
    });
    await assert.rejects(() => storage.treeMove(id, 'outline', 'n', null, { after: 'zz' }), {
      name: 'SyncomError',
      code: 'ALX_ERR_NOT_FOUND',
      id,
      field: 'outline',
      node: 'zz',
      message: /is not under the root/,
    });
    await assert.rejects(() => storage.update(id, { outline: 1 }), {
      code: 'ALX_ERR_FIELD_KIND',
      field: 'outline',
      kind: 'tree',
      message: /is a tree; use treeMove\(\) or treeRemove\(\)/,
    });
    await storage.splice(id, 'body', 0, 0, 'hi');
    await assert.rejects(() => storage.update(id, { body: 'x' }), {
      code: 'ALX_ERR_FIELD_KIND',
      field: 'body',
      kind: 'text',
      message: /is a text; use splice\(\), push/,
    });
    await assert.rejects(() => storage.splice(id, 'hits', 0, 0, 'x'), { code: 'ALX_ERR_FIELD_KIND', kind: 'counter' });
    await assert.rejects(() => storage.splice(id, 'body', 9, 0, 'x'), {
      name: 'SyncomError',
      code: 'ALX_ERR_OUT_OF_RANGE',
      id,
      field: 'body',
      index: 9,
      count: 0,
      length: 2,
      message: /Index 9 is out of range for field body/,
    });
    await assert.rejects(() => storage.set(id, { $type: 'Other' }), {
      name: 'DataError',
      code: 'ALX_ERR_TYPE_IMMUTABLE',
    });
    await assert.rejects(() => storage.update('nope', { a: 1 }), {
      code: 'ALX_ERR_NOT_FOUND',
      message: 'Record nope not found',
    });
    await assert.rejects(() => storage.swap('nope', { a: 1 }, { a: 0 }), { code: 'ALX_ERR_NOT_FOUND' });
    // A write from inside a write hook is refused where the deadlock would start.
    await assert.rejects(
      () => storage.set('from-hook', { a: 1 }),
      (error) => {
        assert.strictEqual(error.code, 'ALX_ERR_HOOK_FAILED');
        assert.strictEqual(error.cause.code, 'ALX_ERR_IN_HOOK');
        assert.ok(error.cause instanceof SyncomError);
        return true;
      },
    );
    const sealed = await storage.insert({ secret: 1 }, { encrypted: true });
    await assert.rejects(() => storage.inc(sealed, 'n'), {
      code: 'ALX_ERR_ENCRYPTED',
      message: /needs a replicated record/,
    });
    await assert.rejects(() => storage.add(sealed, 'tags', ['x']), { code: 'ALX_ERR_ENCRYPTED', message: /add needs/ });
    await assert.rejects(() => storage.set(id, { a: 1 }, { encrypted: true }), {
      code: 'ALX_ERR_ENCRYPTED',
      message: /cannot become encrypted/,
    });
    await storage.close();
    await assert.rejects(() => storage.set('late', { a: 1 }), { code: 'ALX_ERR_CLOSED', message: 'Storage is closed' });
    await assert.rejects(() => storage.applyRemote([]), { code: 'ALX_ERR_CLOSED' });
  });

  it('should raise the file codes CORRUPT, BLOCK_NOT_FOUND, BAD_ENVELOPE', async (t2) => {
    const fsi = memory();
    const first = await syncom.createDatabase({ path: 'store', fsi, logger: false });
    await first.set('r1', { a: 1 });
    await first.close();
    await fsi.write('store', 'node.json', '{not json');
    await assert.rejects(
      () => syncom.createDatabase({ path: 'store', fsi, logger: false }),
      (error) => {
        assert.strictEqual(error.code, 'ALX_ERR_CORRUPT');
        assert.ok(error instanceof SyncomError);
        assert.ok(error.cause instanceof SyntaxError, 'the parse error is the cause');
        return true;
      },
    );
    const chain = await new syncom.Blockchain('store/blockchain', { fsi });
    await assert.rejects(() => chain.readBlock('nope'), { code: 'ALX_ERR_BLOCK_NOT_FOUND', hash: 'nope' });
    const { privateKey } = await syncom.generateKeys();
    assert.throws(() => syncom.decrypt(JSON.stringify({ v: 2, alg: 'none' }), privateKey), {
      code: 'ALX_ERR_BAD_ENVELOPE',
      message: 'Unsupported ciphertext envelope',
    });
    const half = memory();
    await half.write('k', 'public.pem', 'x');
    await assert.rejects(() => syncom.loadKeys('k', { fsi: half }), {
      name: 'SyncomError',
      code: 'ALX_ERR_KEYS_INCOMPLETE',
    });
  });

  it('should refuse at the host with a numeric code on the wire and a reason beside it', async (t2) => {
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
    const strict = await openTemp(t2, { logger, sync: { autoStart: false, signatures: 'require' } });
    const strictLink = new MemoryLink(strict.sync.unit({ access: 'public' }));
    await assert.rejects(() => strictLink.call('syncom/hello', { node: 'peer' }), { code: 403, reason: 'UNSIGNED' });
    const logged = refusals.filter((entry) => entry.event === 'sync.hello.refused');
    assert.deepStrictEqual(
      logged.map((entry) => [entry.code, entry.reason, entry.node]),
      [
        [400, 'BAD_HELLO', null],
        [400, 'PROTOCOL', 'peer'],
        [409, 'SELF', other.nodeId],
        [403, 'UNAUTHORIZED', 'banned'],
        [403, 'UNSIGNED', 'peer'],
      ],
      '428 is only counted, every other refusal is logged with its reason',
    );
  });
});
