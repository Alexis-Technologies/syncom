'use strict';

// Who wrote it: the actor on the op — from the storage, from the write, or
// from nobody — and what the hooks, the peers and the log see of it.

const test = require('node:test');
const assert = require('node:assert');
const syncom = require('..');
const { packOps, unpackOps } = require('../src/ops.js');
const { createTemp, cleanupTemp } = require('./utils/temp.js');
const { createMesh, settle, waitUntil } = require('./utils/mesh.js');

const openTemp = async (t, options = {}) => {
  const dir = await createTemp();
  t.after(() => cleanupTemp(dir));
  const storage = await syncom.open({ path: dir, logger: false, ...options });
  t.after(() => storage.close().catch(() => {}));
  return storage;
};

test('Actor on ops', async (t) => {
  await t.test('a string actor rides on every op; a write may name its own; a merge carries none', async (t2) => {
    const storage = await openTemp(t2, { actor: 'ada', schema: { entities: { Post: {} } } });
    const ops = [];
    storage.on('change', (op) => ops.push(op));
    const id = await storage.insert({ n: 1 });
    await storage.update(id, { n: 2 });
    await storage.inc(id, 'hits', 1, { actor: 'bob' });
    await storage.swap(id, { n: 3 }, { n: 2 }, { actor: 'cy' });
    const post = await storage.Post.insert({ title: 'a' }, { actor: 'dee' });
    await storage.Post.update(post.id, { title: 'b' }, { actor: 'eve' });
    const record = await storage.record(id);
    record.n = 4;
    await record.save({ actor: 'fay' });
    await record.inc('hits', 1, { actor: 'gus' });
    await record.delete({ actor: 'hal' });
    await storage.Post.delete(post.id, { actor: 'ivy' });
    assert.deepStrictEqual(
      ops.map((op) => [op.type, op.actor]),
      [
        ['write', 'ada'],
        ['set', 'ada'],
        ['inc', 'bob'],
        ['set', 'cy'],
        ['write', 'dee'],
        ['set', 'eve'],
        ['set', 'fay'],
        ['inc', 'gus'],
        ['delete', 'hal'],
        ['delete', 'ivy'],
      ],
    );
    assert.strictEqual('actor' in ((await storage.get(post.id)) ?? {}), false, 'never in the record');
    const page = await storage.snapshot();
    assert.strictEqual(
      page.records.some((r) => 'actor' in r.meta),
      false,
      'nor in the meta',
    );
    await storage.mergeSnapshot([{ id: 'from-peer', data: { x: 1 }, meta: page.records[0].meta }]);
    assert.strictEqual(ops.at(-1).type, 'merge');
    assert.strictEqual(ops.at(-1).actor, undefined);
  });

  await t.test('a function actor is asked per write; none means no actor; the shape is checked', async (t2) => {
    let n = 0;
    const storage = await openTemp(t2, { actor: async () => `u${++n}` });
    const ops = [];
    storage.on('change', (op) => ops.push(op));
    const id = await storage.insert({ a: 1 });
    await storage.update(id, { a: 2 });
    await storage.update(id, { a: 3 }, { actor: 'fixed' });
    assert.deepStrictEqual(
      ops.map((op) => op.actor),
      ['u1', 'u2', 'fixed'],
    );
    const seen = [];
    const plain = await openTemp(t2, { hooks: { beforeWrite: (ctx) => void seen.push(ctx.actor) } });
    const plainOps = [];
    plain.on('change', (op) => plainOps.push(op));
    const other = await plain.insert({ a: 1 });
    await plain.update(other, { a: 2 }, { actor: 'once' });
    assert.deepStrictEqual(seen, [null, 'once']);
    assert.deepStrictEqual(
      plainOps.map((op) => op.actor),
      [undefined, 'once'],
    );
    assert.strictEqual('actor' in packOps(plainOps)[0] ? 1 : packOps(plainOps)[0][13], null);
    await assert.rejects(async () => syncom.open({ path: 'x', actor: 42 }), {
      name: 'TypeError',
      message: 'open({ actor }): actor must be a string or a function',
    });
  });

  await t.test(
    'a peer sees the actor in change and beforeApply, and keeps it in its log; it is a claim',
    async (t2) => {
      const dirs = new Map();
      const createStorage = async (t3, name, options = {}) => {
        const key = `${t3.name}:${name}`;
        if (!dirs.has(key)) {
          dirs.set(key, await createTemp());
          t3.after(() => cleanupTemp(dirs.get(key)));
        }
        const storage = await syncom.open({ path: dirs.get(key), logger: false, ...options });
        t3.after(() => storage.close().catch(() => {}));
        return storage;
      };
      const seen = [];
      const mesh = await createMesh(t2, ['A', 'B'], [['A', 'B']], createStorage, {
        nodes: {
          A: { actor: 'ada' },
          B: { hooks: { beforeApply: ({ op }) => void seen.push(op.actor) } },
        },
      });
      const [a, b] = ['A', 'B'].map((name) => mesh.get(name));
      await waitUntil(() => a.sync.peers()[0]?.subscribed);
      const changes = [];
      b.on('change', (op, via) => via !== null && changes.push(op.actor));
      const id = await a.insert({ n: 1 });
      await a.update(id, { n: 2 }, { actor: 'bob' });
      await settle([a, b]);
      assert.deepStrictEqual(seen, ['ada', 'bob']);
      assert.deepStrictEqual(changes, ['ada', 'bob']);
      assert.deepStrictEqual(
        b.log.since(undefined).map((entry) => entry.op.actor),
        ['ada', 'bob'],
      );
      // Whatever a peer puts there is taken as it is — a claim, not a check.
      const result = await b.applyRemote([
        { origin: 'peer', seq: 1, ts: Date.now() + 1, type: 'write', id: 'p', data: { n: 1 }, actor: 7 },
      ]);
      assert.strictEqual(result.applied, 1);
      assert.strictEqual(b.log.since(undefined).at(-1).op.actor, 7);
      assert.deepStrictEqual(unpackOps(packOps(b.log.since(undefined).map((e) => e.op))).at(-1).actor, 7);
    },
  );
});
