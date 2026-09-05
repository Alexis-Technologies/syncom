'use strict';

// Hooks: run inside the operation, can alter or abort it. Against whichever
// storage half the caller builds — `createStorage(t, name, options)` gives
// the SAME directory for the same name within one subtest (reopen cases).

const { createMesh, settle, waitUntil } = require('../utils/mesh.js');
const { MemoryLink } = require('../utils/memory-link.js');

const remoteOp = (origin, seq, type, id, extra = {}) => ({ origin, seq, ts: Date.now() + seq, type, id, ...extra });

const runHooksTests = async (t, assert, createStorage) => {
  const hookError = (hook) => ({ name: 'HookError', code: 'HOOK_FAILED', hook });

  await t.test('an unknown or malformed hook is refused at open', async (t2) => {
    await assert.rejects(() => createStorage(t2, 'bad-name', { hooks: { beforeWrtie: () => {} } }), {
      name: 'TypeError',
      message: "Storage: unknown hook 'beforeWrtie'",
    });
    await assert.rejects(() => createStorage(t2, 'bad-fn', { hooks: { afterWrite: 'nope' } }), TypeError);
    await assert.rejects(() => createStorage(t2, 'bad-shape', { hooks: 'nope' }), TypeError);
  });

  await t.test('beforeWrite sees the write and the record it lands on', async (t2) => {
    const seen = [];
    const storage = await createStorage(t2, 'A', {
      hooks: { beforeWrite: (ctx) => void seen.push({ ...ctx, current: ctx.current && { ...ctx.current } }) },
    });
    const id = await storage.insert({ title: 'a' });
    await storage.update(id, { title: 'b' });
    await storage.inc(id, 'hits', 2);
    const record = await storage.record(id);
    record.title = 'c';
    await record.save();
    await storage.delete(id);
    assert.deepStrictEqual(
      seen.map(({ type, current, data, key, value, source, encrypted }) => ({
        type,
        current,
        data,
        key,
        value,
        source: source === record ? 'record' : source,
        encrypted,
      })),
      [
        {
          type: 'write',
          current: null,
          data: { title: 'a' },
          key: undefined,
          value: undefined,
          source: null,
          encrypted: false,
        },
        {
          type: 'set',
          current: { title: 'a' },
          data: { title: 'b' },
          key: undefined,
          value: undefined,
          source: null,
          encrypted: false,
        },
        {
          type: 'inc',
          current: { title: 'b' },
          data: undefined,
          key: 'hits',
          value: 2,
          source: null,
          encrypted: false,
        },
        {
          type: 'set',
          current: { title: 'b', hits: 2 },
          data: { title: 'c' },
          key: undefined,
          value: undefined,
          source: 'record',
          encrypted: false,
        },
        {
          type: 'delete',
          current: { title: 'c', hits: 2 },
          data: undefined,
          key: undefined,
          value: undefined,
          source: null,
          encrypted: false,
        },
      ],
    );
    assert.ok(seen.every((ctx) => ctx.id === id && ctx.via === null && ctx.from === null));
  });

  await t.test('beforeWrite may replace the data of a write or a set, and only those', async (t2) => {
    const storage = await createStorage(t2, 'A', {
      hooks: {
        beforeWrite: ({ type, data }) => {
          if (type === 'inc') return { nope: true };
          return { ...data, stamped: type };
        },
      },
    });
    const ops = [];
    storage.on('change', (op) => ops.push(op));
    const original = { title: 'a' };
    const id = await storage.insert(original);
    assert.deepStrictEqual(await storage.get(id), { title: 'a', stamped: 'write' });
    assert.deepStrictEqual(original, { title: 'a' }, 'the caller’s object is untouched');
    await storage.update(id, { title: 'b' });
    assert.deepStrictEqual(await storage.get(id), { title: 'b', stamped: 'set' });
    assert.deepStrictEqual(ops.at(-1).data, { title: 'b', stamped: 'set' }, 'the op carries the replacement');
    await assert.rejects(() => storage.inc(id, 'hits'), {
      name: 'TypeError',
      message: 'beforeWrite may only replace data for write and set',
    });
    const bad = await createStorage(t2, 'B', { hooks: { beforeWrite: () => 'text' } });
    await assert.rejects(() => bad.insert({ a: 1 }), /plain object or undefined/);
  });

  await t.test('a throwing beforeWrite refuses the write: nothing stamped, logged or written', async (t2) => {
    const cause = new Error('not allowed');
    const storage = await createStorage(t2, 'A', {
      hooks: {
        beforeWrite: ({ data }) => {
          if (data?.forbidden) throw cause;
        },
      },
    });
    const id = await storage.insert({ ok: true });
    const vector = { ...storage.vector };
    const error = await storage.update(id, { forbidden: true }).then(
      () => assert.fail('should reject'),
      (e) => e,
    );
    assert.strictEqual(error.name, 'HookError');
    assert.strictEqual(error.code, 'HOOK_FAILED');
    assert.strictEqual(error.hook, 'beforeWrite');
    assert.strictEqual(error.cause, cause);
    assert.deepStrictEqual(await storage.get(id), { ok: true });
    assert.deepStrictEqual(storage.vector, vector);
    assert.strictEqual(storage.log.length, 1);
    assert.strictEqual(await storage.validate(), true);
    await assert.rejects(() => storage.insert({ forbidden: true }), hookError('beforeWrite'));
    assert.strictEqual((await storage.list()).length, 1);
  });

  await t.test('afterWrite sees the durable op; a throw fails the call but the op stays', async (t2) => {
    const seen = [];
    let fail = false;
    const storage = await createStorage(t2, 'A', {
      hooks: {
        afterWrite: (ctx, op) => {
          seen.push([ctx.type, op && op.seq, ctx.encrypted]);
          if (fail) throw new Error('after boom');
        },
      },
    });
    const changes = [];
    storage.on('change', (op) => changes.push(op.seq));
    const id = await storage.insert({ n: 1 });
    await storage.update(id, {}); // changes nothing: no afterWrite
    fail = true;
    await assert.rejects(() => storage.update(id, { n: 2 }), hookError('afterWrite'));
    assert.deepStrictEqual(await storage.get(id), { n: 2 }, 'the op is committed');
    assert.deepStrictEqual(changes, [1, 2], 'and announced');
    fail = false;
    await storage.insert({ secret: true }, { encrypted: true });
    assert.deepStrictEqual(seen, [
      ['write', 1, false],
      ['set', 2, false],
      ['write', null, true],
    ]);
  });

  await t.test('encrypted writes go through the same hooks and stay local', async (t2) => {
    const seen = [];
    const storage = await createStorage(t2, 'A', {
      encrypted: true,
      hooks: { beforeWrite: (ctx) => void seen.push([ctx.type, ctx.encrypted, ctx.current]) },
    });
    const id = await storage.insert({ s: 1 });
    await storage.update(id, { t: 2 });
    const record = await storage.record(id);
    const updates = [];
    record.on('update', (data) => updates.push(data));
    await storage.delete(id);
    assert.deepStrictEqual(seen, [
      ['write', true, null],
      ['set', true, { s: 1 }],
      ['delete', true, { s: 1, t: 2 }],
    ]);
    assert.deepStrictEqual(updates, [null]);
    assert.strictEqual(storage.log.length, 0);
    const shared = await storage.insert({ shared: true }, { encrypted: false });
    await assert.rejects(
      () => storage.set(shared, { x: 1 }, { encrypted: true }),
      /replicated and cannot become encrypted/,
    );
  });

  await t.test('a hook cannot write to the storage, but it can read', async (t2) => {
    const reads = [];
    const storage = await createStorage(t2, 'A', {
      hooks: {
        beforeWrite: async ({ id, data }) => {
          reads.push(await storage.get(id));
          if (data?.echo) await storage.update(id, { echoed: true });
        },
      },
    });
    const id = await storage.insert({ n: 1 });
    assert.deepStrictEqual(reads, [null]);
    const error = await storage.update(id, { echo: true }).catch((e) => e);
    assert.strictEqual(error.name, 'HookError');
    assert.match(error.cause.message, /inside a hook/);
    assert.deepStrictEqual(await storage.get(id), { n: 1 });
    await storage.update(id, { n: 2 });
    assert.deepStrictEqual(await storage.get(id), { n: 2 }, 'the queue is not stuck');
  });

  await t.test('beforeRead refuses, afterRead redacts — for get() and what reads through it', async (t2) => {
    let deny = false;
    const storage = await createStorage(t2, 'A', {
      hooks: {
        beforeRead: ({ id }) => {
          if (deny) throw new Error(`no ${id}`);
        },
        afterRead: (ctx, data) => {
          if (data === null || data.hidden) return data === null ? undefined : null;
          const { ssn, ...rest } = data;
          return ssn === undefined ? undefined : { ...rest, ssn: '***' };
        },
      },
    });
    const id = await storage.insert({ name: 'Ada', ssn: '123' });
    const hidden = await storage.insert({ hidden: true });
    assert.deepStrictEqual(await storage.get(id), { name: 'Ada', ssn: '***' });
    assert.deepStrictEqual(await storage.loadData(id), { name: 'Ada', ssn: '***' });
    assert.strictEqual(await storage.get(hidden), null, 'afterRead may hide a record from get');
    assert.strictEqual(await storage.has(hidden), true, 'has() is raw');
    const record = await storage.record(id);
    assert.strictEqual(record.ssn, '***', 'a Record view reads through get');
    assert.strictEqual(storage.getCachedData(id).ssn, '123', 'the cache is raw');
    const page = await storage.snapshot();
    assert.strictEqual(page.records.find((r) => r.id === id).data.ssn, '123', 'replication is raw');
    assert.strictEqual(await storage.swap(id, { name: 'Ada L.' }, { ssn: '123' }), true, 'swap compares raw');
    assert.deepStrictEqual(await storage.get(id), { name: 'Ada L.', ssn: '***' });
    deny = true;
    await assert.rejects(() => storage.get(id), hookError('beforeRead'));
    assert.strictEqual(await storage.has(id), true);
  });

  await t.test('the order of a local write', async (t2) => {
    const order = [];
    const storage = await createStorage(t2, 'A', {
      hooks: {
        beforeWrite: () => void order.push('beforeWrite'),
        afterWrite: () => void order.push('afterWrite'),
      },
    });
    const id = await storage.insert({ n: 1 });
    const record = await storage.record(id);
    record.on('update', () => order.push('update'));
    storage.on('change', () => order.push('change'));
    order.length = 0;
    await storage.update(id, { n: 2 });
    assert.deepStrictEqual(order, ['beforeWrite', 'afterWrite', 'update', 'change']);
  });
};

module.exports = { runHooksTests, remoteOp, createMesh, settle, waitUntil, MemoryLink };
