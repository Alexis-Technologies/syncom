'use strict';

// The replication half of Storage: ops, counters, tombstones, the change
// event, applying a peer's ops, snapshots, and what survives a reopen.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs/promises');
const path = require('node:path');
const syncom = require('..');
const { createTemp, cleanupTemp } = require('./utils/temp.js');

const openTemp = async (t, options = {}) => {
  const dir = await createTemp();
  t.after(() => cleanupTemp(dir));
  const storage = await syncom.open({ path: dir, logger: false, ...options });
  return { dir, storage };
};

const remoteOp = (origin, seq, type, id, extra = {}) => ({ origin, seq, ts: Date.now() + seq, type, id, ...extra });

test('Storage replication model', async (t) => {
  await t.test('every local write is an op with this node as origin', async (t2) => {
    const { storage } = await openTemp(t2);
    const ops = [];
    storage.on('change', (op, via) => ops.push({ op, via }));

    const id = await storage.insert({ title: 'Draft', hits: 0 });
    await storage.update(id, { title: 'Final' });
    await storage.swap(id, { hits: 1 }, { hits: 0 });
    await storage.delete(id);

    assert.deepStrictEqual(
      ops.map(({ op }) => [op.type, op.seq]),
      [
        ['write', 1],
        ['set', 2],
        ['set', 3],
        ['delete', 4],
      ],
    );
    assert.ok(ops.every(({ op, via }) => op.origin === storage.nodeId && op.id === id && via === null));
    assert.deepStrictEqual(ops[1].op.data, { title: 'Final' });
    assert.deepStrictEqual(storage.vector, { [storage.nodeId]: 4 });
    assert.strictEqual(storage.log.length, 4);
    // Every op is signed under the node's key; a payload carries a salted digest.
    const { verifyOp } = require('../src/signing.js');
    for (const { op } of ops) {
      assert.match(op.sig, /^[A-Za-z0-9_-]{86}$/, op.type);
      assert.strictEqual(await verifyOp(op, 'require'), 'ok', op.type);
      assert.strictEqual('digest' in op, op.type !== 'delete', op.type);
      assert.strictEqual('nonce' in op, op.type !== 'delete', op.type);
    }
    assert.deepStrictEqual(
      storage.log.since(undefined).map((entry) => entry.op.sig),
      ops.map(({ op }) => op.sig),
      'the log holds the signed ops',
    );
  });

  await t.test(
    'every op this node mints is signed: a snapshot’s merges, the advance, a validated write',
    async (t2) => {
      const { verifyOp } = require('../src/signing.js');
      const { storage: a } = await openTemp(t2);
      const id = await a.insert({ n: 1 });
      await a.inc(id, 'hits', 2);
      const Post = (data) => ({ ...data, status: data.status ?? 'draft' });
      const { storage: b } = await openTemp(t2, { schema: { entities: { Post: { schema: Post } } } });
      const ops = [];
      b.on('change', (op) => ops.push(op));
      await b.mergeSnapshot((await a.snapshot()).records, { via: 'L', from: a.nodeId });
      await b.adoptVector(a.vector, { from: a.nodeId });
      // The validator's default is in the op the peers receive, and so under the digest.
      await b.Post.insert({ title: 'x' });
      assert.deepStrictEqual(
        ops.map((op) => [op.type, op.origin === b.nodeId, op.from ?? null]),
        [
          ['merge', true, a.nodeId],
          ['advance', true, a.nodeId],
          ['write', true, null],
        ],
      );
      assert.deepStrictEqual(ops[2].data, { title: 'x', status: 'draft', $type: 'Post' });
      for (const op of ops) {
        assert.strictEqual(await verifyOp(op, 'require'), 'ok', op.type);
        assert.ok(op.digest && op.nonce, `${op.type} carries a payload`);
      }
      assert.ok(b.log.since(undefined).every((entry) => typeof entry.op.sig === 'string'));
    },
  );

  await t.test('inc is a counter; a field is a register or a counter, never both', async (t2) => {
    const { storage } = await openTemp(t2);
    const id = await storage.insert({ name: 'Ada' });
    await storage.inc(id, 'hits', 2);
    await storage.inc(id, 'hits', 3);
    await storage.inc(id, 'hits');
    assert.deepStrictEqual(await storage.get(id), { name: 'Ada', hits: 6 });

    await assert.rejects(() => storage.update(id, { hits: 1 }), /counter; use inc\(\)/);
    await assert.rejects(() => storage.inc(id, 'name', 1), /register; use update\(\)/);
    await assert.rejects(() => storage.inc(id, 'hits', 'x'), TypeError);
    await assert.rejects(() => storage.inc(id, 7), TypeError);

    const record = await storage.record(id);
    await record.inc('hits', -1);
    assert.strictEqual(record.hits, 5);
    // A whole-record write resets the counter along with everything else.
    await storage.set(id, { name: 'Ada' });
    assert.deepStrictEqual(await storage.get(id), { name: 'Ada' });
  });

  await t.test('add and remove keep an observed-remove set; a field is one kind only', async (t2) => {
    const { storage } = await openTemp(t2);
    const ops = [];
    storage.on('change', (op) => ops.push(op));
    const id = await storage.insert({ name: 'Ada' });
    await storage.add(id, 'tags', ['bug', 'ui']);
    await storage.add(id, 'tags', ['api', 'bug']);
    assert.deepStrictEqual(await storage.get(id), { name: 'Ada', tags: ['api', 'bug', 'ui'] }, 'sorted by text');
    await storage.remove(id, 'tags', ['bug', 'nope']);
    assert.deepStrictEqual(await storage.get(id), { name: 'Ada', tags: ['api', 'ui'] });
    // The remove op carries the tags this node observed — the newest add
    // per origin — not the elements alone.
    const remove = ops.at(-1);
    assert.strictEqual(remove.type, 'remove');
    assert.deepStrictEqual(remove.value, [['bug', { [storage.nodeId]: ops[2].ts }]]);
    assert.deepStrictEqual(
      ops.map((op) => op.type),
      ['write', 'add', 'add', 'remove'],
    );
    // Removing what was never added changes nothing: no op.
    await storage.remove(id, 'tags', ['nope']);
    await storage.remove(id, 'other', ['x']);
    assert.strictEqual(ops.length, 4);
    // The kind rule, with a hint at the right call.
    await assert.rejects(() => storage.update(id, { tags: [] }), /set; use add\(\) or remove\(\)/);
    await assert.rejects(() => storage.inc(id, 'tags'), /set; use add\(\) or remove\(\)/);
    await assert.rejects(() => storage.add(id, 'name', ['x']), /register; use update\(\)/);
    await storage.inc(id, 'hits');
    await assert.rejects(() => storage.remove(id, 'hits', ['x']), /counter; use inc\(\)/);
    // Arguments.
    await assert.rejects(() => storage.add(id, 7, ['x']), TypeError);
    await assert.rejects(() => storage.add(id, 'tags', 'x'), TypeError);
    await assert.rejects(() => storage.add(id, 'tags', []), TypeError);
    await assert.rejects(() => storage.add(id, 'tags', [undefined]), TypeError);
    await assert.rejects(() => storage.remove(id, 'tags', [() => 1]), TypeError);
    // Through a live Record, which follows along.
    const record = await storage.record(id);
    await record.add('tags', ['docs']);
    assert.deepStrictEqual(record.tags, ['api', 'docs', 'ui']);
    await record.remove('tags', ['ui']);
    assert.deepStrictEqual(record.tags, ['api', 'docs']);
    // The caller's array is copied, not kept.
    const mine = ['mine'];
    await storage.add(id, 'tags', mine);
    mine.push('later');
    assert.deepStrictEqual((await storage.get(id)).tags, ['api', 'docs', 'mine']);
    // A whole-record write resets the set along with everything else; the
    // field is free to be a register after that.
    await storage.set(id, { name: 'Ada' });
    assert.deepStrictEqual(await storage.get(id), { name: 'Ada' });
    await storage.update(id, { tags: ['plain'] });
    assert.deepStrictEqual(await storage.get(id), { name: 'Ada', tags: ['plain'] });
    // An add creates the field, and the record, when absent.
    await storage.add('fresh', 'tags', ['x']);
    assert.deepStrictEqual(await storage.get('fresh'), { tags: ['x'] });
    assert.strictEqual(await storage.validate(), true);
  });

  await t.test('splice and push keep a list or a text; a field is one kind only', async (t2) => {
    const { storage } = await openTemp(t2);
    const ops = [];
    storage.on('change', (op) => ops.push(op));
    const id = await storage.insert({ name: 'Ada' });
    await storage.splice(id, 'body', 0, 0, 'helo');
    await storage.splice(id, 'body', 3, 0, 'l');
    await storage.push(id, 'body', ' world');
    assert.deepStrictEqual(await storage.get(id), { name: 'Ada', body: 'hello world' });
    await storage.splice(id, 'body', 5, 6);
    assert.deepStrictEqual(await storage.get(id), { name: 'Ada', body: 'hello' });
    // What travels: a run anchored at the head, one anchored inside it, an
    // extension of this node's own run, and a cut naming its ranges.
    assert.deepStrictEqual(
      ops.map((op) => op.type),
      ['write', 'splice', 'splice', 'splice', 'splice'],
    );
    const [, first, inside, appended, cut] = ops;
    const run = `${first.ts}:${storage.nodeId}`;
    assert.deepStrictEqual(first.value, { at: '^', content: 'helo' });
    assert.deepStrictEqual(inside.value, { at: `<${first.ts}:3:${storage.nodeId}`, content: 'l' });
    assert.deepStrictEqual(appended.value, { run, from: 4, content: ' world' });
    assert.deepStrictEqual(cut.value, { cut: [[run, 4, 6]], content: '' });
    assert.strictEqual(cut.key, 'body');
    // A list holds JSON values; a call that only cuts takes the field's kind.
    await storage.push(id, 'items', [{ n: 1 }, 'two']);
    await storage.splice(id, 'items', 1, 1, [2, 3]);
    assert.deepStrictEqual((await storage.get(id)).items, [{ n: 1 }, 2, 3]);
    await storage.splice(id, 'items', 0, 1);
    assert.deepStrictEqual((await storage.get(id)).items, [2, 3]);
    assert.deepStrictEqual(ops.at(-1).value.content, []);
    // Out of range is a coded error, decided inside the queue.
    await assert.rejects(() => storage.splice(id, 'body', 6, 0, 'x'), {
      name: 'SyncomError',
      code: 'OUT_OF_RANGE',
      field: 'body',
      index: 6,
      count: 0,
      length: 5,
    });
    await assert.rejects(() => storage.splice(id, 'body', 4, 2), {
      code: 'OUT_OF_RANGE',
      index: 4,
      count: 2,
      length: 5,
    });
    await assert.rejects(() => storage.splice(id, 'nope', 0, 1), { code: 'OUT_OF_RANGE', length: 0 });
    // The kind rule, with a hint at the right call.
    await assert.rejects(() => storage.update(id, { body: 'plain' }), /text; use splice\(\) or push\(\)/);
    await assert.rejects(() => storage.inc(id, 'items'), /list; use splice\(\), push\(\), setAt\(\) or move\(\)/);
    await assert.rejects(() => storage.add(id, 'body', ['x']), /text; use splice\(\)/);
    await assert.rejects(() => storage.splice(id, 'name', 0, 0, 'x'), /register; use update\(\)/);
    await assert.rejects(() => storage.push(id, 'items', 'text'), /list; use splice\(\), push/);
    await storage.inc(id, 'hits');
    await assert.rejects(() => storage.push(id, 'hits', 'x'), /counter; use inc\(\)/);
    await storage.add(id, 'tags', ['t']);
    await assert.rejects(() => storage.splice(id, 'tags', 0, 0, ['x']), /set; use add\(\) or remove\(\)/);
    // Arguments.
    await assert.rejects(() => storage.splice(id, 7, 0, 0, 'x'), TypeError);
    await assert.rejects(() => storage.splice(id, 'body', -1, 0, 'x'), TypeError);
    await assert.rejects(() => storage.splice(id, 'body', 0, -1, 'x'), TypeError);
    await assert.rejects(() => storage.splice(id, 'body', 0, 0, 5), TypeError);
    await assert.rejects(() => storage.splice(id, 'body', 0, 0), TypeError);
    await assert.rejects(() => storage.splice(id, 'body', 0, 0, ''), TypeError);
    await assert.rejects(() => storage.push(id, 'items', [undefined]), TypeError);
    await assert.rejects(() => storage.push(id, 'items', [() => 1]), TypeError);
    // Through a live Record, which follows along.
    const record = await storage.record(id);
    await record.splice('body', 0, 1, 'H');
    assert.strictEqual(record.body, 'Hello');
    await record.push('items', [4]);
    assert.deepStrictEqual(record.items, [2, 3, 4]);
    // The caller's array is copied, not kept.
    const mine = [{ x: 1 }];
    await storage.push(id, 'items', mine);
    mine[0].x = 2;
    mine.push('later');
    assert.deepStrictEqual((await storage.get(id)).items, [2, 3, 4, { x: 1 }]);
    // A whole-record write resets the text along with everything else; the
    // field is free to be a register after that.
    await storage.set(id, { name: 'Ada' });
    assert.deepStrictEqual(await storage.get(id), { name: 'Ada' });
    await storage.update(id, { body: 'plain' });
    assert.deepStrictEqual(await storage.get(id), { name: 'Ada', body: 'plain' });
    // A splice creates the field, and the record, when absent.
    await storage.splice('fresh', 'body', 0, 0, 'x');
    assert.deepStrictEqual(await storage.get('fresh'), { body: 'x' });
    assert.strictEqual(await storage.validate(), true);
  });

  await t.test('updateText diffs the field inside the queue and sends one splice per hunk', async (t2) => {
    const { storage } = await openTemp(t2);
    const ops = [];
    storage.on('change', (op) => ops.push(op));
    const id = await storage.insert({ title: 'note' });
    assert.strictEqual(await storage.updateText(id, 'body', 'the quick brown fox'), 1, 'one op creates the field');
    assert.strictEqual(await storage.updateText(id, 'body', 'the slow brown dog'), 3, 'one op per hunk');
    assert.strictEqual((await storage.get(id)).body, 'the slow brown dog');
    assert.deepStrictEqual(
      ops.slice(1).map((op) => [op.type, op.key]),
      Array(4).fill(['splice', 'body']),
    );
    assert.strictEqual(await storage.updateText(id, 'body', 'the slow brown dog'), 0, 'nothing to do, no op');
    assert.strictEqual(ops.length, 5);
    assert.strictEqual(await storage.updateText(id, 'body', ''), 1, 'emptied, the field stays a text');
    assert.strictEqual((await storage.get(id)).body, '');
    // Another kind under the field is refused for it; arguments.
    await assert.rejects(() => storage.updateText(id, 'title', 'x'), /register; use update\(\)/);
    await storage.push(id, 'items', [1]);
    await assert.rejects(() => storage.updateText(id, 'items', 'x'), /list; use splice\(\), push/);
    await assert.rejects(() => storage.updateText(id, 7, 'x'), TypeError);
    await assert.rejects(() => storage.updateText(id, 'body', 5), TypeError);
    await assert.rejects(() => storage.updateText('bad id!', 'body', 'x'), { code: 'INVALID_ID' });
    // Through a live Record; a reset frees the field as for any kind.
    const record = await storage.record(id);
    assert.strictEqual(await record.updateText('body', 'hello'), 1);
    assert.strictEqual(record.body, 'hello');
    await storage.set(id, { title: 'note' });
    assert.strictEqual(await storage.updateText(id, 'body', 'again'), 1);
    assert.deepStrictEqual(await storage.get(id), { title: 'note', body: 'again' });
    assert.strictEqual(await storage.validate(), true);
  });

  await t.test('setAt and move keep an element’s name; a move names where it shows', async (t2) => {
    const { storage } = await openTemp(t2);
    const ops = [];
    storage.on('change', (op) => ops.push(op));
    const id = await storage.insert({ name: 'list' });
    await storage.push(id, 'items', ['a', 'b', 'c']);
    await storage.setAt(id, 'items', 1, 'B');
    assert.deepStrictEqual((await storage.get(id)).items, ['a', 'B', 'c']);
    await storage.move(id, 'items', 0, 2);
    assert.deepStrictEqual((await storage.get(id)).items, ['B', 'c', 'a']);
    await storage.move(id, 'items', 2, 0);
    assert.deepStrictEqual((await storage.get(id)).items, ['a', 'B', 'c']);
    await storage.move(id, 'items', 1, 1);
    assert.deepStrictEqual(
      ops.map((op) => op.type),
      ['write', 'splice', 'assign', 'move', 'move'],
      'a move to the same place is nothing',
    );
    const run = `${ops[1].ts}:${storage.nodeId}`;
    assert.deepStrictEqual(ops[2].value, { elem: `${ops[1].ts}:1:${storage.nodeId}`, value: 'B' });
    assert.deepStrictEqual(ops[3].value, {
      elem: `${ops[1].ts}:0:${storage.nodeId}`,
      cut: [run, 0, 1],
      at: `>${ops[1].ts}:2:${storage.nodeId}`,
      value: 'a',
    });
    assert.strictEqual(ops[4].value.elem, ops[3].value.elem, 'the element keeps its name across moves');
    assert.deepStrictEqual(
      ops[4].value.cut,
      [`${ops[3].ts}:${storage.nodeId}`, 0, 1],
      'the slot it showed at was its position run',
    );
    // The value follows the element: set after a move, read at the new place.
    await storage.setAt(id, 'items', 0, 'A');
    assert.deepStrictEqual((await storage.get(id)).items, ['A', 'B', 'c']);
    // Out of range, the kind rule, arguments.
    await assert.rejects(() => storage.setAt(id, 'items', 3, 'x'), { code: 'OUT_OF_RANGE', index: 3, length: 3 });
    await assert.rejects(() => storage.move(id, 'items', 0, 3), { code: 'OUT_OF_RANGE', index: 3, length: 3 });
    await assert.rejects(() => storage.move(id, 'items', 5, 0), { code: 'OUT_OF_RANGE', index: 5, length: 3 });
    await storage.splice(id, 'body', 0, 0, 'text');
    await assert.rejects(() => storage.setAt(id, 'body', 0, 'x'), /text; use splice\(\) or push\(\)/);
    await storage.move(id, 'name', 0, 0); // from === to is nothing, even on a register
    await assert.rejects(() => storage.move(id, 'name', 0, 1), /register; use update\(\)/);
    await assert.rejects(() => storage.setAt(id, 'name', 0, 'x'), /register; use update\(\)/);
    await assert.rejects(() => storage.setAt(id, 'nope', 0, 'x'), { code: 'OUT_OF_RANGE', length: 0 });
    await assert.rejects(() => storage.setAt(id, 7, 0, 'x'), TypeError);
    await assert.rejects(() => storage.setAt(id, 'items', -1, 'x'), TypeError);
    await assert.rejects(() => storage.setAt(id, 'items', 0, undefined), TypeError);
    await assert.rejects(() => storage.move(id, 'items', 'a', 0), TypeError);
    // Through a live Record.
    const record = await storage.record(id);
    await record.move('items', 2, 0);
    assert.deepStrictEqual(record.items, ['c', 'A', 'B']);
    await record.setAt('items', 0, 'C');
    assert.deepStrictEqual(record.items, ['C', 'A', 'B']);
    assert.strictEqual(await storage.validate(), true);
  });

  await t.test('a peer’s set ops land in any order; a write on a set field is refused for that field', async (t2) => {
    const { storage } = await openTemp(t2);
    const errors = [];
    storage.on('error', (error) => errors.push(error));
    const t0 = Date.now();
    // The remove arrives before the add it observed: that add is dead on arrival.
    const tags = [['x', { p1: t0 + 1 }]];
    await storage.applyRemote([remoteOp('p2', 1, 'remove', 'r', { key: 'tags', value: tags, ts: t0 + 5 })]);
    assert.deepStrictEqual(await storage.get('r'), { tags: [] });
    await storage.applyRemote([remoteOp('p1', 1, 'add', 'r', { key: 'tags', value: ['x', 'y'], ts: t0 + 1 })]);
    assert.deepStrictEqual(await storage.get('r'), { tags: ['y'] });
    // A peer's set on the field is refused for that field alone, as an event.
    const result = await storage.applyRemote([remoteOp('p3', 1, 'set', 'r', { data: { tags: ['z'], note: 'n' } })]);
    assert.strictEqual(result.applied, 1);
    assert.deepStrictEqual(await storage.get('r'), { tags: ['y'], note: 'n' });
    assert.deepStrictEqual(
      errors.map((error) => [error.code, error.rejected]),
      [['OP_REFUSED', [{ field: 'tags', reason: 'set' }]]],
    );
    // And the local writer is told the same.
    await assert.rejects(() => storage.update('r', { tags: [] }), { code: 'FIELD_KIND', kind: 'set' });
    await storage.add('r', 'tags', ['local']);
    assert.deepStrictEqual((await storage.get('r')).tags, ['local', 'y']);
  });

  await t.test('delete leaves a tombstone: hidden from get/has/list, kept on disk', async (t2) => {
    const { dir, storage } = await openTemp(t2);
    const keep = await storage.insert({ n: 1 });
    const gone = await storage.insert({ n: 2 });
    await storage.delete(gone);

    assert.strictEqual(await storage.get(gone), null);
    assert.strictEqual(await storage.has(gone), false);
    assert.strictEqual(storage.getCachedData(gone), null);
    assert.deepStrictEqual(await storage.list(), [keep].sort());
    const entry = JSON.parse(await fs.readFile(path.join(dir, 'data', `${gone}.json`), 'utf8'));
    assert.ok(entry.meta.deleted, 'the tombstone stamp is on disk');
    // A later write to the same id revives it.
    await storage.set(gone, { n: 3 });
    assert.deepStrictEqual(await storage.get(gone), { n: 3 });
    assert.strictEqual((await storage.list()).length, 2);
    // update() on a dead record is "not found".
    await storage.delete(gone);
    await assert.rejects(() => storage.update(gone, { n: 4 }), { code: 'NOT_FOUND', message: /not found/ });
  });

  await t.test('applyRemote: in order per origin, duplicates and gaps skipped', async (t2) => {
    const { storage } = await openTemp(t2);
    const changes = [];
    storage.on('change', (op, via) => changes.push({ op, via }));

    const first = await storage.applyRemote([remoteOp('peer', 1, 'write', 'r1', { data: { a: 1 } })], { via: 'L' });
    assert.deepStrictEqual(first, {
      applied: 1,
      skipped: 0,
      duplicates: 0,
      gaps: 0,
      malformed: 0,
      unsigned: 0,
      forged: 0,
      outOfScope: 0,
    });
    assert.deepStrictEqual(await storage.get('r1'), { a: 1 });
    assert.deepStrictEqual(changes[0].via, 'L');
    assert.strictEqual(changes[0].op.origin, 'peer');

    const again = await storage.applyRemote([
      remoteOp('peer', 1, 'write', 'r1', { data: { a: 1 } }),
      remoteOp('peer', 3, 'set', 'r1', { data: { b: 1 } }),
      { origin: storage.nodeId, seq: 1, ts: 1, type: 'write', id: 'x', data: {} },
      'garbage',
    ]);
    assert.deepStrictEqual(again, {
      applied: 0,
      skipped: 0,
      duplicates: 2,
      gaps: 1,
      malformed: 1,
      unsigned: 0,
      forged: 0,
      outOfScope: 0,
    });
    assert.deepStrictEqual(await storage.get('r1'), { a: 1 });

    const next = await storage.applyRemote([
      remoteOp('peer', 2, 'set', 'r1', { data: { b: 2 } }),
      remoteOp('peer', 3, 'inc', 'r1', { key: 'n', value: 4 }),
      remoteOp('peer', 4, 'delete', 'r1'),
    ]);
    assert.deepStrictEqual(next, {
      applied: 3,
      skipped: 0,
      duplicates: 0,
      gaps: 0,
      malformed: 0,
      unsigned: 0,
      forged: 0,
      outOfScope: 0,
    });
    assert.strictEqual(await storage.get('r1'), null);
    assert.deepStrictEqual(storage.vector, { peer: 4 });
    // Accepted-but-unchanged ops still advance the vector and are logged.
    const noop = await storage.applyRemote([remoteOp('peer', 5, 'set', 'r1', { data: { b: 0 }, ts: 1 })]);
    assert.strictEqual(noop.applied, 1);
    assert.strictEqual(storage.vector.peer, 5);
    assert.strictEqual(storage.log.length, 5);
    assert.strictEqual(await storage.validate(), true);
  });

  await t.test('a refused remote op surfaces as an error event, not a throw', async (t2) => {
    const { storage } = await openTemp(t2);
    const errors = [];
    storage.on('error', (error) => errors.push(error));
    const id = await storage.insert({ hits: 'text' });
    const result = await storage.applyRemote([remoteOp('peer', 1, 'inc', id, { key: 'hits', value: 1 })]);
    assert.strictEqual(result.applied, 1);
    assert.strictEqual(errors.length, 1);
    assert.deepStrictEqual(errors[0].rejected, [{ field: 'hits', reason: 'register' }]);
    assert.deepStrictEqual(await storage.get(id), { hits: 'text' });
  });

  await t.test('a live Record follows remote changes and keeps unsaved edits', async (t2) => {
    const { storage } = await openTemp(t2);
    const id = await storage.insert({ title: 'Draft', views: 0 });
    const record = await storage.record(id);
    const updates = [];
    record.on('update', (data, delta) => updates.push({ data: data === null ? null : { ...data }, delta }));

    record.title = 'Local edit'; // staged, not saved
    await storage.applyRemote([remoteOp('peer', 1, 'set', id, { data: { views: 7 } })]);
    assert.strictEqual(record.views, 7);
    assert.strictEqual(record.title, 'Local edit', 'the pending edit is laid back on top');
    assert.deepStrictEqual(updates.at(-1).delta, { views: 7 });

    await record.save();
    assert.deepStrictEqual(await storage.get(id), { title: 'Local edit', views: 7 });
    // The save itself does not echo an update to its own listeners.
    assert.strictEqual(updates.length, 2);

    await storage.applyRemote([remoteOp('peer', 2, 'delete', id)]);
    assert.strictEqual(updates.at(-1).data, null);
    assert.strictEqual(await record.data(), null);
  });

  await t.test('snapshot pages every entry, tombstones included; mergeSnapshot joins them', async (t2) => {
    const { storage: a } = await openTemp(t2);
    const { storage: b } = await openTemp(t2);
    const ids = [];
    for (let i = 0; i < 5; i++) ids.push(await a.insert({ i }));
    await a.inc(ids[0], 'hits', 3);
    await a.delete(ids[4]);
    await a.saveData('secret', { s: 1 }, { encrypted: true });

    const page1 = await a.snapshot({ limit: 3 });
    assert.strictEqual(page1.records.length, 3);
    assert.ok(page1.cursor);
    assert.strictEqual(page1.eventId, a.log.lastEventId);
    const page2 = await a.snapshot({ cursor: page1.cursor, limit: 3 });
    assert.strictEqual(page2.cursor, null);
    const records = [...page1.records, ...page2.records];
    assert.strictEqual(records.length, 5, 'the tombstone travels, the encrypted record does not');

    await b.mergeSnapshot(records);
    const replicated = (await a.list()).filter((id) => id !== 'secret').sort();
    assert.deepStrictEqual((await b.list()).sort(), replicated);
    assert.deepStrictEqual(await b.get(ids[0]), { i: 0, hits: 3 });
    assert.strictEqual(await b.get(ids[4]), null);
    // Joined state is in B's own log as merge ops — a peer of B can get it.
    assert.strictEqual(b.log.since(b.log.formatId(0)).filter((e) => e.op.type === 'merge').length, 5);
    // Merging the same snapshot again changes nothing.
    const before = b.log.length;
    await b.mergeSnapshot(records);
    assert.strictEqual(b.log.length, before);
    // Ops from A that were already folded in are harmless duplicates of state.
    const aOps = a.log.since(a.log.formatId(0)).map((e) => e.op);
    await b.applyRemote(aOps);
    assert.deepStrictEqual(await b.get(ids[0]), { i: 0, hits: 3 });
  });

  await t.test('scopes ride on ops and filter snapshots', async (t2) => {
    const { storage } = await openTemp(t2, { sync: { scope: (id, data) => data.$type ?? '*' } });
    const ops = [];
    storage.on('change', (op) => ops.push(op));
    const global = await storage.insert({ n: 1 });
    const doc = await storage.insert({ $type: 'Doc', n: 2 });
    assert.strictEqual(ops[0].scope, undefined);
    assert.strictEqual(ops[1].scope, 'Doc');
    const docs = await storage.snapshot({ scopes: ['Doc'] });
    assert.deepStrictEqual(docs.records.map((r) => r.id).sort(), [global, doc].sort());
    const other = await storage.snapshot({ scopes: ['Other'] });
    assert.deepStrictEqual(
      other.records.map((r) => r.id),
      [global],
    );
  });

  await t.test('identity, seq and vector survive a reopen; what was logged but not written is replayed', async (t2) => {
    const dir = await createTemp();
    t2.after(() => cleanupTemp(dir));
    // A backend whose record writes fail on demand: the op is in the log, the
    // record is not — what a crash between the two leaves behind.
    const base = require('../src/fsi.js');
    let failing = null;
    const fsi = {
      ...base,
      write: async (dir2, name, content, options) => {
        if (failing !== null && dir2.endsWith('data') && name === `${failing}.json`) throw new Error('ENOSPC');
        return base.write(dir2, name, content, options);
      },
    };
    const first = await syncom.open({ path: dir, logger: false, fsi, sync: { log: { rollAfter: 1 } } });
    const errors = [];
    first.on('error', (error) => errors.push(error));
    const id = await first.insert({ n: 1 });
    failing = 'lost';
    // Logged is committed: the write stands, held in memory, and says so.
    await first.set('lost', { p: 1 });
    assert.strictEqual(errors[0].code, 'UNPERSISTED');
    assert.match(errors[0].cause.message, /ENOSPC/);
    assert.deepStrictEqual(await first.get('lost'), { p: 1 });
    failing = null;
    await first.applyRemote([remoteOp('peer', 1, 'write', 'r', { data: { p: 1 } })]);
    const { nodeId } = first;
    assert.ok(
      first.log.tail().some((entry) => entry.op.id === 'lost'),
      'a batch whose record write failed is never sealed, whatever lands after it',
    );
    await first.close();
    await assert.rejects(() => first.insert({ n: 2 }), /closed/);
    assert.strictEqual(await fsi.exists(path.join(dir, 'data'), 'lost.json'), false);

    const second = await syncom.open({ path: dir, logger: false, fsi });
    assert.strictEqual(second.nodeId, nodeId);
    assert.deepStrictEqual(second.vector, { [nodeId]: 2, peer: 1 });
    assert.deepStrictEqual(await second.get('lost'), { p: 1 }, 'replayed from the log');
    assert.deepStrictEqual(await second.get(id), { n: 1 });
    assert.deepStrictEqual(await second.get('r'), { p: 1 });
    const ops = [];
    second.on('change', (op) => ops.push(op));
    await second.insert({ n: 3 });
    assert.strictEqual(ops[0].seq, 3, 'the own seq continues, never repeats');
    assert.strictEqual(await second.validate(), true);
    await second.close();
    const third = await syncom.open({ path: dir, logger: false, fsi });
    assert.strictEqual(third.log.tail().length, 0, 'once every record is written, a clean close seals everything');
    await third.close();
  });

  await t.test('a record this node cannot read does not stop a page: its op is skipped and reported', async (t2) => {
    const dir = await createTemp();
    t2.after(() => cleanupTemp(dir));
    const first = await syncom.open({ path: dir, logger: false });
    const bad = await first.insert({ n: 1 });
    await first.close();
    await fs.writeFile(path.join(dir, 'data', `${bad}.json`), '{not json');
    const storage = await syncom.open({ path: dir, logger: false });
    t2.after(() => storage.close().catch(() => {}));
    const errors = [];
    storage.on('error', (error) => errors.push(error));
    const result = await storage.applyRemote([
      remoteOp('peer', 1, 'set', bad, { data: { n: 2 } }),
      remoteOp('peer', 2, 'write', 'fine', { data: { n: 3 } }),
    ]);
    assert.deepStrictEqual(result, {
      applied: 2,
      skipped: 1,
      duplicates: 0,
      gaps: 0,
      malformed: 0,
      unsigned: 0,
      forged: 0,
      outOfScope: 0,
    });
    assert.strictEqual(errors.length, 1);
    assert.strictEqual(errors[0].code, 'OP_UNREADABLE');
    assert.strictEqual(errors[0].op.id, bad);
    assert.ok(errors[0].cause instanceof Error);
    assert.deepStrictEqual(await storage.get('fine'), { n: 3 });
    assert.strictEqual(storage.vector.peer, 2, 'the stream went on');
    const logged = storage.log.since(undefined).find((entry) => entry.op.origin === 'peer' && entry.op.id === bad);
    assert.strictEqual(logged.skipped, true, 'logged and flagged, so a replay leaves it alone too');
    // The torn file is evidence, reported with a code, never a bare SyntaxError.
    await assert.rejects(() => storage.get(bad), { code: 'INTEGRITY', id: bad });
  });

  await t.test('a local write outranks a snapshot joined from a peer whose clock is ahead', async (t2) => {
    const { storage } = await openTemp(t2);
    const ahead = Date.now() + 3_600_000;
    const meta = (clock, extra = {}) => ({ clock, base: null, deleted: null, counters: {}, ...extra });
    await storage.mergeSnapshot([
      { id: 'reg', data: { title: 'remote' }, meta: meta({ title: [ahead, 'peer'] }) },
      { id: 'reset', data: { n: 1 }, meta: meta({ n: [ahead, 'peer'] }, { base: [ahead, 'peer'] }) },
      { id: 'gone', data: {}, meta: meta({}, { base: [ahead, 'peer'], deleted: [ahead, 'peer'] }) },
    ]);
    const ops = [];
    storage.on('change', (op) => ops.push(op));
    await storage.update('reg', { title: 'local' });
    assert.deepStrictEqual(await storage.get('reg'), { title: 'local' });
    assert.ok(ops.at(-1).ts > ahead, 'stamped above the joined clock');
    await storage.delete('reset');
    assert.strictEqual(await storage.get('reset'), null, 'a delete lands above a joined reset');
    await storage.inc('gone', 'hits', 1);
    assert.deepStrictEqual(await storage.get('gone'), { hits: 1 }, 'a counter lands above a joined tombstone');
    // Joining the same, now older, snapshot again is still a no-op.
    const before = ops.length;
    await storage.mergeSnapshot([{ id: 'reg', data: { title: 'remote' }, meta: meta({ title: [ahead, 'peer'] }) }]);
    assert.strictEqual(ops.length, before);
    assert.deepStrictEqual(await storage.get('reg'), { title: 'local' });
  });

  await t.test('the clock survives a reopen: a node never stamps below what it already holds', async (t2) => {
    const dir = await createTemp();
    t2.after(() => cleanupTemp(dir));
    const ahead = Date.now() + 3_600_000;
    // rollAfter 1 seals every append: the reopen has no tail to replay from.
    const options = { path: dir, logger: false, sync: { log: { rollAfter: 1 } } };
    const first = await syncom.open(options);
    await first.applyRemote([{ origin: 'peer', seq: 1, ts: ahead, type: 'write', id: 'r', data: { n: 1 } }]);
    await first.close();

    const second = await syncom.open(options);
    assert.strictEqual(second.log.tail().length, 0, 'everything is sealed');
    assert.ok(second.log.latestTs >= ahead, 'the log remembers the newest stamp it holds');
    const ops = [];
    second.on('change', (op) => ops.push(op));
    await second.update('r', { n: 2 });
    assert.deepStrictEqual(await second.get('r'), { n: 2 }, 'an update to the peer-stamped record lands');
    assert.ok(ops[0].ts > ahead);
    // A write to an unrelated record is stamped above too: the node's own
    // stream never runs backwards across a reopen.
    await second.insert({ fresh: true });
    assert.ok(ops[1].ts > ops[0].ts);
  });

  await t.test('encrypted records stay local', async (t2) => {
    const { storage } = await openTemp(t2);
    const ops = [];
    storage.on('change', (op) => ops.push(op));
    await storage.saveData('s', { secret: 1 }, { encrypted: true });
    assert.strictEqual(ops.length, 0);
    assert.deepStrictEqual(await storage.get('s'), { secret: 1 });
    assert.strictEqual(await storage.has('s'), true);
    assert.deepStrictEqual(await storage.list(), ['s']);
    // Local writes work; they simply never become ops.
    await storage.update('s', { secret: 2 });
    assert.deepStrictEqual(await storage.get('s'), { secret: 2 });
    await assert.rejects(() => storage.inc('s', 'n', 1), /encrypted/);
    assert.strictEqual(ops.length, 0);
    const result = await storage.applyRemote([remoteOp('peer', 1, 'set', 's', { data: { secret: 3 } })]);
    assert.strictEqual(result.applied, 1);
    assert.deepStrictEqual(await storage.get('s'), { secret: 2 });
    assert.deepStrictEqual((await storage.snapshot()).records, []);
  });
});

test('Storage: the seams telemetry shares', async (t) => {
  await t.test('a refused op with no error listener is still logged and answered', async (t2) => {
    // Emitter throws on an unheard `error`; before the guard, that throw
    // failed the whole push and the peer offered the same page forever.
    const { storage } = await openTemp(t2);
    const id = await storage.insert({ hits: 'text' });
    const result = await storage.applyRemote([remoteOp('peer', 1, 'inc', id, { key: 'hits', value: 1 })]);
    assert.strictEqual(result.applied, 1);
    assert.strictEqual(storage.vector.peer, 1);
    assert.deepStrictEqual(await storage.get(id), { hits: 'text' });
  });

  await t.test('the storage logger reaches the op log', async (t2) => {
    const events = [];
    const logger = { warn: (entry) => events.push(entry) };
    const { dir, storage } = await openTemp(t2, { logger, sync: { log: { rollAfter: 1 } } });
    await storage.insert({ n: 1 });
    await storage.close();
    // One sealed segment on disk; corrupt it and reopen.
    const logDir = path.join(dir, 'log');
    const segment = (await fs.readdir(logDir)).find((name) => name.startsWith('seg-'));
    assert.ok(segment, 'a segment was sealed');
    await fs.writeFile(path.join(logDir, segment), '{not json');
    await syncom.open({ path: dir, logger });
    assert.strictEqual(
      events.some((entry) => entry.event === 'log.segment.unreadable'),
      true,
    );
  });
});

test('Storage announces close', async (t) => {
  const { storage } = await openTemp(t);
  const closed = [];
  storage.on('close', () => closed.push(true));
  await storage.close();
  await storage.close();
  assert.deepStrictEqual(closed, [true], 'once, and not again for a second close()');
});

test('Storage: events are contained', async (t) => {
  const collect = () => {
    const entries = [];
    return { entries, logger: { warn: (entry) => entries.push(entry), info() {}, debug() {}, error() {} } };
  };

  await t.test('a change listener that throws does not fail the write it observed', async (t2) => {
    const { entries, logger } = collect();
    const { storage } = await openTemp(t2, { logger });
    const seen = [];
    storage.on('change', () => {
      throw new Error('listener boom');
    });
    storage.on('change', (op) => seen.push(op.type));
    const id = await storage.insert({ a: 1 });
    assert.deepStrictEqual(await storage.get(id), { a: 1 });
    assert.deepStrictEqual(seen, ['write']);
    const remote = await storage.applyRemote([remoteOp('peer', 1, 'write', 'r1', { data: { b: 1 } })]);
    assert.strictEqual(remote.applied, 1);
    await new Promise((resolve) => setImmediate(resolve));
    const logged = entries.filter((entry) => entry.event === 'listener.error');
    assert.strictEqual(logged.length, 2);
    assert.strictEqual(logged[0].name, 'change');
    assert.strictEqual(logged[0].err.message, 'listener boom');
  });

  await t.test('a change listener that writes back queues behind the write instead of deadlocking', async (t2) => {
    const { storage } = await openTemp(t2);
    const id = await storage.insert({ n: 0 });
    let echoed = null;
    storage.once('change', (op) => {
      echoed = storage.update(op.id, { echoed: true });
    });
    await storage.update(id, { n: 1 });
    await echoed;
    assert.deepStrictEqual(await storage.get(id), { n: 1, echoed: true });
  });

  await t.test('a record update listener that throws does not break the setter or the refresh', async (t2) => {
    const { entries, logger } = collect();
    const { storage } = await openTemp(t2, { logger });
    const id = await storage.insert({ title: 'a' });
    const record = await storage.record(id);
    const rejections = [];
    const onRejection = (reason) => rejections.push(reason);
    process.on('unhandledRejection', onRejection);
    t2.after(() => process.off('unhandledRejection', onRejection));
    record.on('update', () => {
      throw new Error('update boom');
    });
    assert.doesNotThrow(() => {
      record.title = 'b';
    });
    await storage.applyRemote([remoteOp('peer', 1, 'set', id, { data: { views: 1 } })]);
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(record.views, 1);
    assert.deepStrictEqual(rejections, []);
    assert.strictEqual(entries.filter((entry) => entry.event === 'listener.error').length, 2);
  });
});

test("Storage: what a peer's op must look like", async (t) => {
  await t.test('an op the engine cannot index by is malformed: counted, never logged', async (t2) => {
    const { storage } = await openTemp(t2);
    const ok = remoteOp('peer', 1, 'write', 'r1', { data: { a: 1 } });
    const bad = [
      { ...ok, seq: 2, ts: 'zzz' },
      { ...ok, seq: 2, ts: 1.5 },
      { ...ok, seq: 2, ts: -1 },
      { ...ok, seq: 2, type: 'bogus' },
      { ...ok, seq: 2, type: 'constructor' },
      { ...ok, seq: 2, origin: 'peer@scope' },
      { ...ok, seq: 2, origin: '' },
      { ...ok, seq: 2, scope: 'a@b' },
      { ...ok, seq: 2, id: '../evil' },
      { ...ok, seq: 2, id: 'a/b' },
      { ...ok, seq: 2, v: 0 },
      { ...ok, seq: 0 },
      { ...ok, seq: 2.5 },
      { origin: 'peer', seq: 2, ts: Date.now(), type: 'advance', vector: 'no' },
      // A signature's fields must have their shape, whether or not they check.
      { ...ok, seq: 2, sig: 'short' },
      { ...ok, seq: 2, sig: 42 },
      { ...ok, seq: 2, sig: `${'S'.repeat(85)}=` },
      { ...ok, seq: 2, digest: 'D'.repeat(64) },
      { ...ok, seq: 2, digest: 'd'.repeat(63) },
      { ...ok, seq: 2, nonce: 'short' },
      { ...ok, seq: 2, nonce: 'n'.repeat(65) },
      { ...ok, seq: 2, nonce: 'has space in it!' },
    ];
    const result = await storage.applyRemote([ok, ...bad]);
    assert.deepStrictEqual(result, {
      applied: 1,
      skipped: 0,
      duplicates: 0,
      gaps: 0,
      malformed: bad.length,
      unsigned: 0,
      forged: 0,
      outOfScope: 0,
    });
    assert.strictEqual(storage.log.length, 1, 'only the good op is in the log');
    assert.deepStrictEqual(storage.vector, { peer: 1 });
    assert.strictEqual(await storage.fsi.exists(storage.path, 'evil.json'), false, 'nothing left data/');
    // Nothing malformed moved the vector: the stream's next op is not a gap.
    const next = await storage.applyRemote([remoteOp('peer', 2, 'set', 'r1', { data: { b: 1 } })]);
    assert.strictEqual(next.applied, 1);
  });

  await t.test('a stamp beyond maxSkew is refused and never observed into the clock', async (t2) => {
    const { storage } = await openTemp(t2, { sync: { maxSkew: 60_000 } });
    const errors = [];
    storage.on('error', (error) => errors.push(error));
    const id = await storage.insert({ f: 1 });
    const far = Date.now() + 3_600_000;
    const result = await storage.applyRemote([remoteOp('peer', 1, 'set', id, { data: { f: 2 }, ts: far })]);
    assert.deepStrictEqual(result, {
      applied: 0,
      skipped: 0,
      duplicates: 0,
      gaps: 0,
      malformed: 1,
      unsigned: 0,
      forged: 0,
      outOfScope: 0,
    });
    assert.strictEqual(errors.length, 1);
    assert.strictEqual(errors[0].code, 'SKEW');
    assert.strictEqual(errors[0].op.seq, 1);
    assert.deepStrictEqual(await storage.get(id), { f: 1 });
    const ops = [];
    storage.on('change', (op) => ops.push(op));
    await storage.update(id, { f: 3 });
    assert.deepStrictEqual(await storage.get(id), { f: 3 }, 'the local write is not frozen out');
    assert.ok(ops[0].ts < far, 'the clock did not follow the refused stamp');
    // Within the skew a peer ahead of us is observed, as before.
    const near = Date.now() + 30_000;
    await storage.applyRemote([remoteOp('peer', 1, 'set', id, { data: { f: 4 }, ts: near })]);
    assert.deepStrictEqual(await storage.get(id), { f: 4 });
    await storage.update(id, { f: 5 });
    assert.ok(ops.at(-1).ts > near);
    // A snapshot record stamped beyond the skew is left out the same way.
    const meta = { clock: { g: [far, 'peer'] }, base: null, deleted: null, counters: {} };
    const fine = { ...meta, clock: { g: [near, 'peer'] } };
    await storage.mergeSnapshot([
      { id: 'skewed', data: { g: 1 }, meta },
      { id: 'fine', data: { g: 1 }, meta: fine },
    ]);
    assert.strictEqual(await storage.get('skewed'), null);
    assert.deepStrictEqual(await storage.get('fine'), { g: 1 });
    // Infinity disables the check; anything but a positive number is refused at open.
    const { storage: loose } = await openTemp(t2, { sync: { maxSkew: Infinity } });
    assert.strictEqual(
      (await loose.applyRemote([remoteOp('peer', 1, 'write', 'r', { data: {}, ts: far })])).applied,
      1,
    );
    await assert.rejects(() => openTemp(t2, { sync: { maxSkew: '1h' } }), TypeError);
    await assert.rejects(() => openTemp(t2, { sync: { maxSkew: 0 } }), TypeError);
  });

  await t.test('error events carry a code', async (t2) => {
    const valid = (data) => !('secret' in data) && !(Array.isArray(data.tags) && data.tags.length > 1);
    const schema = { entities: { Post: { schema: valid } } };
    const { storage } = await openTemp(t2, { schema });
    const errors = [];
    storage.on('error', (error) => errors.push(error.code));
    const id = await storage.insert({ hits: 'text' });
    await storage.applyRemote([remoteOp('peer', 1, 'inc', id, { key: 'hits', value: 1 })]);
    await storage.applyRemote([remoteOp('peer', 2, 'write', 'p1', { data: { $type: 'Post', secret: 1 } })]);
    // A set op is validated against the record it leaves, like an inc.
    await storage.applyRemote([remoteOp('peer', 3, 'write', 'p2', { data: { $type: 'Post' } })]);
    await storage.applyRemote([remoteOp('peer', 4, 'add', 'p2', { key: 'tags', value: ['a', 'b'] })]);
    assert.deepStrictEqual(errors, ['OP_REFUSED', 'OP_INVALID', 'OP_INVALID']);
    assert.deepStrictEqual(await storage.get('p2'), { $type: 'Post' });
    await assert.rejects(() => storage.add('p2', 'tags', ['a', 'b']), { name: 'ValidationError' });
    await storage.add('p2', 'tags', ['a']);
    assert.deepStrictEqual(await storage.get('p2'), { $type: 'Post', tags: ['a'] });
  });

  await t.test('a snapshot record with an invalid id or shape is left out', async (t2) => {
    const { storage } = await openTemp(t2);
    const meta = { clock: { a: [1, 'peer'] }, base: null, deleted: null, counters: {} };
    await storage.mergeSnapshot([
      { id: '../evil', data: { a: 1 }, meta },
      { id: 'ok', data: { a: 1 }, meta },
      'garbage',
    ]);
    assert.deepStrictEqual(await storage.list(), ['ok']);
    assert.strictEqual(await storage.fsi.exists(storage.path, 'evil.json'), false);
  });

  await t.test("an advance moves the vector only when it is the feed host's own", async (t2) => {
    const { storage } = await openTemp(t2);
    const advance = (origin, seq, vector) => ({ origin, seq, ts: Date.now(), type: 'advance', vector });
    // Pushed by a peer (no adoptFrom): logged and passed on, nothing adopted.
    let result = await storage.applyRemote([advance('client', 1, JSON.parse('{"victim":1000000,"__proto__":5}'))]);
    assert.strictEqual(result.applied, 1);
    assert.deepStrictEqual(storage.vector, { 'client@~': 1 });
    // The victim's real first op is news, not a duplicate.
    result = await storage.applyRemote([remoteOp('victim', 1, 'write', 'v1', { data: { a: 1 } })]);
    assert.strictEqual(result.applied, 1);
    assert.deepStrictEqual(await storage.get('v1'), { a: 1 });
    // Read from a host's feed and authored by that host: adopted (safe integers, own keys).
    const claimed = JSON.parse('{"other":3,"bogus":1.5,"victim":1,"__proto__":7}');
    result = await storage.applyRemote([advance('host', 1, claimed)], { adoptFrom: 'host' });
    assert.strictEqual(result.applied, 1);
    assert.deepStrictEqual(storage.vector, { 'client@~': 1, victim: 1, 'host@~': 1, other: 3 });
    // Relayed through that host but authored by someone else: not adopted.
    result = await storage.applyRemote([advance('client', 2, { other: 9 })], { adoptFrom: 'host' });
    assert.strictEqual(result.applied, 1);
    assert.strictEqual(storage.vector.other, 3);
  });
});

test('a snapshot page is joined as one batch', async (t) => {
  await t.test('one log append, one block, every record announced', async (t2) => {
    const { storage: a } = await openTemp(t2);
    const { storage: b } = await openTemp(t2);
    const ids = [];
    for (let i = 0; i < 6; i++) ids.push(await a.insert({ i }));
    await a.delete(ids[5]);
    const { records } = await a.snapshot();
    assert.strictEqual(records.length, 6, 'tombstone included');
    const changes = [];
    b.on('change', (op, via) => changes.push([op.type, op.seq, via]));
    const hooks = [];
    await b.close();
    const { storage: c } = await openTemp(t2, {
      hooks: {
        beforeWrite: (ctx) => void hooks.push(['before', ctx.type, ctx.id]),
        afterWrite: (ctx, op) => void hooks.push(['after', op.type, op.id]),
      },
    });
    const seen = [];
    c.on('change', (op, via) => seen.push([op.type, op.seq, via]));
    await c.mergeSnapshot(records, { via: 'L', from: a.nodeId });
    assert.deepStrictEqual(
      seen,
      records.map((_, i) => ['merge', i + 1, 'L']),
      'merge ops of this node, one seq each, announced one by one',
    );
    assert.strictEqual(hooks.filter(([when]) => when === 'before').length, 6);
    assert.strictEqual(hooks.filter(([when]) => when === 'after').length, 6);
    assert.strictEqual(c.log.length, 6);
    assert.strictEqual((await c.fsi.list(`${c.path}/log/open`)).length, 1, 'one append for the page');
    const blocks = (await c.fsi.list(`${c.path}/blockchain`)).filter((n) => !n.startsWith('.'));
    assert.strictEqual(blocks.length, 2, 'the genesis block and one for the page');
    assert.deepStrictEqual((await c.list()).sort(), ids.slice(0, 5).sort());
    assert.strictEqual(await c.get(ids[5]), null, 'the tombstone travelled');
    assert.strictEqual(await c.validate(), true);
    assert.deepStrictEqual(c.vector, { [`${c.nodeId}@~`]: 6 });
    // Again: nothing changes, nothing is appended.
    await c.mergeSnapshot(records, { via: 'L', from: a.nodeId });
    assert.strictEqual(c.log.length, 6);
  });

  await t.test('a record sealed here is left alone; the rest of the page lands', async (t2) => {
    const { storage } = await openTemp(t2, { logger: { warn: () => {}, debug() {}, info() {}, error() {} } });
    await storage.saveData('sealed', { mine: true }, { encrypted: true });
    const meta = { clock: { a: [1, 'peer'] }, base: null, deleted: null, counters: {} };
    await storage.mergeSnapshot([
      { id: 'sealed', data: { a: 1 }, meta },
      { id: 'ok', data: { a: 1 }, meta },
    ]);
    assert.deepStrictEqual(await storage.get('sealed'), { mine: true });
    assert.deepStrictEqual(await storage.get('ok'), { a: 1 });
    assert.strictEqual(storage.log.length, 1);
  });

  await t.test(
    'snapshot pages over the catalog: no listing, and a record this node cannot read is left out',
    async (t2) => {
      const dir = await createTemp();
      t2.after(() => cleanupTemp(dir));
      const first = await syncom.open({ path: dir, logger: false });
      const ids = [];
      for (let i = 0; i < 4; i++) ids.push(await first.insert({ i }));
      await first.close();
      await fs.writeFile(path.join(dir, 'data', `${ids[1]}.json`), '{not json');
      const storage = await syncom.open({ path: dir, logger: false });
      t2.after(() => storage.close().catch(() => {}));
      const page = await storage.snapshot({ limit: 10 });
      assert.deepStrictEqual(
        page.records.map((r) => r.id).sort(),
        [ids[0], ids[2], ids[3]].sort(),
        'the unreadable record is left out of the page, not a failure of it',
      );
      // Paging: the cursor is an id, the next page starts above it, and a page
      // that filled up hands back a cursor whether or not more follows.
      const paged = [];
      let cursor = null;
      let pages = 0;
      do {
        const next = await storage.snapshot({ cursor, limit: 1 });
        paged.push(...next.records.map((r) => r.id));
        cursor = next.cursor;
        pages++;
      } while (cursor !== null);
      assert.deepStrictEqual(paged, [ids[0], ids[2], ids[3]].sort());
      assert.ok(pages >= 3 && pages <= 5, `${pages} pages`);
    },
  );
});
