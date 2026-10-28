'use strict';

// diff(), applyPatches(), restore() and the commit event, against whichever
// half the caller builds: the patches of every kind, a restore that reads
// as the version and merges like any write, a remove of exactly the tags an
// undo names, one turn of the queue, what a commit listener is handed.

const { createMesh, settle } = require('../utils/mesh.js');

const tick = () => new Promise((resolve) => setTimeout(resolve, 3));

const runPatchTests = async (t, assert, createStorage) => {
  await t.test('diff() names what turns one version into another, per field by kind', async (t2) => {
    const storage = await createStorage(t2, 'A');
    const id = await storage.insert({ title: 'a', n: 1 });
    await storage.inc(id, 'hits', 3);
    await storage.add(id, 'tags', ['x', 'y']);
    await storage.splice(id, 'body', 0, 0, 'hello world');
    await storage.push(id, 'items', [1, 2, 3]);
    await storage.treeMove(id, 'outline', 'r');
    await storage.treeMove(id, 'outline', 'a', 'r');
    await storage.treeMove(id, 'outline', 'b', 'r');
    const v1 = await storage.tag('v1');
    await storage.update(id, { title: 'b' });
    await storage.inc(id, 'hits', 2);
    await storage.remove(id, 'tags', ['x']);
    await storage.add(id, 'tags', ['z']);
    await storage.splice(id, 'body', 6, 5, 'there');
    await storage.move(id, 'items', 0, 2);
    await storage.treeMove(id, 'outline', 'b', 'r', { before: 'a' });
    await storage.treeMove(id, 'outline', 'c', 'a');
    const forward = await storage.diff(id, { tag: 'v1' });
    const isBody = (patch) => patch.field === 'body';
    assert.deepStrictEqual(
      forward.filter((patch) => !isBody(patch)),
      [
        { action: 'put', field: 'title', value: 'b' },
        { action: 'inc', field: 'hits', value: 2 },
        { action: 'add', field: 'tags', elements: ['z'] },
        { action: 'remove', field: 'tags', elements: ['x'] },
        { action: 'splice', field: 'items', index: 3, count: 0, content: [1] },
        { action: 'splice', field: 'items', index: 0, count: 1, content: [] },
        { action: 'treeMove', field: 'outline', node: 'b', parent: 'r' },
        { action: 'treeMove', field: 'outline', node: 'a', parent: 'r', after: 'b' },
        { action: 'treeMove', field: 'outline', node: 'c', parent: 'a' },
      ],
    );
    // The text's splices are Myers' hunks, last first: applied to the old
    // text they give the new one.
    const applied = forward
      .filter(isBody)
      .reduce(
        (text, { index, count, content }) => text.slice(0, index) + content + text.slice(index + count),
        'hello world',
      );
    assert.strictEqual(applied, 'hello there');
    assert.ok(forward.filter(isBody).every((patch) => patch.action === 'splice'));
    // The same by event id and by vector; nothing against itself; the
    // other way round leads back.
    assert.deepStrictEqual(await storage.diff(id, v1.eventId), forward);
    assert.deepStrictEqual(await storage.diff(id, { vector: v1.vector }), forward);
    assert.deepStrictEqual(await storage.diff(id), []);
    assert.deepStrictEqual(await storage.diff(id, { tag: 'v1' }, { tag: 'v1' }), []);
    const back = await storage.diff(id, undefined, { tag: 'v1' });
    assert.deepStrictEqual(
      back.filter((patch) => !isBody(patch)).map((patch) => patch.action),
      ['put', 'inc', 'add', 'remove', 'splice', 'splice', 'treeMove', 'treeMove', 'treeRemove'],
    );
    assert.deepStrictEqual(back[1], { action: 'inc', field: 'hits', value: -2 });
    assert.deepStrictEqual(back.at(-1), { action: 'treeRemove', field: 'outline', node: 'c' });
    // From nothing: the registers written, the rest made again whole.
    const fromNothing = await storage.diff(id, storage.log.formatId(0));
    assert.deepStrictEqual(fromNothing[0], { action: 'write', data: { title: 'b', n: 1 } });
    assert.deepStrictEqual(
      fromNothing.slice(1).map((patch) => [patch.action, patch.field]),
      [
        ['inc', 'hits'],
        ['add', 'tags'],
        ['splice', 'body'],
        ['splice', 'items'],
        ['treeMove', 'outline'],
        ['treeMove', 'outline'],
        ['treeMove', 'outline'],
        ['treeMove', 'outline'],
      ],
    );
    assert.deepStrictEqual(fromNothing[1], { action: 'inc', field: 'hits', value: 5 });
    assert.deepStrictEqual(fromNothing[3], {
      action: 'splice',
      field: 'body',
      index: 0,
      count: 0,
      content: 'hello there',
    });
    // To nothing: a delete. A register gone: a reset.
    await storage.delete(id);
    assert.deepStrictEqual(await storage.diff(id, { tag: 'v1' }), [{ action: 'delete' }]);
    await storage.set(id, { title: 'only' });
    const gone = await storage.diff(id, { tag: 'v1' });
    assert.deepStrictEqual(gone[0], { action: 'put', field: 'title', value: 'only' });
    assert.deepStrictEqual(
      gone.slice(1).sort((a, b) => a.field.localeCompare(b.field)),
      ['body', 'hits', 'items', 'n', 'outline', 'tags'].map((field) => ({ action: 'unset', field })),
      'every other field, of any kind, is unset',
    );
    const way = await storage.diff(id, undefined, { tag: 'v1' });
    assert.strictEqual(await storage.restore(id, { tag: 'v1' }), way.length, 'the fields made again');
    assert.deepStrictEqual(await storage.diff(id, { tag: 'v1' }), []);
    const purged = await storage.insert({ p: 1 });
    await storage.tag('v2');
    await storage.purge(purged);
    assert.deepStrictEqual(await storage.diff(purged, { tag: 'v2' }), [{ action: 'purge' }]);
    // A copy, raw, no hooks; errors as get(id, { at }) raises them.
    await assert.rejects(() => storage.diff(id, { tag: 'nope' }), { code: 'TAG_NOT_FOUND' });
    await assert.rejects(() => storage.diff(id, true), { code: 'INVALID_VERSION' });
    await assert.rejects(() => storage.diff('bad id!', { tag: 'v1' }), { code: 'INVALID_ID' });
    const sealed = await storage.insert({ pin: '1' }, { encrypted: true });
    await assert.rejects(() => storage.diff(sealed), { code: 'ENCRYPTED' });
  });

  await t.test('restore() reads as the version, through every kind, and merges like any write', async (t2) => {
    const mesh = await createMesh(t2, ['A', 'B'], [['A', 'B']], createStorage);
    const a = mesh.get('A');
    const b = mesh.get('B');
    const id = await a.insert({ title: 'a', n: 1 });
    await a.inc(id, 'hits', 3);
    await a.add(id, 'tags', ['x', 'y']);
    await a.splice(id, 'body', 0, 0, 'hello world');
    await a.push(id, 'items', [1, 2, 3]);
    await a.treeMove(id, 'outline', 'r');
    await a.treeMove(id, 'outline', 'a', 'r');
    await a.treeMove(id, 'outline', 'b', 'r');
    const { versions } = await a.history(id);
    await a.update(id, { title: 'b', extra: true });
    await a.inc(id, 'hits', 2);
    await a.remove(id, 'tags', ['x']);
    await a.splice(id, 'body', 0, 5, 'bye');
    await a.setAt(id, 'items', 0, 'one');
    await a.move(id, 'items', 2, 0);
    await a.treeRemove(id, 'outline', 'a');
    await a.delete(id);
    await a.set(id, { title: 'c' });
    const later = (await a.history(id)).versions;
    // Back to each earlier version in turn — oldest first, then the newest
    // back to the oldest; the record reads as it did then.
    const all = [...versions, ...later];
    for (const version of [...all.reverse(), ...all.reverse()]) {
      await a.restore(id, version.eventId);
      assert.deepStrictEqual(await a.get(id), version.data, `${version.type} @ ${version.seq}`);
    }
    await settle([a, b]);
    assert.deepStrictEqual(await b.get(id), await a.get(id), 'a restore is ops like any other');
    // A restore is a version of its own: the history grows, nothing is rewritten.
    await a.restore(id, later[0].eventId);
    const before = (await a.history(id, { limit: Infinity })).versions.length;
    const ops = await a.restore(id, versions.at(-1).eventId);
    assert.ok(ops > 0);
    assert.deepStrictEqual(await a.get(id), { title: 'a', n: 1 });
    assert.ok((await a.history(id, { limit: Infinity })).versions.length > before);
    await assert.rejects(() => a.restore(id), TypeError);
    await assert.rejects(() => a.restore(id, { tag: 'nope' }), { code: 'TAG_NOT_FOUND' });
    assert.strictEqual(await a.restore(id, a.log.lastEventId), 0, 'nothing to do');
  });

  await t.test('a remove of exactly the named tags revokes one add and leaves a concurrent one', async (t2) => {
    const mesh = await createMesh(t2, ['A', 'B'], [['A', 'B']], createStorage);
    const a = mesh.get('A');
    const b = mesh.get('B');
    const id = await a.insert({ n: 1 });
    await settle([a, b]);
    const link = mesh.links.get('mem://B');
    link.disconnect();
    const commits = [];
    a.on('commit', (event) => commits.push(event));
    await a.add(id, 'tags', ['x']);
    const added = commits.at(-1).op;
    await tick();
    await b.add(id, 'tags', ['x']);
    // Undo A's add alone: B's concurrent add of the same element survives.
    const ops = await a.applyPatches(
      id,
      [{ action: 'remove', field: 'tags', removals: [['x', { [a.nodeId]: added.ts }]] }],
      {
        source: 'undo',
      },
    );
    assert.strictEqual(ops, 1);
    assert.deepStrictEqual(commits.at(-1).source, 'undo');
    assert.deepStrictEqual(commits.at(-1).op.value, [['x', { [a.nodeId]: added.ts }]]);
    assert.deepStrictEqual((await a.get(id)).tags, []);
    await link.reconnect();
    await settle([a, b]);
    assert.deepStrictEqual((await a.get(id)).tags, ['x'], 'B’s add was not observed by the removal');
    assert.deepStrictEqual((await b.get(id)).tags, ['x']);
    // `own`: this node's adds of the element alone — none here, so no op.
    await a.add(id, 'tags', ['x']);
    await settle([a, b]);
    assert.strictEqual(await a.applyPatches(id, [{ action: 'remove', field: 'tags', elements: ['x'], own: true }]), 1);
    await settle([a, b]);
    assert.deepStrictEqual((await a.get(id)).tags, ['x'], 'B’s add stays');
    assert.strictEqual(await a.applyPatches(id, [{ action: 'remove', field: 'tags', elements: ['x'], own: true }]), 0);
    // An observed remove, by contrast, takes every add this node saw.
    await a.applyPatches(id, [{ action: 'remove', field: 'tags', elements: ['x'] }]);
    await settle([a, b]);
    assert.deepStrictEqual((await b.get(id)).tags, []);
  });

  await t.test(
    'applyPatches() is one turn of the queue, every action realized; a bad patch writes nothing',
    async (t2) => {
      const storage = await createStorage(t2, 'A');
      const id = await storage.insert({ n: 1 });
      const ops = [];
      storage.on('change', (op) => ops.push(op));
      // Queued behind the patches: the update lands after every op of theirs.
      const patches = storage.applyPatches(id, [
        { action: 'put', field: 'n', value: 2 },
        { action: 'inc', field: 'hits', value: 5 },
        { action: 'add', field: 'tags', elements: ['a', 'b'] },
        { action: 'remove', field: 'tags', elements: ['a'] },
        { action: 'splice', field: 'body', index: 0, count: 0, content: 'hi' },
        { action: 'splice', field: 'body', index: 0, count: 1 },
        { action: 'splice', field: 'items', index: 0, content: [1, 2] },
        { action: 'treeMove', field: 'outline', node: 'r' },
        { action: 'treeMove', field: 'outline', node: 'a', parent: 'r' },
        { action: 'treeMove', field: 'outline', node: 'b', parent: 'r', before: 'a' },
        { action: 'treeRemove', field: 'outline', node: 'a' },
      ]);
      const update = storage.update(id, { n: 3 });
      assert.strictEqual(await patches, 11);
      await update;
      assert.deepStrictEqual(
        ops.map((op) => op.type),
        ['set', 'inc', 'add', 'remove', 'splice', 'splice', 'splice', 'tree', 'tree', 'tree', 'tree', 'set'],
      );
      assert.deepStrictEqual(await storage.get(id), {
        n: 3,
        hits: 5,
        tags: ['b'],
        body: 'i',
        items: [1, 2],
        outline: [{ id: 'r', children: [{ id: 'b', children: [] }] }],
      });
      // A whole-record write, a delete, a purge.
      assert.strictEqual(await storage.applyPatches(id, [{ action: 'write', data: { n: 9 } }]), 1);
      assert.deepStrictEqual(await storage.get(id), { n: 9 });
      assert.strictEqual(await storage.applyPatches(id, [{ action: 'delete' }]), 1);
      assert.strictEqual(await storage.get(id), null);
      assert.strictEqual(await storage.applyPatches(id, [{ action: 'purge' }]), 1);
      assert.strictEqual(await storage.history(id).then((h) => h.versions[0].type), 'purge');
      assert.strictEqual(
        storage.log.entriesOf(id).every((entry) => entry.scrubbed),
        true,
        'the purge scrubbed',
      );
      // Shapes are checked before anything is written.
      const other = await storage.insert({ n: 1 });
      const count = ops.length;
      for (const bad of [
        'nope',
        [{ action: 'nope' }],
        [{ action: 'put', field: 'n' }],
        [{ action: 'inc', field: 'n', value: 'x' }],
        [{ action: 'add', field: 'n' }],
        [{ action: 'remove', field: 'n' }],
        [{ action: 'splice', field: 'n', index: -1 }],
        [{ action: 'write' }],
        [{ action: 'put', value: 1 }],
        [{ action: 'put', field: 'n', value: 1 }, null],
      ]) {
        await assert.rejects(() => storage.applyPatches(other, bad), TypeError, JSON.stringify(bad));
      }
      assert.strictEqual(ops.length, count, 'nothing written');
      await assert.rejects(() => storage.applyPatches('bad id!', []), { code: 'INVALID_ID' });
      // The kind rule still holds inside a patch.
      await assert.rejects(() => storage.applyPatches(other, [{ action: 'inc', field: 'n', value: 1 }]), {
        code: 'FIELD_KIND',
      });
    },
  );

  await t.test('the commit event hands a listener the op, its seq, before, after and the kinds', async (t2) => {
    const storage = await createStorage(t2, 'A', { actor: 'ada' });
    const events = [];
    const id = await storage.insert({ n: 1 });
    storage.on('commit', (event) => events.push(event));
    await storage.update(id, { n: 2 });
    await storage.inc(id, 'hits', 1);
    await storage.add(id, 'tags', ['x']);
    const record = await storage.record(id);
    record.n = 3;
    await record.save();
    await storage.delete(id);
    assert.deepStrictEqual(
      events.map((event) => [
        event.op.type,
        event.seq,
        event.before,
        event.after,
        event.source === record ? 'record' : event.source,
      ]),
      [
        ['set', 2, { n: 1 }, { n: 2 }, null],
        ['inc', 3, { n: 2 }, { n: 2, hits: 1 }, null],
        ['add', 4, { n: 2, hits: 1 }, { n: 2, hits: 1, tags: ['x'] }, null],
        ['set', 5, { n: 2, hits: 1, tags: ['x'] }, { n: 3, hits: 1, tags: ['x'] }, 'record'],
        ['delete', 6, { n: 3, hits: 1, tags: ['x'] }, null, null],
      ],
    );
    assert.deepStrictEqual(events.at(-1).kinds, { n: 'register', hits: 'counter', tags: 'set' });
    assert.strictEqual(events[0].op.actor, 'ada');
    assert.strictEqual(events[0].seq, storage.log.entriesOf(id)[1].seq);
    // Copies: a listener that edits them changes nothing.
    events[0].after.n = 'edited';
    assert.deepStrictEqual(await storage.get(id), null);
    // After a delete nothing is left to tell; a write that resets a live
    // record carries the kinds of what it reset.
    await storage.set(id, { n: 1 });
    assert.deepStrictEqual(events.at(-1).kinds, { n: 'register' });
    await storage.inc(id, 'hits', 1);
    await storage.set(id, { n: 2 });
    assert.deepStrictEqual(events.at(-1).kinds, { n: 'register', hits: 'counter' });
    assert.deepStrictEqual([events.at(-1).before, events.at(-1).after], [{ n: 1, hits: 1 }, { n: 2 }]);
    // A no-op commit raises nothing; a peer's op raises nothing.
    const count = events.length;
    await storage.remove(id, 'tags', ['nope']);
    await storage.applyRemote([{ origin: 'peer', seq: 1, ts: Date.now() + 1, type: 'set', id, data: { peer: true } }]);
    assert.strictEqual(events.length, count);
  });

  await t.test(
    'applyPatches() is all or nothing before the first append: a patch out of range leaves the record as it was',
    async (t2) => {
      const storage = await createStorage(t2, 'A');
      const id = await storage.insert({ title: 'a' });
      await storage.splice(id, 'body', 0, 0, 'hello');
      const next = storage.log.next;
      const bad = [
        { action: 'put', field: 'title', value: 'changed' },
        { action: 'splice', field: 'body', index: 999, count: 1 },
      ];
      await assert.rejects(() => storage.applyPatches(id, bad), { code: 'OUT_OF_RANGE' });
      assert.deepStrictEqual(await storage.get(id), { title: 'a', body: 'hello' }, 'the put did not land');
      assert.strictEqual(storage.log.next, next, 'nothing appended');
      // A kind clash and a cycle refuse the same way, before any op.
      await storage.treeMove(id, 'outline', 'r');
      await storage.treeMove(id, 'outline', 'x', 'r');
      const clash = [
        { action: 'inc', field: 'hits', value: 1 },
        { action: 'splice', field: 'title', index: 0, count: 0, content: 'x' },
      ];
      await assert.rejects(() => storage.applyPatches(id, clash), { code: 'FIELD_KIND', kind: 'register' });
      const cycle = [
        { action: 'inc', field: 'hits', value: 1 },
        { action: 'treeMove', field: 'outline', node: 'r', parent: 'x' },
      ];
      await assert.rejects(() => storage.applyPatches(id, cycle), { code: 'CYCLE' });
      assert.strictEqual((await storage.get(id)).hits, undefined, 'the inc before the refused patch did not land');
      // Later patches see the earlier ones: the second splice indexes the text the first one made.
      const count = await storage.applyPatches(id, [
        { action: 'splice', field: 'body', index: 5, count: 0, content: ' big' },
        { action: 'splice', field: 'body', index: 9, count: 0, content: ' world' },
      ]);
      assert.strictEqual(count, 2);
      assert.strictEqual((await storage.get(id)).body, 'hello big world');
    },
  );

  await t.test(
    'a patch is checked as the method of its name checks its arguments; removals are copied, not kept by reference',
    async (t2) => {
      const storage = await createStorage(t2, 'A');
      const id = await storage.insert({ title: 'a' });
      const bad = [
        [{ action: 'splice', field: 'body', index: 0, count: 0, content: 5 }, /string for a text or an array/],
        [{ action: 'splice', field: 'body', index: 0, count: 0 }, /count to remove or content to insert/],
        [{ action: 'treeMove', field: 'outline', node: 5 }, /node id/],
        [{ action: 'treeMove', field: 'outline', node: '__proto__' }, /node id/],
        [{ action: 'treeMove', field: 'outline', node: 'a', after: 'b', before: 'c' }, /after or before, not both/],
        [{ action: 'treeRemove', field: 'outline', node: 123 }, /node id/],
        [{ action: 'put', field: 'f', value: () => 1 }, /JSON value/],
        [{ action: 'write', data: [1, 2] }, /plain object/],
        [{ action: 'add', field: 'tags', elements: [] }, /non-empty array/],
        [{ action: 'remove', field: 'tags', removals: [['x', { A: -1 }]] }, /removals as/],
        [{ action: 'remove', field: 'tags', removals: 'nope' }, /removals as/],
      ];
      const next = storage.log.next;
      for (const [patch, message] of bad) {
        const expected = { name: 'TypeError', message };
        await assert.rejects(() => storage.applyPatches(id, [patch]), expected, JSON.stringify(patch));
      }
      assert.strictEqual(storage.log.next, next, 'nothing minted');
      assert.deepStrictEqual(await storage.get(id), { title: 'a' });
      // `removals` the caller keeps: the log holds a copy.
      await storage.add(id, 'tags', ['x']);
      const added = storage.log.entriesOf(id).at(-1).op;
      const removals = [['x', { [added.origin]: added.ts }]];
      await storage.applyPatches(id, [{ action: 'remove', field: 'tags', removals }]);
      assert.deepStrictEqual((await storage.get(id)).tags, []);
      removals[0][0] = 'MUTATED';
      removals[0][1].INJECTED = 999;
      assert.deepStrictEqual(storage.log.entriesOf(id).at(-1).op.value, [['x', { [added.origin]: added.ts }]]);
    },
  );

  await t.test(
    'compact() rewrites a record as one op per field: a text of many runs is one, a tree one move per node, the reading the same',
    async (t2) => {
      const mesh = await createMesh(t2, ['A', 'B'], [['A', 'B']], createStorage);
      const a = mesh.get('A');
      const b = mesh.get('B');
      const id = await a.insert({ title: 'doc', n: 1 });
      await a.inc(id, 'hits', 3);
      await a.add(id, 'tags', ['x', 'y']);
      for (const ch of 'hello') await a.splice(id, 'body', 0, 0, ch); // prepends: a run each
      await a.treeMove(id, 'outline', 'r');
      for (let i = 0; i < 5; i++) await a.treeMove(id, 'outline', `n${i}`, 'r');
      // Each move takes the node to the end: twenty real moves in the log.
      for (let i = 0; i < 20; i++) await a.treeMove(id, 'outline', `n${i % 5}`, 'r');
      await settle([a, b]);
      const before = await a.get(id);
      const blocks = async (storage) => (await storage.snapshot()).records.find((r) => r.id === id).meta;
      const was = await blocks(a);
      assert.strictEqual(Object.keys(was.blocks.body.runs).length, 5);
      assert.ok(Object.values(was.blocks.outline.moves).flat().length > 20, 'a move log worth compacting');
      const ops = await a.compact(id);
      assert.strictEqual(ops, 10, 'a write, an inc, an add, a splice, six moves');
      assert.deepStrictEqual(await a.get(id), before, 'reads the same');
      const now = await blocks(a);
      assert.strictEqual(Object.keys(now.blocks.body.runs).length, 1, 'one run');
      assert.strictEqual(Object.values(now.blocks.outline.moves).flat().length, 6, 'one move per node');
      assert.strictEqual(Object.keys(now.counters.hits).length, 1, 'one slot: the sum as this node’s');
      await settle([a, b]);
      assert.deepStrictEqual(await b.get(id), before, 'the peer reads the same');
      assert.deepStrictEqual(await blocks(b), now, 'and holds the same blocks');
      assert.strictEqual((await a.history(id, { limit: 1 })).exact, true);
      assert.strictEqual(await a.compact('nope'), 0, 'a record that is not there');
    },
  );

  await t.test(
    'compact() lays a text’s marks again, keeps a counter at 0, and lays a field longer than a run in several',
    async (t2) => {
      const mesh = await createMesh(t2, ['A', 'B'], [['A', 'B']], createStorage);
      const a = mesh.get('A');
      const b = mesh.get('B');
      const id = await a.insert({ title: 'doc' });
      await a.updateText(id, 'body', 'hello brave new world');
      await a.mark(id, 'body', 0, 5, 'bold', true);
      await a.mark(id, 'body', 6, 11, 'link', 'https://x', { expand: 'none' });
      await a.mark(id, 'body', 3, 9, 'comment', { by: 'ada' }, { many: true });
      await a.unmark(id, 'body', 1, 2, 'bold');
      await a.splice(id, 'body', 0, 0, '> ');
      await a.splice(id, 'body', 8, 6);
      await a.inc(id, 'hits', 2);
      await a.inc(id, 'hits', -2);
      // A stacking mark is named anew by the rewrite; the rest reads the same.
      const plain = (spans) => JSON.parse(JSON.stringify(spans).replaceAll(/"id":"[^"]+"/g, '"id":"m"'));
      const before = { data: await a.get(id), spans: plain(await a.spans(id, 'body')) };
      assert.strictEqual(before.data.hits, 0);
      await settle([a, b]);
      await a.compact(id);
      await settle([a, b]);
      for (const node of [a, b]) {
        assert.deepStrictEqual({ data: await node.get(id), spans: plain(await node.spans(id, 'body')) }, before);
      }
      // The expand rules came through: typed at the edge of the link (none) stays plain,
      // typed at the end of the bold run (after) is bold.
      await a.splice(id, 'body', 3, 0, 'Z');
      assert.deepStrictEqual((await a.spans(id, 'body')).slice(0, 3), [
        { type: 'text', text: '> ', marks: {} },
        { type: 'text', text: 'hZ', marks: { bold: true } },
        { type: 'text', text: 'e', marks: {} },
      ]);
      // A text longer than one run: two pushes of 600 000, compacted into two runs.
      const big = await a.insert({ title: 'big' });
      const half = 'ab'.repeat(300_000);
      await a.push(big, 'body', half);
      await a.push(big, 'body', half);
      const text = (await a.get(big)).body;
      assert.strictEqual(text.length, 1_200_000);
      assert.strictEqual(await a.compact(big), 3, 'a write and two runs');
      assert.strictEqual((await a.get(big)).body, text);
    },
  );
};

module.exports = { runPatchTests };
