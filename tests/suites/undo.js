'use strict';

// Undo and redo over one node's own writes, against whichever half the
// caller builds: every kind of op taken back and done again, steps that
// merge and split, a redo stack cleared by a new edit, a peer's concurrent
// change left alone, the add that revokes only its own tag, the log held
// for the stack, a purge forgetting its record.

const { createMesh, settle } = require('../utils/mesh.js');
const { createUndo } = require('../../src/undo/undo.js');

const tick = () => new Promise((resolve) => setTimeout(resolve, 3));

const runUndoTests = async (t, assert, createStorage) => {
  await t.test('every kind of op is taken back and done again', async (t2) => {
    const storage = await createStorage(t2, 'A');
    const undo = createUndo(storage, { mergeInterval: 0 });
    assert.deepStrictEqual([undo.canUndo, undo.canRedo, undo.size], [false, false, { undo: 0, redo: 0 }]);
    assert.deepStrictEqual(await undo.undo(), { applied: 0, skipped: 0 });
    const id = await storage.insert({ title: 'a', n: 1 });
    const steps = [await storage.get(id)];
    const step = async (write) => {
      await write();
      steps.push(await storage.get(id));
    };
    await step(() => storage.update(id, { title: 'b' }));
    await step(() => storage.inc(id, 'hits', 3));
    await step(() => storage.add(id, 'tags', ['x', 'y']));
    await step(() => storage.remove(id, 'tags', ['x']));
    await step(() => storage.splice(id, 'body', 0, 0, 'hello'));
    await step(() => storage.updateText(id, 'body', 'hello world'));
    await step(() => storage.push(id, 'items', [1, 2, 3]));
    await step(() => storage.setAt(id, 'items', 0, 'one'));
    await step(() => storage.move(id, 'items', 2, 0));
    await step(() => storage.treeMove(id, 'outline', 'r'));
    await step(() => storage.treeMove(id, 'outline', 'a', 'r'));
    await step(() => storage.treeMove(id, 'outline', 'b', 'r', { before: 'a' }));
    await step(() => storage.treeRemove(id, 'outline', 'a'));
    await step(() => storage.set(id, { title: 'reset' }));
    await step(() => storage.delete(id));
    await step(() => storage.set(id, { back: true }));
    assert.strictEqual(undo.size.undo, steps.length, 'one step per write (the insert too)');
    // All the way back, one step at a time; then all the way forward.
    for (let i = steps.length - 1; i >= 1; i--) {
      const result = await undo.undo();
      assert.ok(result.applied > 0, `step ${i}`);
      assert.strictEqual(result.skipped, 0);
      assert.deepStrictEqual(await storage.get(id), steps[i - 1], `back to step ${i - 1}`);
    }
    assert.ok(undo.canUndo, 'the insert itself');
    await undo.undo();
    assert.strictEqual(await storage.get(id), null);
    assert.deepStrictEqual([undo.canUndo, undo.canRedo], [false, true]);
    for (let i = 0; i < steps.length; i++) {
      await undo.redo();
      assert.deepStrictEqual(await storage.get(id), steps[i], `forward to step ${i}`);
    }
    assert.deepStrictEqual([undo.canUndo, undo.canRedo], [true, false]);
    assert.deepStrictEqual(await undo.redo(), { applied: 0, skipped: 0 });
    // An undo is ops like any other: the history grows, nothing is rewritten.
    const { versions } = await storage.history(id, { limit: Infinity });
    assert.ok(versions.length > 2 * steps.length);
    undo.stop();
    assert.deepStrictEqual(undo.size, { undo: 0, redo: 0 });
    await storage.update(id, { after: 'stop' });
    assert.strictEqual(undo.canUndo, false, 'stopped: nothing captured');
  });

  await t.test('an undone joinBlock lays the marker again; an undone embed goes', async (t2) => {
    const storage = await createStorage(t2, 'A');
    const id = await storage.insert({ title: 'doc' });
    await storage.updateText(id, 'body', 'hello world');
    await storage.splitBlock(id, 'body', 0, { type: 'heading', attrs: { level: 2 } });
    const undo = createUndo(storage, { mergeInterval: 0 });
    await storage.insertEmbed(id, 'body', 6, { type: 'image', attrs: { src: 'a.png' } });
    await tick();
    await storage.joinBlock(id, 'body', 0);
    assert.strictEqual((await storage.get(id)).body, 'hello\uFFFC world');
    await undo.undo();
    assert.strictEqual((await storage.get(id)).body, '\uFFFChello\uFFFC world');
    assert.deepStrictEqual(await storage.block(id, 'body', 0), {
      type: 'heading',
      parents: [],
      attrs: { level: 2 },
      isEmbed: false,
    });
    await undo.undo();
    assert.strictEqual((await storage.get(id)).body, '\uFFFChello world', 'the embed is gone');
    await undo.redo();
    assert.deepStrictEqual(await storage.block(id, 'body', 6), {
      type: 'image',
      parents: [],
      attrs: { src: 'a.png' },
      isEmbed: true,
    });
    // A marker changed and taken back: the old marker, by a setAt patch.
    await tick();
    await storage.updateBlock(id, 'body', 0, { type: 'paragraph' });
    assert.strictEqual((await storage.block(id, 'body', 0)).type, 'paragraph');
    await undo.undo();
    assert.strictEqual((await storage.block(id, 'body', 0)).type, 'heading');
    undo.stop();
  });

  await t.test('steps merge within the interval, split at mark(); a new edit clears the redo stack', async (t2) => {
    const storage = await createStorage(t2, 'A');
    const undo = createUndo(storage, { mergeInterval: 60_000 });
    const pushes = [];
    const pops = [];
    let changes = 0;
    undo.on('push', (event) => pushes.push(event));
    undo.on('pop', (event) => pops.push(event));
    undo.on('change', () => changes++);
    const a = await storage.insert({ n: 1 });
    const b = await storage.insert({ n: 1 });
    await storage.update(a, { n: 2 });
    await storage.inc(b, 'hits', 1);
    assert.strictEqual(undo.size.undo, 1, 'four writes, one step');
    assert.deepStrictEqual(pushes.at(-1), { direction: 'undo', records: 2 });
    undo.mark();
    await storage.update(a, { n: 3 });
    assert.strictEqual(undo.size.undo, 2, 'a mark closes the step');
    assert.deepStrictEqual(await undo.undo(), { applied: 1, skipped: 0 });
    assert.deepStrictEqual((await storage.get(a)).n, 2);
    assert.deepStrictEqual(pops.at(-1), { direction: 'undo', applied: 1, skipped: 0 });
    assert.deepStrictEqual(undo.size, { undo: 1, redo: 1 });
    // The first step undoes both records at once — a and b never existed:
    // one op per record, from how the step left it to how it found it.
    assert.deepStrictEqual(await undo.undo(), { applied: 2, skipped: 0 });
    assert.deepStrictEqual([await storage.get(a), await storage.get(b)], [null, null]);
    assert.deepStrictEqual(undo.size, { undo: 0, redo: 2 });
    await undo.redo();
    assert.deepStrictEqual([await storage.get(a), await storage.get(b)], [{ n: 2 }, { n: 1, hits: 1 }]);
    // A new edit clears what could have been redone.
    await storage.update(a, { n: 'new' });
    assert.deepStrictEqual(undo.size, { undo: 2, redo: 0 });
    assert.ok(changes >= 6);
    undo.clear();
    assert.deepStrictEqual(undo.size, { undo: 0, redo: 0 });
    // Options are checked.
    assert.throws(() => createUndo(storage, { mergeInterval: -1 }), TypeError);
    assert.throws(() => createUndo(storage, { limit: 0 }), TypeError);
    assert.throws(() => createUndo(storage, { exclude: 'x' }), TypeError);
    assert.throws(() => createUndo(storage, { scope: 5 }), TypeError);
    assert.throws(() => createUndo({}), TypeError);
    undo.stop();
    undo.stop();
  });

  await t.test('a field a peer changed since is left alone; a whole-record step needs force', async (t2) => {
    const mesh = await createMesh(t2, ['A', 'B'], [['A', 'B']], createStorage);
    const a = mesh.get('A');
    const b = mesh.get('B');
    const undo = createUndo(a, { mergeInterval: 0 });
    const id = await a.insert({ title: 'x', n: 1 });
    await settle([a, b]);
    undo.clear();
    const link = mesh.links.get('mem://B');
    link.disconnect();
    await a.update(id, { title: 'A', n: 2 });
    await tick();
    await b.update(id, { title: 'B' });
    await link.reconnect();
    await settle([a, b]);
    assert.deepStrictEqual(await a.get(id), { title: 'B', n: 2 }, 'B wrote later');
    // Undo A's step: n goes back, title is B's now and stays.
    assert.deepStrictEqual(await undo.undo(), { applied: 1, skipped: 1 });
    assert.deepStrictEqual(await a.get(id), { title: 'B', n: 1 });
    await settle([a, b]);
    assert.deepStrictEqual(await b.get(id), { title: 'B', n: 1 });
    // The redo step is what the undo did: n back to 2.
    assert.deepStrictEqual(await undo.redo(), { applied: 1, skipped: 0 });
    assert.deepStrictEqual(await a.get(id), { title: 'B', n: 2 });
    await settle([a, b]);
    // A set that only replaced fields comes back as puts — a peer's change
    // to another field is no conflict.
    link.disconnect();
    await a.set(id, { title: 'reset' });
    await tick();
    await b.inc(id, 'hits', 1);
    await link.reconnect();
    await settle([a, b]);
    assert.deepStrictEqual(await a.get(id), { title: 'reset', hits: 1 });
    assert.deepStrictEqual(await undo.undo(), { applied: 2, skipped: 0 });
    assert.deepStrictEqual(await a.get(id), { title: 'B', n: 2, hits: 1 }, 'the fields back, the peer’s counter kept');
    await settle([a, b]);
    // A set that added a field is undone field by field: the field it added
    // is unset again, and a peer's concurrent increment beside it is kept —
    // the counter the reset dropped comes back on top of it.
    link.disconnect();
    await a.set(id, { title: 'reset', extra: 1 });
    await tick();
    await b.inc(id, 'hits', 1);
    await link.reconnect();
    await settle([a, b]);
    assert.deepStrictEqual(await a.get(id), { title: 'reset', extra: 1, hits: 1 });
    assert.deepStrictEqual(await undo.undo(), { applied: 4, skipped: 0 }, 'two puts, an unset, an inc');
    assert.deepStrictEqual(await a.get(id), { title: 'B', n: 2, hits: 2 }, 'the fields back, extra gone, hits made up');
    await settle([a, b]);
    const onB = await b.get(id);
    assert.deepStrictEqual([onB.title, onB.n], ['B', 2]);
    // B's own sum straddled the reset (the documented counter/reset case): it reads one more there.
    assert.ok(onB.hits >= 2, `hits on B: ${onB.hits}`);
    // A delete is undone only by a whole-record write: with a concurrent
    // change the step is skipped whole, unless forced.
    link.disconnect();
    await a.delete(id);
    await tick();
    await b.inc(id, 'hits', 1);
    await link.reconnect();
    await settle([a, b]);
    assert.deepStrictEqual(await a.get(id), { hits: 1 }, 'B’s increment revived the record');
    const before = undo.size.undo;
    assert.deepStrictEqual(
      await undo.undo(),
      { applied: 0, skipped: 2 },
      'the write and the counter it would make again',
    );
    assert.deepStrictEqual(await a.get(id), { hits: 1 }, 'left alone');
    assert.strictEqual(undo.size.undo, before - 1, 'the step is spent either way');
    assert.strictEqual(undo.size.redo, 0, 'nothing was done, nothing to redo');
    await a.delete(id);
    await settle([a, b]);
    link.disconnect();
    await b.inc(id, 'hits', 1);
    await link.reconnect();
    await settle([a, b]);
    assert.deepStrictEqual(await a.get(id), { hits: 1 });
    assert.deepStrictEqual(
      await undo.undo({ force: true }),
      { applied: 2, skipped: 0 },
      'the write and the counter made again',
    );
    assert.deepStrictEqual(
      await a.get(id),
      { hits: 1 },
      'B’s increment went with the reset; the counter made again as it read',
    );
    await settle([a, b]);
    assert.deepStrictEqual(await b.get(id), { hits: 1 });
    undo.stop();
  });

  await t.test('an undone add revokes its own tag alone; counters undo across nodes', async (t2) => {
    const mesh = await createMesh(t2, ['A', 'B'], [['A', 'B']], createStorage);
    const a = mesh.get('A');
    const b = mesh.get('B');
    const undo = createUndo(a, { mergeInterval: 0 });
    const id = await a.insert({ n: 1 });
    await settle([a, b]);
    const link = mesh.links.get('mem://B');
    link.disconnect();
    await a.add(id, 'tags', ['x']);
    await tick();
    await b.add(id, 'tags', ['x']);
    await link.reconnect();
    await settle([a, b]);
    assert.deepStrictEqual(await undo.undo(), { applied: 1, skipped: 0 });
    await settle([a, b]);
    assert.deepStrictEqual((await a.get(id)).tags, ['x'], 'B’s add survives A’s undo');
    assert.deepStrictEqual((await b.get(id)).tags, ['x']);
    await a.inc(id, 'hits', 5);
    await settle([a, b]);
    await undo.undo();
    await settle([a, b]);
    // The step created the counter and nothing else changed since: it is
    // gone again, on both nodes.
    assert.deepStrictEqual([(await a.get(id)).hits, (await b.get(id)).hits], [undefined, undefined]);
    await a.inc(id, 'hits', 5);
    await settle([a, b]);
    link.disconnect();
    await b.inc(id, 'hits', 1);
    await tick();
    await link.reconnect();
    await settle([a, b]);
    await undo.undo();
    await settle([a, b]);
    assert.deepStrictEqual(
      [(await a.get(id)).hits, (await b.get(id)).hits],
      [1, 1],
      'beside B’s increment: taken down, not away',
    );
    undo.stop();
  });

  await t.test(
    'a failed undo inside one record leaves its landed ops landed; the retry takes back the rest',
    async (t2) => {
      let failing = false;
      const beforeWrite = (ctx) => {
        if (failing && ctx.type === 'set') throw new Error('not now');
      };
      const storage = await createStorage(t2, 'A', { hooks: { beforeWrite } });
      await storage.inc('r', 'views', 1);
      await storage.update('r', { title: 'Draft' });
      const undo = createUndo(storage, { mergeInterval: 1e9 });
      await storage.inc('r', 'views', 1);
      await storage.update('r', { title: 'Final' });
      // The step's inverse is two ops on one record: the inc lands, the hook refuses the set.
      failing = true;
      await assert.rejects(() => undo.undo(), { code: 'HOOK_FAILED' });
      assert.deepStrictEqual(await storage.get('r'), { views: 1, title: 'Final' });
      assert.deepStrictEqual(undo.size, { undo: 1, redo: 1 });
      failing = false;
      assert.deepStrictEqual(await undo.undo(), { applied: 1, skipped: 0 }, 'the set alone: the inc stays landed');
      assert.deepStrictEqual(await storage.get('r'), { views: 1, title: 'Draft' });
      // Redo brings it back in the two steps the undo left.
      await undo.redo();
      await undo.redo();
      assert.deepStrictEqual(await storage.get('r'), { views: 2, title: 'Final' });
      assert.deepStrictEqual(undo.size, { undo: 2, redo: 0 });
      undo.stop();
    },
  );

  await t.test(
    'a failed undo leaves what it took back taken back; the retry inverts the rest, never twice',
    async (t2) => {
      let failing = false;
      const beforeWrite = (ctx) => {
        if (failing && ctx.id === 'c') throw new Error('boom');
      };
      const storage = await createStorage(t2, 'A', { hooks: { beforeWrite } });
      const undo = createUndo(storage, { mergeInterval: 1e9 });
      for (const id of ['a', 'b', 'c']) await storage.set(id, { n: 0 });
      undo.mark();
      await storage.splice('a', 'body', 0, 0, 'abcde');
      await storage.inc('b', 'hits', 1);
      await storage.inc('c', 'hits', 2);
      assert.deepStrictEqual(undo.size, { undo: 2, redo: 0 });
      // The hook refuses the third record's inverse: the first two stand
      // inverted, the third as the step left it, and the stacks say so.
      failing = true;
      await assert.rejects(() => undo.undo(), { code: 'HOOK_FAILED' });
      assert.deepStrictEqual(await storage.get('a'), { n: 0 }, 'a was taken back');
      assert.deepStrictEqual(await storage.get('b'), { n: 0 }, 'b was taken back');
      assert.deepStrictEqual(
        await storage.get('c'),
        { n: 0, hits: 2 },
        'c, where the hook threw, is as the step left it',
      );
      assert.deepStrictEqual(
        undo.size,
        { undo: 2, redo: 1 },
        'a and b went to the redo stack; c waits on the undo stack',
      );
      failing = false;
      assert.deepStrictEqual(await undo.undo(), { applied: 1, skipped: 0 }, 'the retry inverts c alone');
      assert.deepStrictEqual(await storage.get('a'), { n: 0 }, 'a is not inverted twice');
      assert.deepStrictEqual(await storage.get('c'), { n: 0 });
      assert.deepStrictEqual(undo.size, { undo: 1, redo: 2 });
      // Redo brings the three back, in the two steps the undo left.
      await undo.redo();
      assert.deepStrictEqual(await storage.get('c'), { n: 0, hits: 2 });
      await undo.redo();
      assert.deepStrictEqual(await storage.get('a'), { n: 0, body: 'abcde' });
      assert.deepStrictEqual(await storage.get('b'), { n: 0, hits: 1 });
      assert.deepStrictEqual(undo.size, { undo: 3, redo: 0 });
      undo.stop();
    },
  );

  await t.test('the stack holds the log; limit, exclude and scope bound what it keeps; a purge forgets', async (t2) => {
    const storage = await createStorage(t2, 'A', { sync: { log: { rollAfter: 1 }, retention: { ops: 2 } } });
    const undo = createUndo(storage, { mergeInterval: 0, limit: 2, exclude: (op) => op.id === 'skip' });
    const id = await storage.insert({ n: 0 });
    const first = storage.log.lastEventId;
    for (let i = 1; i <= 6; i++) await storage.update(id, { n: i });
    assert.strictEqual(undo.size.undo, 2, 'limit');
    assert.ok(storage.log.floor <= storage.log.next - 2, 'the log is held from the oldest step');
    assert.ok(storage.log.since(first) === null, 'but not before it');
    await storage.set('skip', { secret: true });
    await storage.update('skip', { secret: false });
    assert.strictEqual(undo.size.undo, 2, 'excluded');
    // Undo of the two kept steps.
    await undo.undo();
    await undo.undo();
    assert.deepStrictEqual(await storage.get(id), { n: 4 });
    undo.clear();
    for (let i = 0; i < 4; i++) await storage.update(id, { n: 10 + i });
    assert.ok(storage.log.floor > 6, 'released: compaction goes on');
    // A purge forgets the record wherever it is on the stacks.
    await storage.update(id, { n: 'last' });
    assert.strictEqual(undo.size.undo, 2, 'the limit holds');
    await storage.purge(id);
    assert.deepStrictEqual(undo.size, { undo: 0, redo: 0 }, 'every step was of that record');
    assert.strictEqual(undo.canUndo, false);
    undo.stop();
    // A scoped manager: only the ops of its scope.
    const scoped = await createStorage(t2, 'S', { sync: { scope: (id, data) => data.room ?? '*' } });
    const manager = createUndo(scoped, { mergeInterval: 0, scope: 'red' });
    await scoped.insert({ room: 'red', n: 1 });
    await scoped.insert({ room: 'blue', n: 1 });
    await scoped.insert({ n: 1 });
    assert.strictEqual(manager.size.undo, 1);
    manager.stop();
    // close() stops the manager.
    const closing = await createStorage(t2, 'C');
    const m = createUndo(closing);
    await closing.insert({ x: 1 });
    assert.ok(m.canUndo);
    await closing.close();
    assert.deepStrictEqual(m.size, { undo: 0, redo: 0 });
  });
};

module.exports = { runUndoTests };
