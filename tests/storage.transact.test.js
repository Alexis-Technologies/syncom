'use strict';

// Transactions (src/commit.js transact): several writes appended as one
// group and landed as one batch — all or none, in order, the events after —
// with a message on every op, in the signed header.

const test = require('node:test');
const assert = require('node:assert');
const syncom = require('../src/all/all.js');
const { memory } = require('../src/memory/memory.js');
const { openGroups } = require('./utils/groups.js');

const open = async (t, options = {}) => {
  const storage = await syncom.open({ path: '/t', fsi: memory(), logger: false, ...options });
  t.after(() => storage.close().catch(() => {}));
  return storage;
};

test('transactions', async (t) => {
  await t.test(
    'transact() lands its ops as one append: all or none, one log file, the events after; a throw or a refusal leaves nothing',
    async (t2) => {
      const storage = await open(t2, { defer: 0 });
      const events = [];
      const changes = [];
      const turns = [];
      storage.on('commit', (event) => events.push(event));
      storage.on('change', (op) => changes.push(op));
      storage.on('transaction', (event) => turns.push(event));
      const other = await storage.insert({ n: 0 });
      const logged = storage.log.length;
      const files = await openGroups(storage.fsi, '/t/log/open');
      const source = { tag: 'editor' };
      let seen;
      const id = await storage.transact(
        async (tx) => {
          const id = await tx.insert({ title: 'a' });
          await tx.update(id, { n: 1 });
          await tx.inc(id, 'hits', 2);
          await tx.add(id, 'tags', ['x']);
          await tx.push(id, 'items', [1, 2]);
          await tx.splice(id, 'body', 0, 0, 'hi');
          await tx.mark(id, 'body', 0, 2, 'bold', true);
          await tx.treeMove(id, 'outline', 'r');
          await tx.update(other, { n: 1 });
          await tx.unset(other, 'n');
          seen = [await tx.get(id), await tx.has(id), await tx.has('nope')];
          // Nothing of it is written while it runs: the log and the events wait.
          assert.strictEqual(storage.log.length, logged);
          assert.strictEqual(events.length, 1);
          return id;
        },
        { message: 'first', source },
      );
      assert.deepStrictEqual(seen, [
        { title: 'a', n: 1, hits: 2, tags: ['x'], items: [1, 2], body: 'hi', outline: [{ id: 'r', children: [] }] },
        true,
        false,
      ]);
      assert.strictEqual(storage.log.length - logged, 10, 'every write is one op');
      assert.strictEqual((await openGroups(storage.fsi, '/t/log/open')) - files, 1, 'one group');
      assert.deepStrictEqual(await storage.get(id), seen[0]);
      assert.deepStrictEqual(await storage.get(other), {});
      assert.strictEqual(storage.stats().inflight, 0);
      assert.strictEqual(await storage.validate(), true);
      // The commit events: once landed, in op order, the message and the source on each.
      const mine = events.slice(1);
      assert.deepStrictEqual(
        mine.map((event) => event.op.type),
        ['write', 'set', 'inc', 'add', 'splice', 'splice', 'mark', 'tree', 'set', 'unset'],
      );
      assert.deepStrictEqual(
        mine.map((event) => event.seq),
        Array.from({ length: 10 }, (_, i) => mine[0].seq + i),
        'consecutive positions',
      );
      assert.ok(mine.every((event) => event.op.msg === 'first' && event.source === source));
      assert.ok(
        mine.every((event) => event.txn === mine[0].seq),
        'one transaction: one txn',
      );
      assert.strictEqual(events[0].txn, events[0].seq, 'a single write: its own seq');
      assert.deepStrictEqual(mine[2].changes, [{ action: 'inc', field: 'hits', value: 2 }]);
      assert.ok(changes.slice(1).every((op) => op.msg === 'first'));
      // One transaction event, after the commit events, every change tagged by its record.
      assert.strictEqual(turns.length, 2);
      const [, turn] = turns;
      assert.deepStrictEqual(
        [turn.local, turn.via, turn.source, turn.message, turn.ops.length, turn.ts],
        [true, null, source, 'first', 10, turn.ops[9].ts],
      );
      assert.deepStrictEqual(
        turn.changes.map((change) => [change.id === id ? 'id' : 'other', change.action]),
        [
          ['id', 'put'],
          ['id', 'put'],
          ['id', 'inc'],
          ['id', 'add'],
          ['id', 'splice'],
          ['id', 'splice'],
          ['id', 'mark'],
          ['id', 'treeMove'],
          ['other', 'put'],
          ['other', 'unset'],
        ],
      );
      const { versions } = await storage.history(id);
      assert.deepStrictEqual(
        versions.map((version) => version.message),
        Array(8).fill('first'),
      );
      assert.strictEqual((await storage.history(other)).versions[0].message, 'first');
      // A throw: nothing appended, the records as they were.
      const before = storage.log.length;
      await assert.rejects(
        () =>
          storage.transact(async (tx) => {
            await tx.update(id, { n: 2 });
            await tx.insert({ x: 1 });
            await tx.delete(other);
            throw new Error('changed my mind');
          }),
        /changed my mind/,
      );
      assert.strictEqual(storage.log.length, before);
      assert.strictEqual((await storage.get(id)).n, 1);
      assert.strictEqual(await storage.has(other), true);
      assert.deepStrictEqual((await storage.list()).length, 2);
      // A write the engine refuses: the same.
      await assert.rejects(
        () =>
          storage.transact(async (tx) => {
            await tx.update(id, { n: 3 });
            await tx.splice(id, 'body', 99, 0, 'x');
          }),
        { code: 'OUT_OF_RANGE' },
      );
      assert.strictEqual(storage.log.length, before);
      assert.strictEqual((await storage.get(id)).n, 1);
      assert.strictEqual(storage.stats().inflight, 0);
      assert.strictEqual(events.length, 11, 'no event for what was not written');
      // Nothing written: no op, fn's value back; swap and delete inside; a Record follows.
      assert.strictEqual(await storage.transact(() => 42), 42);
      assert.strictEqual(storage.log.length, before);
      const record = await storage.record(id);
      const swapped = await storage.transact(async (tx) => {
        const ok = await tx.swap(id, { n: 10 }, { n: 1 });
        const no = await tx.swap(id, { n: 11 }, { n: 1 });
        await tx.delete(other);
        return [ok, no];
      });
      assert.deepStrictEqual(swapped, [true, false]);
      assert.strictEqual(record.n, 10);
      assert.strictEqual(await storage.has(other), false);
      // Arguments and refusals: not a function, a message too long, purge, an encrypted write.
      await assert.rejects(() => storage.transact('x'), TypeError);
      await assert.rejects(() => storage.transact(() => {}, { message: 'x'.repeat(1025) }), TypeError);
      await assert.rejects(() => storage.transact((tx) => tx.purge(id)), /not transactional/);
      await assert.rejects(() => storage.transact((tx) => tx.get('bad id!')), { code: 'INVALID_ID' });
      await assert.rejects(() => storage.transact((tx) => tx.update('absent', { n: 1 })), { code: 'NOT_FOUND' });
      await assert.rejects(() => storage.transact((tx) => tx.set(id, 'no')), TypeError);
      const sealed = await storage.insert({ secret: 1 }, { encrypted: true });
      await assert.rejects(() => storage.transact((tx) => tx.update(sealed, { secret: 2 })), { code: 'ENCRYPTED' });
      assert.deepStrictEqual(await storage.get(sealed), { secret: 1 });
      assert.strictEqual(await storage.validate(), true);
    },
  );

  await t.test(
    'applyPatches() is a transaction: a validator refusing a later op leaves nothing written',
    async (t2) => {
      const storage = await open(t2, {
        defer: 0,
        schema: {
          entities: {
            Post: {
              fields: { title: 'string', n: 'number' },
              schema: {
                '~standard': {
                  version: 1,
                  vendor: 'test',
                  validate: (data) => (data.n === 13 ? { issues: [{ message: 'unlucky' }] } : { value: data }),
                },
              },
            },
          },
        },
      });
      const id = await storage.insert({ $type: 'Post', title: 'a', n: 1 });
      const logged = storage.log.length;
      const events = [];
      storage.on('commit', (event) => events.push(event));
      await assert.rejects(
        () =>
          storage.applyPatches(id, [
            { action: 'put', field: 'title', value: 'b' },
            { action: 'put', field: 'n', value: 13 },
          ]),
        (error) => error.name === 'ValidationError' && /unlucky/.test(JSON.stringify(error.issues)),
      );
      assert.strictEqual(storage.log.length, logged, 'nothing appended');
      assert.deepStrictEqual(await storage.get(id), { $type: 'Post', title: 'a', n: 1 });
      assert.strictEqual(events.length, 0);
      assert.strictEqual(storage.stats().inflight, 0);
      // With a message: on every op of the batch.
      assert.strictEqual(
        await storage.applyPatches(
          id,
          [
            { action: 'put', field: 'title', value: 'b' },
            { action: 'put', field: 'n', value: 2 },
          ],
          { message: 'two puts' },
        ),
        2,
      );
      assert.deepStrictEqual(
        events.map((event) => [event.op.type, event.op.msg]),
        [
          ['set', 'two puts'],
          ['set', 'two puts'],
        ],
      );
    },
  );

  await t.test(
    'a transaction under defer lands at the flush; its message reaches a peer in the signed header, a changed one is forged',
    async (t2) => {
      const a = await open(t2);
      const b = await syncom.open({ path: '/b', fsi: memory(), logger: false, sync: { signatures: 'require' } });
      t2.after(() => b.close().catch(() => {}));
      const id = await a.transact(
        async (tx) => {
          const id = await tx.insert({ title: 'deferred' });
          await tx.splice(id, 'body', 0, 0, 'text');
          return id;
        },
        { message: 'over the wire' },
      );
      assert.ok(a.stats().deferred >= 1, 'the files wait for the flush');
      await a.flush();
      assert.strictEqual(a.stats().deferred, 0);
      assert.deepStrictEqual(await a.get(id), { title: 'deferred', body: 'text' });
      const ops = a.log.since(null).map((entry) => entry.op);
      assert.ok(ops.every((op) => op.msg === 'over the wire' && typeof op.sig === 'string'));
      const result = await b.applyRemote(ops.map((op) => ({ ...op })));
      assert.deepStrictEqual([result.applied, result.forged], [2, 0]);
      assert.deepStrictEqual(await b.get(id), { title: 'deferred', body: 'text' });
      assert.deepStrictEqual(
        (await b.history(id)).versions.map((version) => version.message),
        ['over the wire', 'over the wire'],
      );
      // A message changed on the way is a forged op: the header no longer verifies.
      const errors = [];
      b.on('error', (error) => errors.push(error.code));
      const more = await a.transact((tx) => tx.update(id, { title: 'again' }), { message: 'signed' });
      void more;
      const [op] = a.log
        .since(null)
        .slice(-1)
        .map((entry) => ({ ...entry.op, msg: 'tampered' }));
      const refused = await b.applyRemote([op]);
      assert.deepStrictEqual([refused.applied, refused.forged], [0, 1]);
      assert.deepStrictEqual(errors, ['BAD_SIGNATURE']);
      assert.strictEqual((await b.get(id)).title, 'deferred');
      // A peer's message past the bound is malformed.
      const long = { ...a.log.since(null).at(-1).op, msg: 'x'.repeat(1025) };
      delete long.sig;
      assert.strictEqual(
        (
          await syncom.open({ path: '/c', fsi: memory(), logger: false }).then(async (c) => {
            const out = await c.applyRemote([long]);
            await c.close();
            return out;
          })
        ).malformed,
        1,
      );
    },
  );

  await t.test(
    'a transaction refreshes a live Record once per record, with the delta of all its ops; each op still has its commit event',
    async (t2) => {
      for (const defer of [0, 16]) {
        const storage = await open(t2, { defer, path: `/refresh-${defer}` });
        const id = await storage.insert({ a: 0, b: 0 });
        const record = await storage.record(id);
        const updates = [];
        record.on('update', (data, delta) => updates.push([{ ...data }, Object.keys(delta).sort()]));
        const commits = [];
        storage.on('commit', (event) => commits.push([event.before?.a ?? null, event.after?.a ?? null]));
        await storage.transact(async (tx) => {
          await tx.update(id, { a: 1 });
          await tx.update(id, { b: 2 });
          await tx.update(id, { a: 3 });
        });
        assert.deepStrictEqual(updates, [[{ a: 3, b: 2 }, ['a', 'b']]], `defer ${defer}: one refresh`);
        assert.deepStrictEqual(
          commits,
          [
            [0, 1],
            [1, 1],
            [1, 3],
          ],
          'every op its own before and after',
        );
        assert.deepStrictEqual(await storage.get(id), { a: 3, b: 2 });
      }
    },
  );

  await t.test('a transaction of many ops on one large record holds the record once, not once per op', async (t2) => {
    // gc through the flag set at run time: the heap is read after a collection.
    require('node:v8').setFlagsFromString('--expose-gc');
    const gc = require('node:vm').runInNewContext('gc');
    const storage = await open(t2, { defer: 0, path: '/large' });
    const id = await storage.insert({ title: 't' });
    gc();
    const before = process.memoryUsage().heapUsed;
    let held = 0;
    await storage.transact(async (tx) => {
      // 600 tree moves: every version of the tree is a fresh reading of up to 600 nodes, and its fold.
      for (let i = 0; i < 600; i++) await tx.treeMove(id, 'outline', `n${i}`, i === 0 ? null : `n${i >> 1}`);
      gc();
      held = process.memoryUsage().heapUsed - before;
    });
    // Held per op, every version: some 80 MB; held once: a few.
    assert.ok(held < 20e6, `${(held / 1e6).toFixed(1)} MB held by the transaction`);
    assert.strictEqual((await storage.get(id)).outline.length, 1);
  });
});
