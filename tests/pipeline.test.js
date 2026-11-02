'use strict';

// Pipelines (src/pipeline/pipeline.js): every change of a collection handled
// once, in order, inside one transaction per turn; the checkpoint after the
// write; a reopen replays from it, or rebuilds where the log cannot resume.

const test = require('node:test');
const assert = require('node:assert');
const syncom = require('../src/all/all.js');
const { memory } = require('../src/memory/memory.js');
const { createPipeline } = require('../src/pipeline/pipeline.js');

const schema = { entities: { Order: { index: ['customer'] }, Total: {} } };

test('pipelines', async (t) => {
  await t.test('a pipeline resumes from its checkpoint after a reopen and handles every change once', async (t2) => {
    const fsi = memory();
    const openDb = async (options = {}) =>
      syncom.createDatabase({ path: '/p', fsi, defer: 0, logger: false, schema, ...options });
    // The handler keeps, per customer, the sum of the orders — a derived collection — and counts what it saw.
    const seen = [];
    const handler = async ({ ids, changes, replay }, tx) => {
      for (const id of ids) {
        seen.push(id);
        const order = await tx.get(id);
        const customer = order === null ? null : order.customer;
        if (customer === null) continue;
        const totalId = `total.${customer}`;
        const total = (await tx.get(totalId)) ?? { $type: 'Total', customer, sum: 0, orders: {} };
        const orders = { ...total.orders, [id]: order.amount };
        let sum = 0;
        for (const key of Object.keys(orders)) sum += orders[key];
        await tx.set(totalId, { ...total, sum, orders });
      }
      if (replay) seen.push('replay');
      void changes;
    };
    let db = await openDb();
    const pipeline = createPipeline(db, { name: 'totals', source: 'Order', handler });
    assert.strictEqual(pipeline.checkpoint, null);
    await pipeline.start();
    await pipeline.awaitIdle();
    assert.strictEqual(pipeline.rebuilt, true, 'no checkpoint: a rebuild of nothing');
    const a = (await db.Order.insert({ customer: 'ann', amount: 10 })).id;
    const b = (await db.Order.insert({ customer: 'ann', amount: 5 })).id;
    await db.Total.insert({ customer: 'nobody', sum: 0 });
    await db.transact(async (tx) => {
      await tx.update(a, { amount: 20 });
      await tx.insert({ $type: 'Order', customer: 'bob', amount: 1 });
    });
    await pipeline.awaitIdle();
    assert.ok(pipeline.idle());
    assert.deepStrictEqual(await db.get('total.ann'), {
      $type: 'Total',
      customer: 'ann',
      sum: 25,
      orders: { [a]: 20, [b]: 5 },
    });
    assert.strictEqual((await db.get('total.bob')).sum, 1);
    assert.strictEqual(seen.length, 4, 'two inserts, then one turn with two ids: each once');
    // The checkpoint is the last turn of the source; the handler's own writes (the totals) lie past it.
    assert.ok(pipeline.checkpoint !== null);
    assert.ok(db.log.since(pipeline.checkpoint).every((entry) => entry.op.id.startsWith('total.')));
    // Stopped: the changes meanwhile wait for the next start, in the log.
    pipeline.stop();
    const c = (await db.Order.insert({ customer: 'ann', amount: 100 })).id;
    await db.Order.update(b, { amount: 6 });
    await db.close();
    // Reopened: the turns since the checkpoint replayed — the ids, once each — then the live ones.
    db = await openDb();
    const again = createPipeline(db, { name: 'totals', source: 'Order', handler });
    await again.start();
    await again.awaitIdle();
    assert.strictEqual(again.rebuilt, false, 'resumed from the checkpoint');
    assert.deepStrictEqual(seen.slice(4).sort(), [b, c, 'replay'].sort());
    assert.strictEqual((await db.get('total.ann')).sum, 126);
    await db.Order.update(c, { amount: 101 });
    await again.awaitIdle();
    assert.strictEqual((await db.get('total.ann')).sum, 127);
    assert.strictEqual(seen.length, 8);
    // A handler that throws stops the pipeline before the turn: the error kept, the checkpoint not moved, nothing
    // handed over meanwhile; `start()` hands the failed turn over again.
    const errors = [];
    db.on('error', (error) => errors.push([error.code, error.name, error.cause.message]));
    let arm = true;
    const broken = createPipeline(db, {
      name: 'broken',
      source: 'Order',
      handler: async ({ ids }) => {
        if (arm && ids.includes(c)) throw new Error('boom');
      },
    });
    assert.strictEqual(broken.stopped, true, 'not started');
    await broken.start();
    await broken.awaitIdle();
    assert.strictEqual(broken.stopped, true, 'stopped by the failure');
    assert.strictEqual(broken.checkpoint, null, 'nothing past the failed turn');
    await db.Order.update(c, { amount: 102 });
    await broken.awaitIdle();
    assert.deepStrictEqual(
      broken.errors.map((error) => error.message),
      ['boom'],
      'once: nothing is handed over while stopped',
    );
    assert.deepStrictEqual(errors, [['PIPELINE_FAILED', 'broken', 'boom']]);
    arm = false;
    await broken.start();
    await broken.awaitIdle();
    assert.strictEqual(broken.stopped, false);
    assert.ok(broken.checkpoint !== null, 'the turn handed over again, and handled');
    broken.stop();
    assert.strictEqual(broken.stopped, true);
    again.stop();
    await db.close();
    // A checkpoint the log cannot resume from: every record of the source, once.
    db = await openDb({ sync: { retention: { ops: 2 } } });
    for (let i = 0; i < 40; i++) await db.Order.insert({ customer: 'cat', amount: 1 });
    await db.log.flush();
    const rebuilt = [];
    const third = createPipeline(db, {
      name: 'totals',
      source: 'Order',
      handler: ({ ids, rebuilt: whole }) => rebuilt.push([ids.length, whole]),
    });
    await third.start();
    await third.awaitIdle();
    assert.strictEqual(third.rebuilt, true);
    assert.deepStrictEqual(rebuilt, [[await db.Order.count(), true]]);
    third.stop();
    await db.close();
    assert.throws(() => createPipeline(db, { name: 'x', source: 'Order' }), TypeError);
    assert.throws(() => createPipeline(db, { name: 'bad name', source: 'Order', handler }), TypeError);
  });

  await t.test(
    'a rebuild and a replay are handed over 500 records at a time with the checkpoint after the last page; turns that come while one is handled join as one batch',
    async () => {
      // The checkpoint's write (the `pipeline` namespace) held while `gate` is set: what lands meanwhile queues up.
      const fsi = memory();
      let gate = null;
      const slow = {
        read: (dir, name) => fsi.read(dir, name),
        write: (dir, name, content, options) =>
          gate !== null && dir.endsWith('pipeline')
            ? gate.then(() => fsi.write(dir, name, content, options))
            : fsi.write(dir, name, content, options),
        append: (dir, name, content) => fsi.append(dir, name, content),
        exists: (dir, name) => fsi.exists(dir, name),
        remove: (dir, name) => fsi.remove(dir, name),
        list: (dir) => fsi.list(dir),
      };
      const db = await syncom.createDatabase({ path: '/r', fsi: slow, defer: 0, logger: false, schema });
      const rows = [];
      for (let i = 0; i < 1200; i++) rows.push({ customer: `c${i % 7}`, amount: i });
      await db.Order.bulkInsert(rows);
      const batches = [];
      let failAt = 1;
      const live = [];
      let firstLive = null;
      const handled = new Promise((resolve) => (firstLive = resolve));
      const pipeline = createPipeline(db, {
        name: 'pages',
        source: 'Order',
        handler: async ({ ids, changes, replay, rebuilt }) => {
          if (replay) {
            if (batches.length === failAt) throw new Error(`page ${failAt + 1}`);
            batches.push([ids.length, rebuilt]);
            return;
          }
          live.push([ids.slice(), changes.length]);
          if (live.length === 1) firstLive();
        },
      });
      // A rebuild (no checkpoint): page 2 fails — page 1 was handled, nothing is checkpointed.
      await pipeline.start();
      await pipeline.awaitIdle();
      assert.deepStrictEqual(batches, [[500, true]]);
      assert.strictEqual(pipeline.stopped, true);
      assert.strictEqual(pipeline.checkpoint, null, 'no page of a rebuild moves the checkpoint but the last');
      // Started again: the rebuild from the start, every page, then the checkpoint.
      failAt = -1;
      batches.length = 0;
      await pipeline.start();
      await pipeline.awaitIdle();
      assert.deepStrictEqual(batches, [
        [500, true],
        [500, true],
        [200, true],
      ]);
      const after = pipeline.checkpoint;
      assert.ok(after !== null);
      // Live: the first turn is handled and its checkpoint held; the three turns that land meanwhile join as one
      // batch — the ids each once, every change — handed over after it.
      let open = null;
      gate = new Promise((resolve) => (open = resolve));
      const a = (await db.Order.insert({ customer: 'live', amount: 1 })).id;
      await handled;
      const b = (await db.Order.insert({ customer: 'live', amount: 2 })).id;
      const c = (await db.Order.insert({ customer: 'live', amount: 3 })).id;
      await db.Order.update(b, { amount: 20 });
      open();
      await pipeline.awaitIdle();
      gate = null;
      // A change per field written: three of an insert, one of the update.
      assert.deepStrictEqual(live, [
        [[a], 3],
        [[b, c], 7],
      ]);
      assert.notStrictEqual(pipeline.checkpoint, after);
      // Stopped, 600 records written: the replay hands them over in pages too.
      pipeline.stop();
      batches.length = 0;
      const more = [];
      for (let i = 0; i < 600; i++) more.push({ customer: 'later', amount: i });
      await db.Order.bulkInsert(more);
      await pipeline.start();
      await pipeline.awaitIdle();
      assert.deepStrictEqual(batches, [
        [500, false],
        [100, false],
      ]);
      assert.strictEqual(pipeline.rebuilt, false);
      pipeline.stop();
      await db.close();
    },
  );

  await t.test('a pipeline hears a plain delete and a purge of its source', async () => {
    const db = await syncom.createDatabase({ path: '/d', fsi: memory(), defer: 0, logger: false, schema });
    const heard = [];
    const pipeline = createPipeline(db, {
      name: 'deletes',
      source: 'Order',
      handler: ({ ids, changes }) => {
        for (const id of ids) {
          const actions = changes.filter((change) => change.id === id).map((change) => change.action);
          heard.push([id, actions]);
        }
      },
    });
    await pipeline.start();
    const id = (await db.Order.insert({ customer: 'ann', amount: 1 })).id;
    await db.delete(id);
    const other = (await db.Order.insert({ customer: 'bob', amount: 2 })).id;
    await db.purge(other);
    await db.Total.insert({ customer: 'nobody', sum: 0 });
    await pipeline.awaitIdle();
    // The insert, then the delete (a tombstone's row keeps the collection), then a purge (the change names it); a
    // record of another collection is not heard of.
    assert.deepStrictEqual(
      heard.map(([one, actions]) => [one, actions.includes('delete'), actions.includes('purge')]),
      [
        [id, false, false],
        [id, true, false],
        [other, false, false],
        [other, false, true],
      ],
    );
    pipeline.stop();
    await db.close();
  });
});
