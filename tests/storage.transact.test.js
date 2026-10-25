'use strict';

// Transactions (src/commit.js transact): several writes appended as one
// group and landed as one batch — all or none, in order, the events after —
// with a message on every op, in the signed header.

const test = require('node:test');
const assert = require('node:assert');
const syncom = require('../src/all/all.js');
const { memory } = require('../src/memory/memory.js');

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
      storage.on('commit', (event) => events.push(event));
      storage.on('change', (op) => changes.push(op));
      const other = await storage.insert({ n: 0 });
      const logged = storage.log.length;
      const files = (await storage.fsi.list('/t/log/open')).length;
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
      assert.strictEqual((await storage.fsi.list('/t/log/open')).length - files, 1, 'one group file');
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
      assert.ok(changes.slice(1).every((op) => op.msg === 'first'));
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
});
