'use strict';

// Queries through the storage, against whichever half the caller builds:
// cursors against a reference computed the slow way, the covered plan, the
// unique keys on both write paths, and watch().

const { memory } = require('../../src/memory/memory.js');
const { createMesh, settle, waitUntil } = require('../utils/mesh.js');

const counting = (fsi) => {
  let reads = 0;
  return {
    read: (dir, name) => {
      if (dir.endsWith('/data')) reads++;
      return fsi.read(dir, name);
    },
    write: (dir, name, content) => fsi.write(dir, name, content),
    exists: (dir, name) => fsi.exists(dir, name),
    remove: (dir, name) => fsi.remove(dir, name),
    list: (dir) => fsi.list(dir),
    dataReads: () => reads,
    reset: () => void (reads = 0),
  };
};

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

const runQueryTests = async (t, assert, createStorage) => {
  const schema = {
    entities: {
      Project: { index: ['orgId', 'kind'], unique: ['slug', ['orgId', 'name']] },
      Tag: {},
    },
  };

  await t.test('a cursor answers what list()+get()+sort would, covered or not', async (t2) => {
    const fsi = counting(memory());
    const storage = await createStorage(t2, 'A', { fsi, schema, cache: { max: 50 } });
    const orgs = ['o0', 'o1', 'o2', 'o3', 'o4'];
    const all = [];
    for (let i = 0; i < 120; i++) {
      const data = {
        orgId: orgs[i % 5],
        kind: i % 3 === 0 ? 'lib' : 'app',
        name: `n${(i * 7) % 120}`,
        slug: `s${i}`,
        createdAt: 1000 + ((i * 13) % 50),
        stars: i % 4 === 0 ? [i] : [],
      };
      const { id } = await storage.Project.insert(data);
      all.push({ id, ...data, $type: 'Project' });
    }
    await storage.Tag.insert({ orgId: 'o1', name: 'not a project' });
    const reference = all
      .filter((row) => row.orgId === 'o1')
      .sort((a, b) => (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : b.createdAt - a.createdAt || 0))
      .slice(5, 15);
    const rows = await storage.Project.select({ orgId: 'o1' })
      .order('kind')
      .desc('createdAt')
      .limit(10)
      .offset(5)
      .fetch();
    assert.deepStrictEqual(rows, reference);
    assert.strictEqual(await storage.Project.count({ orgId: 'o1' }), 24);
    assert.strictEqual(await storage.Project.count(), 120);
    assert.strictEqual(await storage.Tag.count({ orgId: 'o1' }), 1);
    // Covered: indexed fields only, with a projection — not one record read.
    fsi.reset();
    const covered = await storage.Project.select({ orgId: 'o1', kind: 'lib' })
      .order('kind')
      .projection(['orgId', 'kind'])
      .fetch();
    assert.strictEqual(covered.length, 8);
    assert.deepStrictEqual(Object.keys(covered[0]), ['id', 'orgId', 'kind']);
    assert.strictEqual(await storage.Project.select({ orgId: { $in: ['o1', 'o2'] } }).count(), 48);
    assert.strictEqual(fsi.dataReads(), 0, 'answered from the catalog');
    // Not covered: exactly the candidates are read (the cache holds 50).
    fsi.reset();
    const narrowed = await storage.Project.select({ orgId: 'o3', createdAt: { $gte: 1030 } }).fetch();
    assert.ok(narrowed.length > 0 && narrowed.length < 24);
    assert.ok(fsi.dataReads() <= 24, `read ${fsi.dataReads()} candidates, not 120`);
    assert.ok(narrowed.every((row) => row.orgId === 'o3' && row.createdAt >= 1030));
    // Ordered with a limit: only the best offset + limit rows are kept while
    // the candidates are read (in parallel, in candidate order); the page is
    // what a stable sort of every match would give — equal keys in candidate
    // order, which is id order — for any limit and offset, either way.
    const byKind = (desc) => (a, b) => {
      const order = a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0;
      return desc ? -order : order;
    };
    const byId = [...all].sort((a, b) => (a.id < b.id ? -1 : 1));
    for (const [limit, offset, desc] of [
      [0, 0, false],
      [1, 0, false],
      [3, 2, true],
      [7, 0, false],
      [10, 5, true],
      [30, 10, false],
      [200, 0, true],
      [5, 200, false],
    ]) {
      const expected = [...byId]
        .sort(byKind(desc))
        .slice(offset, offset + limit)
        .map((row) => row.id);
      const cursor = storage.Project.select({});
      const sorted = desc ? cursor.desc('kind') : cursor.order('kind');
      const got = (await sorted.limit(limit).offset(offset).fetch()).map((row) => row.id);
      assert.deepStrictEqual(got, expected, `limit ${limit} offset ${offset} ${desc ? 'desc' : 'asc'}`);
    }
    // $and narrows to the posting lists of every branch: the candidates
    // read are the eight o1 libs, not the 24 of o1 or the 120 of all.
    fsi.reset();
    const both = await storage.Project.select({ $and: [{ orgId: 'o1' }, { kind: 'lib' }, { createdAt: { $gte: 0 } }] })
      .order('createdAt')
      .fetch();
    assert.strictEqual(both.length, 8);
    assert.ok(fsi.dataReads() <= 8, `read ${fsi.dataReads()} candidates, not 24 or 120`);
    // The operators and the rest of the cursor.
    assert.deepStrictEqual(
      (
        await storage.Project.select({ $or: [{ slug: 's1' }, { slug: 's2' }] })
          .order('slug')
          .fetch()
      ).map((r) => r.slug),
      ['s1', 's2'],
    );
    assert.strictEqual(await storage.Project.count({ stars: { $exists: true }, 'stars.0': { $exists: true } }), 30);
    assert.strictEqual(await storage.Project.count({ name: { $regex: '^n1\\d$' } }), 10);
    assert.strictEqual(await storage.Project.count({ stars: 4 }), 1, 'an array field holds the value');
    const filtered = await storage.Project.select({ orgId: 'o0' })
      .filter((row) => row.createdAt % 2 === 0)
      .fetch();
    assert.ok(filtered.length > 0 && filtered.every((row) => row.createdAt % 2 === 0));
    const one = await storage.Project.select({ slug: 's7' }).one();
    assert.strictEqual(one.id, all[7].id);
    assert.strictEqual(await storage.Project.select({ slug: 'nope' }).one(), null);
    const iterated = [];
    for await (const row of storage.Project.select({ orgId: 'o4' }).order('name').limit(3)) iterated.push(row.name);
    assert.strictEqual(iterated.length, 3);
    assert.throws(() => storage.Project.select({ orgId: { $nope: 1 } }), { name: 'TypeError' });
    // Deleted and encrypted records are out; records outside the collection are out.
    await storage.delete(all[0].id);
    await storage.insert({ orgId: 'o0', $type: 'Project', sealed: true }, { encrypted: true });
    assert.strictEqual(await storage.Project.count({ orgId: 'o0' }), 23);
    assert.strictEqual(await storage.Project.count(), 119, 'the covered path skips a sealed record too');
  });

  await t.test('an indexed array field narrows by element — a set, or any array', async (t2) => {
    const fsi = counting(memory());
    const storage = await createStorage(t2, 'A', { fsi, schema: { entities: { Issue: { index: ['tags'] } } } });
    const ids = [];
    for (let i = 0; i < 30; i++) {
      const { id } = await storage.Issue.insert({ n: i });
      ids.push(id);
      if (i % 3 === 0) await storage.add(id, 'tags', ['bug', `t${i}`]);
      else if (i % 3 === 1) await storage.update(id, { tags: ['ui'] });
      else await storage.push(id, 'tags', ['list', `t${i}`]);
    }
    fsi.reset();
    assert.strictEqual(await storage.Issue.count({ tags: 'bug' }), 10, 'a set');
    assert.strictEqual(await storage.Issue.count({ tags: 'ui' }), 10, 'a register holding an array');
    assert.strictEqual(await storage.Issue.count({ tags: 'list' }), 10, 'a list');
    assert.strictEqual(fsi.dataReads(), 0, 'covered: the catalog answers');
    assert.strictEqual(await storage.Issue.count({ tags: ['bug', 't0'] }), 1, 'an array value matches whole');
    assert.strictEqual(await storage.Issue.count({ tags: ['bug'] }), 0);
    assert.strictEqual(await storage.Issue.count({ tags: { $in: ['t3', 't6', 'nope'] } }), 2);
    fsi.reset();
    const rows = await storage.Issue.select({ tags: 'bug' }).fetch();
    assert.strictEqual(rows.length, 10);
    assert.ok(fsi.dataReads() <= 10, `read ${fsi.dataReads()} candidates, not 30`);
    // A remove drops the element's posting, and watch() hears it.
    const seen = [];
    const stop = storage.Issue.select({ tags: 't0' }).watch((found) => seen.push(found.length));
    await tick();
    await storage.remove(ids[0], 'tags', ['t0']);
    await tick();
    stop();
    assert.deepStrictEqual(seen, [1, 0]);
    assert.strictEqual(await storage.Issue.count({ tags: 'bug' }), 10, 'bug is still on it');
    assert.strictEqual(await storage.Issue.count({ tags: 't0' }), 0);
  });

  await t.test('unique keys: refused locally, reported when a peer’s op leaves two on one', async (t2) => {
    const mesh = await createMesh(t2, ['A', 'B'], [['A', 'B']], createStorage, {
      nodes: { A: { schema }, B: { schema } },
    });
    const [a, b] = ['A', 'B'].map((name) => mesh.get(name));
    await waitUntil(() => a.sync.peers()[0]?.subscribed);
    const first = await a.Project.insert({ orgId: 'o', name: 'n', slug: 's' });
    const error = await a.Project.insert({ orgId: 'o', name: 'other', slug: 's' }).catch((e) => e);
    assert.strictEqual(error.name, 'ValidationError');
    assert.strictEqual(error.entity, 'Project');
    assert.deepStrictEqual(error.issues, [
      { path: ['slug'], message: `is not unique (held by ${first.id})`, code: 'unique', conflict: first.id },
    ]);
    const composite = await a.Project.insert({ orgId: 'o', name: 'n', slug: 'other' }).catch((e) => e);
    assert.deepStrictEqual(composite.issues[0].path, ['orgId', 'name']);
    assert.strictEqual(composite.issues[0].conflict, first.id);
    const second = await a.Project.insert({ orgId: 'o', name: 'm', slug: 't' });
    await assert.rejects(() => a.Project.update(second.id, { slug: 's' }), {
      name: 'ValidationError',
      code: 'VALIDATION_FAILED',
    });
    await a.Project.update(first.id, { slug: 's' });
    assert.strictEqual(a.log.length, 3, 'the same key on the same record is fine');
    await a.delete(first.id);
    await a.Project.update(second.id, { slug: 's' });
    assert.deepStrictEqual(
      (await a.Project.select({ slug: 's' }).fetch()).map((r) => r.id),
      [second.id],
    );
    await settle([a, b]);
    // Two nodes, one key, concurrently: both records exist on both nodes,
    // each node reports the conflict for the op it received.
    const conflicts = { A: [], B: [] };
    a.on('conflict', (event) => conflicts.A.push(event));
    b.on('conflict', (event) => conflicts.B.push(event));
    await a.sync.enableNode('mem://B', false);
    const fromA = await a.Project.insert({ orgId: 'o', name: 'dup', slug: 'u' });
    const fromB = await b.Project.insert({ orgId: 'o', name: 'dup', slug: 'u' });
    await a.sync.enableNode('mem://B', true);
    await settle([a, b]);
    for (const storage of [a, b]) {
      const held = (await storage.Project.select({ slug: 'u' }).fetch()).map((r) => r.id).sort();
      assert.deepStrictEqual(held, [fromA.id, fromB.id].sort(), 'both kept');
    }
    assert.deepStrictEqual(
      conflicts.A.map((e) => [e.kind, e.entity, e.fields, e.id, e.other, e.op.origin]).sort(),
      [
        ['unique', 'Project', ['orgId', 'name'], fromB.id, fromA.id, b.nodeId],
        ['unique', 'Project', ['slug'], fromB.id, fromA.id, b.nodeId],
      ].sort(),
    );
    assert.strictEqual(conflicts.B.length, 2);
    // The application resolves it; the catalog follows.
    await b.delete(fromB.id);
    await settle([a, b]);
    assert.deepStrictEqual(
      (await a.Project.select({ slug: 'u' }).fetch()).map((r) => r.id),
      [fromA.id],
    );
    assert.deepStrictEqual(a.sync.peers().length, 1);
    // A reopen restores the keys from the persisted catalog.
    await b.close();
    const reopened = await createStorage(t2, 'B', { schema });
    await assert.rejects(() => reopened.Project.insert({ orgId: 'x', name: 'x', slug: 'u' }), {
      name: 'ValidationError',
    });
  });

  await t.test('watch(): the rows now, again after each change of the collection, coalesced', async (t2) => {
    const storage = await createStorage(t2, 'A', { schema });
    const first = await storage.Project.insert({ orgId: 'o', name: 'a', slug: 'a', n: 1 });
    const calls = [];
    const stop = storage.Project.select({ orgId: 'o' })
      .order('name')
      .watch((rows) => calls.push(rows.map((r) => r.name)));
    await tick();
    assert.deepStrictEqual(calls, [['a']], 'the initial run');
    const second = await storage.Project.insert({ orgId: 'o', name: 'b', slug: 'b' });
    await tick();
    assert.deepStrictEqual(calls.at(-1), ['a', 'b']);
    await storage.Project.update(first.id, { name: 'c' });
    await tick();
    assert.deepStrictEqual(calls.at(-1), ['b', 'c']);
    await storage.Tag.insert({ name: 'tag' });
    await storage.insert({ loose: true });
    await tick();
    assert.strictEqual(calls.length, 3, 'another collection, or none, does not wake it');
    // A peer's batch of several ops is one run.
    const before = calls.length;
    await storage.applyRemote([
      {
        origin: 'peer',
        seq: 1,
        ts: Date.now() + 10_000,
        type: 'write',
        id: 'p1',
        data: { orgId: 'o', name: 'd', slug: 'd', $type: 'Project' },
      },
      {
        origin: 'peer',
        seq: 2,
        ts: Date.now() + 10_001,
        type: 'write',
        id: 'p2',
        data: { orgId: 'o', name: 'e', slug: 'e', $type: 'Project' },
      },
    ]);
    await tick();
    assert.deepStrictEqual(calls.at(-1), ['b', 'c', 'd', 'e']);
    assert.ok(calls.length - before <= 2, 'coalesced');
    await storage.delete(second.id);
    await tick();
    assert.deepStrictEqual(calls.at(-1), ['c', 'd', 'e']);
    stop();
    await storage.Project.insert({ orgId: 'o', name: 'z', slug: 'z' });
    await tick();
    assert.deepStrictEqual(calls.at(-1), ['c', 'd', 'e'], 'silent after stop');
    // A failing run reaches onError, or the logger.
    const errors = [];
    const debug = [];
    const noisy = await createStorage(t2, 'N', { schema, logger: { warn: (entry) => debug.push(entry.event) } });
    await noisy.Project.insert({ orgId: 'o', name: 'a', slug: 'a' });
    const bad = noisy.Project.select().filter(() => {
      throw new Error('boom');
    });
    const stopBad = bad.watch(() => {}, { onError: (error) => errors.push(error.message) });
    await tick();
    assert.deepStrictEqual(errors, ['boom']);
    stopBad();
    const stopQuiet = bad.watch(() => {});
    await tick();
    assert.ok(debug.includes('watch.error'));
    stopQuiet();
    const stopThrowing = noisy.Project.select().watch(
      () => {
        throw new Error('listener');
      },
      { onError: (error) => errors.push(error.message) },
    );
    await tick();
    assert.deepStrictEqual(errors, ['boom', 'listener']);
    stopThrowing();
  });

  await t.test('a builder hands back a new cursor and leaves the one it was called on as it was', async (t2) => {
    const storage = await createStorage(t2, 'I', { schema });
    for (let i = 0; i < 6; i++) await storage.Project.insert({ orgId: 'o', name: `n${i}`, slug: `s${i}`, n: i });
    const base = storage.Project.select({ orgId: 'o' });
    const ordered = base.desc('n');
    const limited = ordered.limit(2).offset(1);
    const projected = limited.projection(['n']);
    const filtered = base.filter((row) => row.n % 2 === 0);
    assert.notStrictEqual(ordered, base);
    assert.notStrictEqual(limited, ordered);
    assert.strictEqual((await base.fetch()).length, 6, 'base: no order, no limit');
    assert.deepStrictEqual(
      (await ordered.fetch()).map((row) => row.n),
      [5, 4, 3, 2, 1, 0],
    );
    assert.deepStrictEqual(
      (await limited.fetch()).map((row) => row.n),
      [4, 3],
    );
    assert.deepStrictEqual(await projected.fetch(), [
      { id: (await limited.fetch())[0].id, n: 4 },
      { id: (await limited.fetch())[1].id, n: 3 },
    ]);
    assert.deepStrictEqual(
      (await limited.fetch()).map((row) => Object.keys(row).length),
      [6, 6],
      'no projection on the one before',
    );
    assert.deepStrictEqual((await filtered.fetch()).map((row) => row.n).sort(), [0, 2, 4]);
    assert.strictEqual(await base.count(), 6);
    // Two branches off one cursor are two cursors.
    const asc = ordered.order('name');
    assert.deepStrictEqual(
      (await ordered.limit(1).fetch()).map((row) => row.n),
      [5],
    );
    assert.deepStrictEqual(
      (await asc.fetch()).map((row) => row.n),
      [5, 4, 3, 2, 1, 0],
      'desc n first, then name',
    );
    assert.strictEqual(base.matches({ orgId: 'o', n: 99 }), true);
    assert.strictEqual(base.matches({ orgId: 'x' }), false);
    assert.throws(() => base.matches('x'), TypeError);
  });

  await t.test('$type, $size, $mod, $all, $elemMatch and $nor match what a reference filter does', async (t2) => {
    const storage = await createStorage(t2, 'OP', { schema });
    const all = [];
    for (let i = 0; i < 40; i++) {
      const data = {
        orgId: 'o',
        name: `n${i}`,
        slug: `s${i}`,
        n: i,
        v: i % 4 === 0 ? null : i % 4 === 1 ? 's' : i % 4 === 2 ? [i] : { k: i },
        tags: i % 3 === 0 ? ['a'] : i % 3 === 1 ? ['a', 'b'] : ['b', 'c', 'd'],
        items: [
          { k: i, s: 'x' },
          { k: i + 1, s: 'y' },
        ],
      };
      const { id } = await storage.Project.insert(data);
      all.push({ id, ...data, $type: 'Project' });
    }
    const typeOf = (value) => (value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value);
    const cases = [
      [{ v: { $type: 'null' } }, (row) => row.v === null],
      [{ v: { $type: 'string' } }, (row) => typeof row.v === 'string'],
      [{ v: { $type: 'array' } }, (row) => Array.isArray(row.v)],
      [{ v: { $type: 'object' } }, (row) => typeOf(row.v) === 'object'],
      [{ missing: { $type: 'null' } }, () => false],
      [{ tags: { $size: 2 } }, (row) => row.tags.length === 2],
      [{ n: { $size: 1 } }, () => false],
      [{ n: { $mod: [3, 1] } }, (row) => row.n % 3 === 1],
      [{ tags: { $all: ['a', 'b'] } }, (row) => row.tags.includes('a') && row.tags.includes('b')],
      [{ tags: { $all: [] } }, () => true],
      [
        { items: { $elemMatch: { k: { $gte: 10 }, s: 'y' } } },
        (row) => row.items.some((it) => it.k >= 10 && it.s === 'y'),
      ],
      [{ tags: { $elemMatch: { $in: ['c', 'z'] } } }, (row) => row.tags.includes('c')],
      [{ items: { $elemMatch: { k: { $mod: [2, 0] } } } }, (row) => row.items.some((it) => it.k % 2 === 0)],
      [{ $nor: [{ n: { $lt: 10 } }, { tags: 'b' }] }, (row) => !(row.n < 10 || row.tags.includes('b'))],
      [{ $and: [{ $nor: [{ v: null }] }, { n: { $mod: [2, 0] } }] }, (row) => row.v !== null && row.n % 2 === 0],
    ];
    for (const [query, reference] of cases) {
      const expected = all
        .filter(reference)
        .map((row) => row.id)
        .sort();
      const rows = await storage.Project.select(query).fetch();
      assert.deepStrictEqual(rows.map((row) => row.id).sort(), expected, JSON.stringify(query));
      assert.strictEqual(await storage.Project.count(query), expected.length, JSON.stringify(query));
      const predicate = storage.Project.select(query);
      for (const row of all) {
        assert.strictEqual(predicate.matches(row), reference(row), `${JSON.stringify(query)} on ${row.n}`);
      }
    }
    // Malformed: a TypeError at select().
    for (const bad of [
      { v: { $type: 'date' } },
      { tags: { $size: -1 } },
      { n: { $mod: [0, 1] } },
      { n: { $mod: 3 } },
      { tags: { $all: 'a' } },
      { items: { $elemMatch: 5 } },
      { $nor: {} },
    ]) {
      assert.throws(() => storage.Project.select(bad), TypeError, JSON.stringify(bad));
    }
  });

  await t.test('one() leaves the cursor as it was', async (t2) => {
    const storage = await createStorage(t2, 'O', { schema });
    for (const name of ['a', 'b', 'c']) await storage.Project.insert({ orgId: 'o', name, slug: name });
    const cursor = storage.Project.select({ orgId: 'o' }).order('name');
    assert.strictEqual((await cursor.one()).name, 'a');
    assert.deepStrictEqual(
      (await cursor.fetch()).map((row) => row.name),
      ['a', 'b', 'c'],
      'no limit(1) left behind',
    );
    const limited = storage.Project.select({ orgId: 'o' }).order('name').limit(0);
    assert.strictEqual(await limited.one(), null, 'a cursor limited to none finds none');
  });

  await t.test('an indexed object matches whatever its key order', async (t2) => {
    const shapes = {
      entities: { Place: { index: ['at'], unique: ['code'] } },
    };
    const storage = await createStorage(t2, 'K', { schema: shapes });
    await storage.Place.insert({ at: { x: 1, y: 2 }, code: { a: 1, b: 2 } });
    const hits = async (query) => (await storage.Place.select(query).fetch()).length;
    assert.strictEqual(await hits({ at: { $eq: { y: 2, x: 1 } } }), 1, '$eq through the index');
    assert.strictEqual(await hits({ at: { $in: [{ y: 2, x: 1 }] } }), 1, '$in through the index');
    assert.strictEqual(await hits({ at: { y: 2, x: 1 } }), 1);
    await assert.rejects(
      () => storage.Place.insert({ at: { x: 3 }, code: { b: 2, a: 1 } }),
      (error) => error.name === 'ValidationError' && error.issues[0].code === 'unique',
      'the same unique value, keys in another order',
    );
  });
};

module.exports = { runQueryTests };
