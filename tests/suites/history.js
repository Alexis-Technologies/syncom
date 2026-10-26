'use strict';

// The past out of the log, against whichever half the caller builds:
// history() lists what the node applied, get(id, { at }) folds it back by
// event id, stamp or vector, and both say when the log cannot vouch for it.

const { createMesh, settle, waitUntil } = require('../utils/mesh.js');

const tick = () => new Promise((resolve) => setTimeout(resolve, 3));

const runHistoryTests = async (t, assert, createStorage) => {
  await t.test('history() lists one version per op, newest first; get(id, { at }) reads each back', async (t2) => {
    const storage = await createStorage(t2, 'A', { actor: 'ada' });
    const id = await storage.insert({ title: 'a' });
    await storage.update(id, { title: 'b' }, { actor: 'bob' });
    await storage.inc(id, 'hits', 2);
    await storage.add(id, 'tags', ['x', 'y']);
    await storage.remove(id, 'tags', ['x']);
    await storage.splice(id, 'body', 0, 0, 'hello');
    await storage.push(id, 'items', ['p', 'q']);
    await storage.setAt(id, 'items', 0, 'P');
    await storage.move(id, 'items', 1, 0);
    await storage.mark(id, 'body', 0, 2, 'bold', true);
    await storage.treeMove(id, 'outline', 'n1');
    await storage.delete(id);
    await storage.set(id, { title: 'c' });
    const { versions, complete, exact } = await storage.history(id);
    assert.strictEqual(complete, true);
    assert.strictEqual(exact, true);
    assert.deepStrictEqual(
      versions.map((v) => v.type),
      ['write', 'delete', 'tree', 'mark', 'move', 'assign', 'splice', 'splice', 'remove', 'add', 'inc', 'set', 'write'],
    );
    assert.deepStrictEqual(
      versions.map((v) => v.fields),
      [
        ['title'],
        ['title', 'hits', 'tags', 'body', 'items', 'outline'],
        ['outline'],
        ['body'],
        ['items'],
        ['items'],
        ['items'],
        ['body'],
        ['tags'],
        ['tags'],
        ['hits'],
        ['title'],
        ['title'],
      ],
    );
    assert.deepStrictEqual(versions.at(-1).data, { title: 'a' });
    assert.deepStrictEqual(versions.at(-2).data, { title: 'b' });
    assert.deepStrictEqual(versions[1].data, null, 'deleted');
    assert.deepStrictEqual(versions[0].data, { title: 'c' });
    assert.deepStrictEqual(versions[2].data, {
      title: 'b',
      hits: 2,
      tags: ['y'],
      body: 'hello',
      items: ['q', 'P'],
      outline: [{ id: 'n1', children: [] }],
    });
    assert.deepStrictEqual(
      versions.map((v) => v.actor),
      ['ada', 'ada', 'ada', 'ada', 'ada', 'ada', 'ada', 'ada', 'ada', 'ada', 'ada', 'bob', 'ada'],
    );
    for (let i = 0; i < versions.length; i++) {
      const v = versions[i];
      assert.strictEqual(v.origin, storage.nodeId);
      assert.strictEqual(v.eventId, storage.log.formatId(v.seq));
      assert.strictEqual(v.scrubbed, undefined);
      assert.ok(i === 0 || v.ts < versions[i - 1].ts, 'newest first');
      assert.deepStrictEqual(await storage.get(id, { at: v.eventId }), v.data, `at ${v.type}`);
      assert.deepStrictEqual(await storage.get(id, { at: v.ts }), v.data, `at stamp of ${v.type}`);
      assert.deepStrictEqual(await storage.get(id, { at: new Date(v.ts) }), v.data);
    }
    // The present, three ways; the vector is every op this node applied.
    const now = await storage.get(id);
    assert.deepStrictEqual(await storage.get(id, { at: { vector: storage.vector } }), now);
    assert.deepStrictEqual(await storage.get(id, { at: storage.log.lastEventId }), now);
    assert.deepStrictEqual(await storage.get(id, { at: Date.now() + 1000 }), now);
    // Before the record: nothing. An empty vector: nothing.
    assert.strictEqual(await storage.get(id, { at: storage.log.formatId(0) }), null);
    assert.strictEqual(await storage.get(id, { at: { vector: {} } }), null);
    assert.strictEqual(await storage.get(id, { at: 0 }), null);
    assert.strictEqual(await storage.get('nope', { at: storage.log.lastEventId }), null);
    assert.deepStrictEqual(await storage.history('nope'), { versions: [], complete: true, exact: true });
    // A copy: editing what came back changes nothing.
    const copy = await storage.get(id, { at: versions[2].eventId });
    copy.items.push('z');
    assert.deepStrictEqual((await storage.get(id, { at: versions[2].eventId })).items, ['q', 'P']);
    // limit: newest first, and the list is no longer complete.
    const two = await storage.history(id, { limit: 2 });
    assert.deepStrictEqual(
      two.versions.map((v) => v.type),
      ['write', 'delete'],
    );
    assert.deepStrictEqual([two.complete, two.exact], [false, true]);
    assert.strictEqual((await storage.history(id, { limit: Infinity })).versions.length, 13);
    // Arguments and codes.
    await assert.rejects(() => storage.history(id, { limit: 0 }), TypeError);
    await assert.rejects(() => storage.get(id, { at: true }), { name: 'TypeError', code: 'INVALID_VERSION' });
    await assert.rejects(() => storage.get(id, { at: 'no-dot' }), { code: 'INVALID_VERSION' });
    await assert.rejects(() => storage.get(id, { at: -1 }), { code: 'INVALID_VERSION' });
    await assert.rejects(() => storage.get(id, { at: { vector: { a: 'x' } } }), { code: 'INVALID_VERSION' });
    await assert.rejects(() => storage.get(id, { at: storage.log.formatId(storage.log.next) }), {
      name: 'TypeError',
      code: 'INVALID_VERSION',
    });
    await assert.rejects(() => storage.get(id, { at: `other.${versions[0].seq}` }), {
      name: 'SyncomError',
      code: 'HISTORY_GONE',
      id,
      reason: 'epoch',
    });
    // Through a collection, with the lens.
    const typed = await createStorage(t2, 'T', {
      schema: {
        version: 2,
        entities: { Post: {} },
        migrations: { 2: { Post: { up: ({ title, ...rest }) => ({ ...rest, name: title }) } } },
      },
    });
    const post = await typed.Post.insert({ name: 'x' });
    await typed.Post.update(post.id, { name: 'y' });
    const first = (await typed.history(post.id)).versions.at(-1);
    assert.deepStrictEqual(await typed.Post.get(post.id, { at: first.eventId }), { name: 'x', $type: 'Post' });
    assert.strictEqual(await typed.Post.get('nope', { at: first.eventId }), null);
  });

  await t.test('an event id is what this node held; a stamp and a vector are what was written by then', async (t2) => {
    const mesh = await createMesh(t2, ['A', 'B'], [['A', 'B']], createStorage);
    const a = mesh.get('A');
    const b = mesh.get('B');
    const id = await a.insert({ n: 0 });
    await settle([a, b]);
    const link = mesh.links.get('mem://B');
    link.disconnect();
    // Apart: B writes first by the clock, A later; A applies B's op last.
    await b.update(id, { fromB: 1 });
    await b.inc(id, 'hits', 1);
    await tick();
    const between = Date.now();
    await tick();
    await a.update(id, { fromA: 1 });
    const beforeB = a.log.lastEventId;
    const vectorBeforeB = a.vector;
    await link.reconnect();
    await settle([a, b]);
    const now = { n: 0, fromA: 1, fromB: 1, hits: 1 };
    assert.deepStrictEqual(await a.get(id), now);
    // Arrival: A's log at that point had its own write, not B's.
    assert.deepStrictEqual(await a.get(id, { at: beforeB }), { n: 0, fromA: 1 });
    // Stamp: by then B had written, A had not — whatever order they arrived in.
    assert.deepStrictEqual(await a.get(id, { at: between }), { n: 0, fromB: 1, hits: 1 });
    // Vector: exactly the ops it covers.
    assert.deepStrictEqual(await a.get(id, { at: { vector: vectorBeforeB } }), { n: 0, fromA: 1 });
    assert.deepStrictEqual(await a.get(id, { at: { vector: b.vector } }), now);
    // The history on each side lists what that node applied, in its order.
    const onA = (await a.history(id)).versions.map((v) => [v.type, v.origin === a.nodeId ? 'A' : 'B']);
    assert.deepStrictEqual(onA, [
      ['inc', 'B'],
      ['set', 'B'],
      ['set', 'A'],
      ['write', 'A'],
    ]);
    const onB = (await b.history(id)).versions.map((v) => [v.type, v.origin === a.nodeId ? 'A' : 'B']);
    assert.deepStrictEqual(onB, [
      ['set', 'A'],
      ['inc', 'B'],
      ['set', 'B'],
      ['write', 'A'],
    ]);
    assert.deepStrictEqual(await b.get(id, { at: between }), { n: 0, fromB: 1, hits: 1 });
  });

  await t.test('a skipped op is no version; a held op becomes one once the node runs its version', async (t2) => {
    // Skipped by a hook: logged, relayed, never a version here.
    const skipping = await createMesh(t2, ['C', 'D'], [['D', 'C']], createStorage, {
      nodes: { D: { hooks: { beforeApply: ({ op }) => op.id !== 'skip-me' } } },
    });
    const c = skipping.get('C');
    const d = skipping.get('D');
    await waitUntil(() => d.sync.peers()[0]?.subscribed);
    await c.set('skip-me', { secret: true });
    await c.set('kept', { n: 1 });
    await settle([c, d]);
    assert.strictEqual(await d.get('skip-me'), null);
    assert.deepStrictEqual(await d.history('skip-me'), { versions: [], complete: true, exact: true }, 'skipped: none');
    assert.strictEqual(await d.get('skip-me', { at: { vector: d.vector } }), null);
    assert.strictEqual(await d.get('skip-me', { at: d.log.lastEventId }), null);
    assert.strictEqual((await d.history('kept')).versions.length, 1);
    assert.strictEqual(d.vector[c.nodeId], 2, 'the vector moved past the skipped op too');
    // Held for a newer schema version: no version until the node runs it.
    const v2 = { version: 2, entities: { Post: {} } };
    const mesh = await createMesh(t2, ['A', 'B'], [['B', 'A']], createStorage, {
      nodes: { A: { schema: v2 }, B: { schema: { version: 1, entities: { Post: {} }, ahead: 'hold' } } },
    });
    const a = mesh.get('A');
    const b = mesh.get('B');
    await waitUntil(() => b.sync.peers()[0]?.subscribed);
    const post = await a.Post.insert({ n: 1 });
    await a.Post.update(post.id, { n: 2 });
    await settle([a, b]);
    assert.strictEqual(await b.get(post.id), null, 'held, not applied');
    assert.deepStrictEqual(await b.history(post.id), { versions: [], complete: true, exact: true }, 'held: no version');
    assert.strictEqual(await b.get(post.id, { at: b.log.lastEventId }), null);
    assert.strictEqual(b.vector[a.nodeId], 2, 'the vector moved past both');
    const heldIds = b.log.held().map((entry) => b.log.formatId(entry.seq));
    // B upgrades: the held ops are applied and become versions at their
    // original event ids.
    await b.close();
    const upgraded = await createStorage(t2, 'B', { schema: v2 });
    assert.deepStrictEqual(
      upgraded.schemaInfo.held,
      { replayed: 1, lost: 0 },
      'one record, replayed from both held ops',
    );
    const { versions, exact } = await upgraded.history(post.id);
    assert.strictEqual(exact, true);
    assert.deepStrictEqual(
      versions.map((v) => [v.eventId, v.type, v.data]),
      [
        [heldIds[1], 'set', { n: 2, $type: 'Post' }],
        [heldIds[0], 'write', { n: 1, $type: 'Post' }],
      ],
    );
    assert.deepStrictEqual(await upgraded.get(post.id, { at: heldIds[0] }), { n: 1, $type: 'Post' });
  });

  await t.test('compaction: the past is exact from a reset above what was dropped, gone before it', async (t2) => {
    const storage = await createStorage(t2, 'A', { sync: { log: { rollAfter: 1 }, retention: { ops: 4 } } });
    const id = await storage.insert({ n: 0 });
    const first = storage.log.lastEventId;
    for (let i = 1; i <= 6; i++) await storage.update(id, { n: i });
    await storage.inc(id, 'hits', 1);
    assert.ok(storage.log.droppedTs > 0, 'compacted');
    // No reset above what was dropped: the retained fold is not the past.
    const partial = await storage.history(id);
    assert.deepStrictEqual([partial.complete, partial.exact], [false, false]);
    assert.ok(partial.versions.length > 0, 'what is retained is still listed');
    await assert.rejects(() => storage.get(id, { at: first }), {
      name: 'SyncomError',
      code: 'HISTORY_GONE',
      id,
      reason: 'compacted',
    });
    await assert.rejects(() => storage.get(id, { at: storage.log.lastEventId }), { code: 'HISTORY_GONE' });
    await assert.rejects(() => storage.get(id, { at: Date.now() + 1000 }), { code: 'HISTORY_GONE' });
    // A reset (a whole-record write) stamped above the dropped ops: exact
    // from it on, and the present check holds.
    await storage.set(id, { n: 'reset' });
    const reset = storage.log.lastEventId;
    await storage.update(id, { n: 'after' });
    await storage.inc(id, 'hits', 5);
    const { versions, complete, exact } = await storage.history(id);
    assert.deepStrictEqual([complete, exact], [false, true]);
    assert.deepStrictEqual(
      versions.map((v) => [v.type, v.data]),
      [
        ['inc', { n: 'after', hits: 5 }],
        ['set', { n: 'after' }],
        ['write', { n: 'reset' }],
      ],
    );
    assert.deepStrictEqual(await storage.get(id, { at: reset }), { n: 'reset' });
    assert.deepStrictEqual(await storage.get(id, { at: { vector: storage.vector } }), { n: 'after', hits: 5 });
    await assert.rejects(() => storage.get(id, { at: first }), { code: 'HISTORY_GONE', reason: 'compacted' });
    // A record that never existed here reads as nothing, dropped or not.
    assert.strictEqual(await storage.get('never', { at: storage.log.lastEventId }), null);
    // A record written only after the compaction, exact from its first write.
    const young = await storage.insert({ y: 1 });
    await storage.update(young, { y: 2 });
    const fresh = await storage.history(young);
    assert.deepStrictEqual([fresh.exact, fresh.complete, fresh.versions.length], [true, false, 2]);
    assert.deepStrictEqual(await storage.get(young, { at: fresh.versions[1].eventId }), { y: 1 });
    await assert.rejects(() => storage.get(young, { at: first }), { code: 'HISTORY_GONE', reason: 'compacted' });
  });

  await t.test('a counter incremented across the reset compaction crossed makes the past inexact', async (t2) => {
    // defer: 0 — what the log compacts follows what landed; under load a deferred window still open sealed nothing.
    const storage = await createStorage(t2, 'A', { defer: 0, sync: { log: { rollAfter: 1 }, retention: { ops: 4 } } });
    const id = await storage.insert({ n: 0 });
    await storage.inc(id, 'hits', 10);
    await tick();
    await storage.inc(id, 'hits', 1);
    const newest = (await storage.history(id)).versions[0].ts;
    // A peer's whole-record write stamped below the newest increment lands
    // after both: it resets the record but keeps the counter slot, whose sum
    // the first increment went into.
    await storage.applyRemote([{ origin: 'peer', seq: 1, ts: newest - 1, type: 'write', id, data: { n: 'peer' } }]);
    await storage.update(id, { n: 1 });
    await storage.update(id, { n: 2 });
    assert.strictEqual(storage.log.floor, 3, 'the first increment is compacted away, the second retained');
    assert.ok(storage.log.droppedTs < newest - 1, 'the write is a reset above what was dropped');
    assert.strictEqual((await storage.get(id)).hits, 11, 'the straddle: the old sum survives the reset');
    // The fold from the write has no counter at all: the present shows the
    // difference, and the past is refused.
    const { exact, versions } = await storage.history(id);
    assert.strictEqual(exact, false);
    assert.deepStrictEqual(versions[0].data, { n: 2 });
    await assert.rejects(() => storage.get(id, { at: storage.log.lastEventId }), {
      code: 'HISTORY_GONE',
      reason: 'compacted',
    });
    // Another reset ends the straddle: exact again from there.
    await storage.set(id, { n: 'again' });
    assert.strictEqual((await storage.history(id)).exact, true);
    assert.deepStrictEqual(await storage.get(id, { at: storage.log.lastEventId }), { n: 'again' });
  });

  await t.test('a snapshot joined after a stamp hides what it carried: HISTORY_GONE merge', async (t2) => {
    const options = { sync: { log: { rollAfter: 2 }, retention: { ops: 4 } } };
    const mesh = await createMesh(t2, ['A', 'B'], [], createStorage, options);
    const a = mesh.get('A');
    const id = await a.insert({ n: 0 });
    for (let i = 0; i < 8; i++) await a.inc(id, 'hits', 1);
    const before = Date.now();
    await tick();
    assert.ok(a.log.floor > 1, 'A compacted; B must bootstrap');
    const b = mesh.get('B');
    await b.sync.addNode({ url: 'mem://A' });
    await settle([a, b]);
    assert.strictEqual((await b.get(id)).hits, 8);
    const { versions, exact } = await b.history(id);
    assert.deepStrictEqual(
      versions.map((v) => v.type),
      ['merge'],
    );
    assert.strictEqual(exact, true, 'nothing dropped on B');
    assert.deepStrictEqual(versions[0].data, { n: 0, hits: 8 });
    // By stamp, B cannot tell what of the joined state was written before: refused.
    await assert.rejects(() => b.get(id, { at: before }), { code: 'HISTORY_GONE', id, reason: 'merge' });
    // By event id or vector, the merge is one op like any other.
    assert.deepStrictEqual(await b.get(id, { at: versions[0].eventId }), { n: 0, hits: 8 });
    assert.deepStrictEqual(await b.get(id, { at: { vector: b.vector } }), { n: 0, hits: 8 });
    // Live ops after it are versions of their own, and a stamp past the merge works.
    await a.inc(id, 'hits', 1);
    await settle([a, b]);
    assert.deepStrictEqual(
      (await b.history(id)).versions.map((v) => v.type),
      ['inc', 'merge'],
    );
    assert.deepStrictEqual(await b.get(id, { at: Date.now() + 1000 }), { n: 0, hits: 9 });
  });

  await t.test('a purge leaves the ops and takes their content; an encrypted record has no past', async (t2) => {
    const storage = await createStorage(t2, 'A');
    const id = await storage.insert({ secret: 'SSN-1' });
    await storage.update(id, { secret: 'SSN-2' });
    const [second, first] = (await storage.history(id)).versions.map((v) => v.eventId);
    await storage.purge(id);
    const purgeId = storage.log.lastEventId;
    const { versions, complete, exact } = await storage.history(id);
    assert.deepStrictEqual([complete, exact], [true, true]);
    assert.deepStrictEqual(
      versions.map((v) => [v.type, v.data, v.fields, v.scrubbed]),
      [
        ['purge', null, [], true],
        ['set', null, [], true],
        ['write', null, [], true],
      ],
      'every entry of the id is scrubbed, the purge itself included',
    );
    assert.ok(!JSON.stringify(versions).includes('SSN'), 'no payload survives');
    assert.strictEqual(await storage.get(id, { at: purgeId }), null);
    assert.strictEqual(await storage.get(id, { at: { vector: storage.vector } }), null);
    await assert.rejects(() => storage.get(id, { at: first }), { code: 'HISTORY_GONE', id, reason: 'scrubbed' });
    await assert.rejects(() => storage.get(id, { at: second }), { code: 'HISTORY_GONE', reason: 'scrubbed' });
    const sealed = await storage.insert({ pin: '1234' }, { encrypted: true });
    await assert.rejects(() => storage.history(sealed), { code: 'ENCRYPTED' });
    await assert.rejects(() => storage.get(sealed, { at: storage.log.lastEventId }), { code: 'ENCRYPTED' });
  });

  await t.test('the read hooks see the version; afterRead redacts each one', async (t2) => {
    const seen = [];
    const storage = await createStorage(t2, 'A', {
      hooks: {
        beforeRead: (ctx) => void seen.push(ctx),
        afterRead: (ctx, data) => (data && data.secret ? { ...data, secret: '***' } : undefined),
      },
    });
    const id = await storage.insert({ secret: 's1', n: 1 });
    await storage.update(id, { n: 2 });
    const { versions } = await storage.history(id);
    assert.deepStrictEqual(
      versions.map((v) => v.data),
      [
        { secret: '***', n: 2 },
        { secret: '***', n: 1 },
      ],
    );
    assert.deepStrictEqual(await storage.get(id, { at: versions[1].eventId }), { secret: '***', n: 1 });
    assert.deepStrictEqual(await storage.get(id, { at: { vector: storage.vector } }), { secret: '***', n: 2 });
    assert.deepStrictEqual(seen, [
      { id, history: true },
      { id, at: versions[1].eventId },
      { id, at: { vector: storage.vector } },
    ]);
  });

  await t.test('history({ limit }) runs afterRead for the versions it hands out alone', async (t2) => {
    let reads = 0;
    const storage = await createStorage(t2, 'A', { hooks: { afterRead: () => void reads++ } });
    const id = await storage.insert({ n: 0 });
    for (let i = 1; i <= 30; i++) await storage.update(id, { n: i });
    reads = 0;
    const { versions, complete } = await storage.history(id, { limit: 5 });
    assert.strictEqual(versions.length, 5);
    assert.strictEqual(complete, false);
    assert.strictEqual(reads, 5, 'one afterRead per version handed out, none for the rest');
    assert.deepStrictEqual(
      versions.map((version) => version.data.n),
      [30, 29, 28, 27, 26],
    );
  });

  await t.test('history({ before }) pages back: the versions older than an event id, until complete', async (t2) => {
    const storage = await createStorage(t2, 'A');
    const id = await storage.insert({ n: 0 });
    for (let i = 1; i <= 25; i++) await storage.update(id, { n: i });
    const seen = [];
    let page = await storage.history(id, { limit: 10 });
    assert.strictEqual(page.complete, false);
    seen.push(...page.versions.map((version) => version.data.n));
    while (!page.complete) {
      const oldest = page.versions[page.versions.length - 1];
      page = await storage.history(id, { limit: 10, before: oldest.eventId });
      seen.push(...page.versions.map((version) => version.data.n));
    }
    assert.deepStrictEqual(
      seen,
      Array.from({ length: 26 }, (_, i) => 25 - i),
      'every version once, newest first',
    );
    const first = page.versions[page.versions.length - 1].eventId;
    assert.deepStrictEqual((await storage.history(id, { limit: 10, before: first })).versions, []);
    await assert.rejects(() => storage.history(id, { before: 7 }), TypeError);
    await assert.rejects(() => storage.history(id, { before: { vector: {} } }), TypeError);
  });
};

module.exports = { runHistoryTests };
