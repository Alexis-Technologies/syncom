'use strict';

// Hooks: run inside the operation, can alter or abort it. Against whichever
// storage half the caller builds — `createStorage(t, name, options)` gives
// the SAME directory for the same name within one subtest (reopen cases).

const { createMesh, settle, waitUntil } = require('../utils/mesh.js');
const { MemoryLink } = require('../utils/memory-link.js');
const { packOps } = require('../../src/ops.js');

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
    await storage.add(id, 'tags', ['x']);
    await storage.remove(id, 'tags', ['x']);
    await storage.splice(id, 'body', 0, 0, 'hi');
    await storage.treeMove(id, 'outline', 'n');
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
          type: 'add',
          current: { title: 'b', hits: 2 },
          data: undefined,
          key: 'tags',
          value: ['x'],
          source: null,
          encrypted: false,
        },
        {
          type: 'remove',
          current: { title: 'b', hits: 2, tags: ['x'] },
          data: undefined,
          key: 'tags',
          value: ['x'],
          source: null,
          encrypted: false,
        },
        {
          type: 'splice',
          current: { title: 'b', hits: 2, tags: [] },
          data: undefined,
          key: 'body',
          value: undefined,
          source: null,
          encrypted: false,
        },
        {
          type: 'tree',
          current: { title: 'b', hits: 2, tags: [], body: 'hi' },
          data: undefined,
          key: 'outline',
          value: undefined,
          source: null,
          encrypted: false,
        },
        {
          type: 'set',
          current: { title: 'b', hits: 2, tags: [], body: 'hi', outline: [{ id: 'n', children: [] }] },
          data: { title: 'c' },
          key: undefined,
          value: undefined,
          source: 'record',
          encrypted: false,
        },
        {
          type: 'delete',
          current: { title: 'c', hits: 2, tags: [], body: 'hi', outline: [{ id: 'n', children: [] }] },
          data: undefined,
          key: undefined,
          value: undefined,
          source: null,
          encrypted: false,
        },
      ],
    );
    assert.ok(seen.every((ctx) => ctx.id === id && ctx.via === null && ctx.from === null));
    // A splice's context carries the call as the caller made it.
    const splice = seen.find((ctx) => ctx.type === 'splice');
    assert.deepStrictEqual([splice.index, splice.count, splice.content], [0, 0, 'hi']);
    const tree = seen.find((ctx) => ctx.type === 'tree');
    assert.deepStrictEqual([tree.node, tree.parent, tree.after, tree.before], ['n', null, undefined, undefined]);
  });

  await t.test('beforeWrite may replace the data of a write or a set, and only those', async (t2) => {
    const storage = await createStorage(t2, 'A', {
      hooks: {
        beforeWrite: ({ type, data }) => {
          if (type === 'inc' || type === 'add' || type === 'splice') return { nope: true };
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
    await assert.rejects(() => storage.add(id, 'tags', ['x']), {
      name: 'TypeError',
      message: 'beforeWrite may only replace data for write and set',
    });
    await assert.rejects(() => storage.splice(id, 'body', 0, 0, 'x'), {
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
    // …and after a change too: the refresh reads as get() does, once the write is done.
    const refreshed = new Promise((resolve) => record.once('update', () => resolve()));
    await storage.update(id, { name: 'Ada L.' });
    await refreshed;
    assert.deepStrictEqual([record.name, record.ssn], ['Ada L.', '***'], 'a changed Record is redacted still');
    assert.strictEqual(storage.getCachedData(id).ssn, '123', 'the cache is raw');
    const page = await storage.snapshot();
    assert.strictEqual(page.records.find((r) => r.id === id).data.ssn, '123', 'replication is raw');
    assert.strictEqual(await storage.swap(id, { name: 'Ada L.' }, { ssn: '123' }), true, 'swap compares raw');
    assert.deepStrictEqual(await storage.get(id), { name: 'Ada L.', ssn: '***' });
    deny = true;
    await assert.rejects(() => storage.get(id), hookError('beforeRead'));
    assert.strictEqual(await storage.has(id), true);
  });

  await t.test('beforeApply(false) skips an op here: logged, relayed, replay-safe', async (t2) => {
    const seen = [];
    let storage = await createStorage(t2, 'A', {
      hooks: {
        beforeApply: (ctx) => {
          seen.push({ ...ctx, current: ctx.current && { ...ctx.current } });
          if (ctx.op.data?.secret) return false;
        },
      },
    });
    const changes = [];
    const applies = [];
    storage.on('change', (op) => changes.push(op.seq));
    storage.on('apply', (batch) => applies.push(batch));
    const first = await storage.applyRemote(
      [
        remoteOp('peer', 1, 'write', 'r1', { data: { secret: true } }),
        remoteOp('peer', 2, 'write', 'r2', { data: { n: 2 } }),
      ],
      { via: 'L', peer: { url: 'mem://peer', node: 'peer' } },
    );
    assert.deepStrictEqual(first, {
      applied: 2,
      skipped: 1,
      duplicates: 0,
      gaps: 0,
      malformed: 0,
      unsigned: 0,
      forged: 0,
      outOfScope: 0,
    });
    assert.strictEqual(await storage.get('r1'), null, 'the skipped op did not touch the record');
    assert.deepStrictEqual(await storage.get('r2'), { n: 2 });
    assert.strictEqual(storage.vector.peer, 2, 'but moved the vector');
    assert.strictEqual(storage.log.length, 2, 'and is in the log');
    assert.deepStrictEqual(changes, [1, 2], 'and was announced');
    assert.deepStrictEqual(applies.length, 1);
    assert.deepStrictEqual(applies[0].peer, { url: 'mem://peer', node: 'peer' });
    assert.strictEqual(applies[0].ops.length, 2);
    assert.deepStrictEqual(
      seen.map(({ op, via, peer, current }) => [op.seq, via, peer.node, current]),
      [
        [1, 'L', 'peer', null],
        [2, 'L', 'peer', null],
      ],
    );
    // The next op of that origin is not a gap.
    const next = await storage.applyRemote([remoteOp('peer', 3, 'set', 'r2', { data: { n: 3 } })]);
    assert.strictEqual(next.applied, 1);
    assert.deepStrictEqual(seen.at(-1).current, { n: 2 });
    // A reopen replays the unsealed tail — and leaves the skipped op alone.
    await storage.close();
    storage = await createStorage(t2, 'A');
    assert.strictEqual(await storage.get('r1'), null);
    assert.deepStrictEqual(await storage.get('r2'), { n: 3 });
    assert.strictEqual(storage.vector.peer, 3);
  });

  await t.test('a throwing beforeApply aborts the batch before anything is durable', async (t2) => {
    const storage = await createStorage(t2, 'A', {
      hooks: {
        beforeApply: ({ op }) => {
          if (op.seq === 2) throw new Error('refused');
        },
      },
    });
    await assert.rejects(
      () =>
        storage.applyRemote([
          remoteOp('peer', 1, 'write', 'r1', { data: { n: 1 } }),
          remoteOp('peer', 2, 'write', 'r2', { data: { n: 2 } }),
        ]),
      hookError('beforeApply'),
    );
    assert.strictEqual(storage.log.length, 0);
    assert.deepStrictEqual(storage.vector, {});
    assert.strictEqual(await storage.get('r1'), null, 'the op before the throw was not persisted either');
    assert.strictEqual(await storage.has('r1'), false);
  });

  await t.test('afterApply sees the durable batch; a throw fails the call but the batch stays', async (t2) => {
    const batches = [];
    const storage = await createStorage(t2, 'A', {
      hooks: {
        afterApply: (batch) => {
          batches.push(batch);
          if (batch.applied > 0) throw new Error('after boom');
        },
      },
    });
    const events = [];
    storage.on('apply', (batch) => events.push(batch.applied));
    await assert.rejects(
      () => storage.applyRemote([remoteOp('peer', 1, 'write', 'r1', { data: { n: 1 } })]),
      hookError('afterApply'),
    );
    assert.deepStrictEqual(await storage.get('r1'), { n: 1 }, 'the batch is committed');
    assert.deepStrictEqual(events, [1], 'and announced');
    const empty = await storage.applyRemote([remoteOp('peer', 1, 'write', 'r1', { data: { n: 1 } })]);
    assert.deepStrictEqual(empty, {
      applied: 0,
      skipped: 0,
      duplicates: 1,
      gaps: 0,
      malformed: 0,
      unsigned: 0,
      forged: 0,
      outOfScope: 0,
    });
    assert.strictEqual(batches.length, 2, 'an empty batch runs the hook too');
    assert.deepStrictEqual(batches[1].ops, []);
    assert.deepStrictEqual(events, [1, 0]);
  });

  await t.test('a skip is local: the op still reaches the peers behind this node', async (t2) => {
    const mesh = await createMesh(
      t2,
      ['A', 'B', 'C'],
      [
        ['B', 'A'],
        ['C', 'B'],
      ],
      createStorage,
      { nodes: { B: { hooks: { beforeApply: ({ op }) => (op.data?.secret ? false : undefined) } } } },
    );
    const a = mesh.get('A');
    const b = mesh.get('B');
    const c = mesh.get('C');
    const secret = await a.insert({ secret: true });
    const plain = await a.insert({ plain: true });
    await settle([a, b, c]);
    assert.strictEqual(await b.get(secret), null, 'B skipped it');
    assert.deepStrictEqual(await b.get(plain), { plain: true });
    assert.deepStrictEqual(await c.get(secret), { secret: true }, 'C, behind B, still got it');
    assert.deepStrictEqual(await c.get(plain), { plain: true });
  });

  await t.test('the hosting side runs beforeApply for a pushed page', async (t2) => {
    const seen = [];
    let refuse = false;
    const host = await createStorage(t2, 'H', {
      hooks: {
        beforeApply: (ctx) => {
          seen.push(ctx.peer);
          if (refuse) throw new Error('not here');
          return ctx.op.data?.secret ? false : undefined;
        },
      },
    });
    const unit = host.sync.unit({ access: 'public' });
    const link = new MemoryLink(unit);
    await link.call('syncom/hello', { node: 'peer', version: 1 });
    const answer = await link.call('syncom/push', {
      ops: packOps([remoteOp('peer', 1, 'write', 'r1', { data: { secret: true } })]),
    });
    assert.strictEqual(answer.applied, 1);
    assert.strictEqual(answer.skipped, 1);
    assert.deepStrictEqual(answer.vector, { peer: 1 });
    assert.deepStrictEqual(seen, [{ url: null, node: 'peer' }]);
    refuse = true;
    await assert.rejects(
      () => link.call('syncom/push', { ops: packOps([remoteOp('peer', 2, 'write', 'r2', { data: {} })]) }),
      /beforeApply hook failed: not here/,
    );
    assert.deepStrictEqual(host.vector, { peer: 1 });
  });

  await t.test('a peer whose page is refused hears about it as an error, and recovers', async (t2) => {
    let refuse = true;
    const host = await createStorage(t2, 'H', {
      hooks: {
        beforeApply: () => {
          if (refuse) throw new Error('not yet');
        },
      },
    });
    const unit = host.sync.unit({ access: 'public' });
    const dialer = await createStorage(t2, 'D', { sync: { autoStart: false, connect: () => new MemoryLink(unit) } });
    const errors = [];
    dialer.sync.on('error', (error) => errors.push(error));
    await dialer.sync.addNode({ url: 'mem://host' });
    const id = await dialer.insert({ n: 1 });
    await dialer.sync.start();
    await waitUntil(() => errors.length > 0);
    assert.match(errors[0].message, /beforeApply hook failed: not yet/);
    assert.strictEqual(errors[0].url, 'mem://host');
    assert.strictEqual(await host.get(id), null);
    refuse = false;
    await dialer.sync.sync();
    await settle([host, dialer]);
    assert.deepStrictEqual(await host.get(id), { n: 1 });
  });

  await t.test('sync hooks are refused at open like storage hooks', async (t2) => {
    await assert.rejects(() => createStorage(t2, 'bad', { sync: { hooks: { beforeSned: () => {} } } }), {
      name: 'TypeError',
      message: "SyncManager: unknown hook 'beforeSned'",
    });
  });

  await t.test('beforeConnect(false) leaves a node registered but not dialled', async (t2) => {
    const host = await createStorage(t2, 'H');
    const unit = host.sync.unit({ access: 'public' });
    const seen = [];
    let dialled = 0;
    let refuse = true;
    const dialer = await createStorage(t2, 'D', {
      sync: {
        autoStart: false,
        connect: () => {
          dialled++;
          return new MemoryLink(unit);
        },
        hooks: {
          beforeConnect: (node) => {
            seen.push(node);
            if (refuse) return false;
          },
        },
      },
    });
    const errors = [];
    dialer.sync.on('error', (error) => errors.push(error));
    await dialer.sync.addNode({ url: 'mem://host', scopes: ['*'] });
    await dialer.sync.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.strictEqual(dialled, 0);
    assert.deepStrictEqual(dialer.sync.peers(), []);
    assert.deepStrictEqual(errors, []);
    assert.strictEqual(dialer.sync.listNodes().length, 1);
    assert.strictEqual(seen[0].url, 'mem://host');
    assert.deepStrictEqual(seen[0].scopes, ['*']);
    // Enabling again re-asks; this time it is allowed.
    refuse = false;
    await dialer.sync.enableNode('mem://host', false);
    await dialer.sync.enableNode('mem://host');
    await waitUntil(() => dialer.sync.peers()[0]?.subscribed);
    assert.strictEqual(dialled, 1);
  });

  await t.test('a throwing beforeConnect is reported as an error, not thrown', async (t2) => {
    const errors = [];
    const dialer = await createStorage(t2, 'D', {
      sync: {
        autoStart: false,
        connect: () => assert.fail('never dialled'),
        hooks: {
          beforeConnect: () => {
            throw new Error('no dialling today');
          },
        },
      },
    });
    dialer.sync.on('error', (error) => errors.push(error));
    await dialer.sync.addNode({ url: 'mem://host' });
    await dialer.sync.start();
    await waitUntil(() => errors.length > 0);
    assert.strictEqual(errors[0].name, 'HookError');
    assert.strictEqual(errors[0].hook, 'beforeConnect');
    assert.strictEqual(errors[0].url, 'mem://host');
  });

  await t.test('beforeBootstrap may refuse to join a peer’s state', async (t2) => {
    // A host whose log cannot resume a newcomer: the feed says bootstrap.
    const host = await createStorage(t2, 'H', { sync: { log: { rollAfter: 2 }, retention: { ops: 4 } } });
    for (let i = 0; i < 8; i++) await host.insert({ i });
    const unit = host.sync.unit({ access: 'public' });
    const seen = [];
    let refuse = true;
    const dialer = await createStorage(t2, 'D', {
      sync: {
        autoStart: false,
        connect: () => new MemoryLink(unit),
        hooks: {
          beforeBootstrap: (peer) => {
            seen.push(peer);
            if (refuse === 'throw') throw new Error('not from you');
            if (refuse) return false;
          },
        },
      },
    });
    const bootstraps = [];
    const errors = [];
    dialer.sync.on('bootstrap', (event) => bootstraps.push(event));
    dialer.sync.on('error', (error) => errors.push(error));
    await dialer.sync.addNode({ url: 'mem://host' });
    await dialer.sync.start();
    await waitUntil(() => seen.length > 0);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepStrictEqual(seen, [{ url: 'mem://host', node: host.nodeId }]);
    assert.deepStrictEqual(bootstraps, []);
    assert.deepStrictEqual(await dialer.list(), [], 'nothing was joined');
    const [peer] = dialer.sync.peers();
    assert.strictEqual(peer.connected, true, 'still connected');
    assert.strictEqual(peer.subscribed, false, 'but receiving nothing');
    const mine = await dialer.insert({ mine: true });
    await waitUntil(async () => (await host.get(mine)) !== null);
    assert.deepStrictEqual(await host.get(mine), { mine: true }, 'pushes still flow');
    // A throw is reported like any other failure on the way in.
    refuse = 'throw';
    await dialer.sync.enableNode('mem://host', false);
    await dialer.sync.enableNode('mem://host');
    await waitUntil(() => errors.length > 0);
    assert.strictEqual(errors[0].name, 'HookError');
    assert.strictEqual(errors[0].hook, 'beforeBootstrap');
    // Allowed: the next handshake bootstraps.
    refuse = false;
    await dialer.sync.enableNode('mem://host', false);
    await dialer.sync.enableNode('mem://host');
    await waitUntil(() => bootstraps.length > 0);
    await settle([host, dialer]);
    assert.strictEqual((await dialer.list()).length, 9);
  });

  await t.test('the manager announces its lifecycle', async (t2) => {
    const host = await createStorage(t2, 'H');
    const hellos = [];
    host.sync.on('hello', (event) => hellos.push(event));
    const unit = host.sync.unit({ access: 'public' });
    const dialer = await createStorage(t2, 'D', { sync: { autoStart: false, connect: () => new MemoryLink(unit) } });
    const events = [];
    for (const name of ['start', 'stop', 'node', 'connect', 'peer']) {
      dialer.sync.on(name, (payload) => events.push([name, payload]));
    }
    await dialer.sync.addNode({ url: 'mem://host', scopes: ['docs'] });
    await dialer.sync.start();
    await waitUntil(() => dialer.sync.peers()[0]?.subscribed);
    await dialer.sync.enableNode('mem://host', false);
    await dialer.sync.enableNode('mem://host');
    await waitUntil(() => dialer.sync.peers()[0]?.subscribed);
    await dialer.sync.removeNode('mem://host');
    await dialer.sync.stop();
    assert.deepStrictEqual(
      events.filter(([name]) => name !== 'peer'),
      [
        ['node', { url: 'mem://host', action: 'add' }],
        ['start', undefined],
        ['connect', { url: 'mem://host' }],
        ['node', { url: 'mem://host', action: 'disable' }],
        ['node', { url: 'mem://host', action: 'enable' }],
        ['connect', { url: 'mem://host' }],
        ['node', { url: 'mem://host', action: 'remove' }],
        ['stop', undefined],
      ],
    );
    assert.deepStrictEqual(hellos, [
      { node: dialer.nodeId, scopes: ['docs'], schema: null },
      { node: dialer.nodeId, scopes: ['docs'], schema: null },
    ]);
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
  await runReadHookQueueTests(t, assert, createStorage);
};

module.exports = { runHooksTests, remoteOp, createMesh, settle, waitUntil, MemoryLink };

const runReadHookQueueTests = async (t, assert, createStorage) => {
  await t.test('read hooks run outside the queue: a write from one queues, a slow one holds no write', async (t2) => {
    let release = null;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    const echoes = [];
    const storage = await createStorage(t2, 'A', {
      hooks: {
        afterRead: async ({ id }, data) => {
          if (data?.slow) await held;
          // Once per record: a later read of the echoed record queues nothing,
          // so no write is left running behind the test.
          if (data?.echo && !data.echoed) echoes.push(storage.update(id, { echoed: true }));
          return undefined;
        },
      },
    });
    const slow = await storage.insert({ slow: true });
    const other = await storage.insert({ n: 1 });
    const reading = storage.get(slow);
    // A write while a read hook is pending is not "a write from inside a hook".
    await storage.update(other, { n: 2 });
    assert.deepStrictEqual(await storage.get(other), { n: 2 });
    release();
    assert.deepStrictEqual(await reading, { slow: true });
    // A write issued from a read hook lands after the read that issued it.
    const echo = await storage.insert({ echo: true });
    assert.deepStrictEqual(await storage.get(echo), { echo: true });
    await Promise.all(echoes);
    assert.deepStrictEqual(await storage.get(echo), { echo: true, echoed: true });
  });
};
