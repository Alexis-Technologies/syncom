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
      // The one order a result has: the keys, then the id.
      .sort((a, b) =>
        a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : b.createdAt - a.createdAt || (a.id < b.id ? -1 : 1),
      )
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
      return (desc ? -order : order) || (a.id < b.id ? -1 : 1);
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

  await t.test(
    'a live result after a change reads as a fresh run and emits only when the rows changed (seeded)',
    async (t2) => {
      const fsi = counting(memory());
      const storage = await createStorage(t2, 'L', { fsi, schema, cache: { max: 1000 } });
      let seed = 7;
      const random = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
      const ids = [];
      for (let i = 0; i < 30; i++) {
        const { id } = await storage.Project.insert({
          orgId: `o${i % 3}`,
          name: `n${i}`,
          slug: `s${i}`,
          n: i,
          k: i % 4,
        });
        ids.push(id);
      }
      // Covered and not, ordered and not, windowed and not, offset or not.
      const cursors = [
        storage.Project.select({ orgId: 'o1' }).order('n'),
        storage.Project.select({ orgId: 'o1' }).order('n').limit(4),
        storage.Project.select({ k: { $gte: 2 } })
          .desc('n')
          .limit(5)
          .offset(2),
        storage.Project.select({ orgId: 'o2', k: 1 }).projection(['orgId', 'k']),
        storage.Project.select({}).order('k').desc('n').limit(6),
        storage.Project.select({ n: { $lt: 20 } }),
        storage.Project.select({ orgId: { $in: ['o0', 'o2'] } })
          .filter((row) => row.n % 2 === 0)
          .order('n')
          .limit(3),
      ];
      const seen = cursors.map(() => []);
      const stops = cursors.map((cursor, i) => cursor.watch((rows) => seen[i].push(rows)));
      await tick();
      for (let step = 0; step < 120; step++) {
        const id = ids[Math.floor(random() * ids.length)];
        const roll = random();
        try {
          if (roll < 0.3) await storage.Project.update(id, { n: Math.floor(random() * 40) });
          else if (roll < 0.45) await storage.Project.update(id, { k: Math.floor(random() * 4) });
          else if (roll < 0.55) await storage.Project.update(id, { orgId: `o${Math.floor(random() * 3)}` });
          else if (roll < 0.65) await storage.Project.update(id, { note: step });
          else if (roll < 0.8) await storage.delete(id);
          else if (roll < 0.9) {
            await storage.set(id, {
              orgId: `o${step % 3}`,
              name: `r${step}`,
              slug: `s${id}`,
              n: step % 40,
              k: step % 4,
              $type: 'Project',
            });
          } else {
            const { id: made } = await storage.Project.insert({
              orgId: `o${step % 3}`,
              name: `m${step}`,
              slug: `m${step}`,
              n: step % 40,
              k: step % 4,
            });
            ids.push(made);
          }
        } catch (error) {
          if (error.code !== 'NOT_FOUND') throw error;
        }
        await tick();
        for (let i = 0; i < cursors.length; i++) {
          const fresh = await cursors[i].fetch();
          assert.deepStrictEqual(seen[i].at(-1), fresh, `step ${step}, cursor ${i}`);
        }
      }
      // Distinct: two emissions in a row are never the same rows.
      for (let i = 0; i < cursors.length; i++) {
        for (let k = 1; k < seen[i].length; k++) {
          assert.notDeepStrictEqual(seen[i][k], seen[i][k - 1], `cursor ${i}, emission ${k}`);
        }
      }
      // A change outside the result emits nothing: a record of another collection, one the query does
      // not match — only the cursor over every record (k first, then n descending) hears the far one.
      const before = seen.map((list) => list.length);
      await storage.Tag.insert({ name: 'tag' });
      await storage.Project.insert({ orgId: 'o5', name: 'far', slug: 'far', n: 99, k: 0 });
      await tick();
      assert.deepStrictEqual(
        seen.map((list) => list.length),
        before.map((n, i) => (i === 4 ? n + 1 : n)),
      );
      for (const stop of stops) stop();
    },
  );

  await t.test('watchCount() moves the count by one per change, without counting again', async (t2) => {
    const fsi = counting(memory());
    const storage = await createStorage(t2, 'C', { fsi, schema, cache: { max: 1000 } });
    const ids = [];
    for (let i = 0; i < 12; i++) {
      ids.push((await storage.Project.insert({ orgId: i % 2 ? 'a' : 'b', name: `n${i}`, slug: `s${i}`, n: i })).id);
    }
    const counts = [];
    const covered = [];
    const stop = storage.Project.select({ orgId: 'a', n: { $gte: 5 } }).watchCount((n) => counts.push(n));
    const stopCovered = storage.Project.select({ orgId: 'a' }).watchCount((n) => covered.push(n));
    // The window does not apply to a count: every match is counted, from the first run on.
    const windowed = [];
    const stopWindowed = storage.Project.select({ orgId: 'a' })
      .order('n')
      .limit(2)
      .watchCount((n) => windowed.push(n));
    await tick();
    assert.deepStrictEqual(counts, [4]);
    assert.deepStrictEqual(covered, [6]);
    assert.deepStrictEqual(windowed, [6]);
    fsi.reset();
    await storage.Project.update(ids[1], { n: 50 });
    await tick();
    assert.deepStrictEqual(counts, [4, 5]);
    assert.ok(fsi.dataReads() <= 1, 'the record that changed, read once at most');
    await storage.Project.update(ids[1], { note: 'x' });
    await tick();
    assert.deepStrictEqual(counts, [4, 5], 'still in: no emission');
    await storage.delete(ids[7]);
    await storage.Project.insert({ orgId: 'a', name: 'new', slug: 'new', n: 9 });
    await tick();
    assert.deepStrictEqual(counts, [4, 5, 4, 5]);
    assert.deepStrictEqual(covered, [6, 5, 6]);
    assert.deepStrictEqual(windowed, [6, 5, 6], 'the window aside');
    assert.strictEqual(await storage.Project.count({ orgId: 'a', n: { $gte: 5 } }), 5);
    stop();
    stopCovered();
    stopWindowed();
    await storage.delete(ids[9]);
    await tick();
    assert.deepStrictEqual(counts, [4, 5, 4, 5], 'silent after stop');
  });

  await t.test('a cached query tells { f: undefined } from {}', async (t2) => {
    const storage = await createStorage(t2, 'U', { fsi: memory(), schema });
    await storage.Project.insert({ orgId: 'o', name: 'owned', slug: 'a', n: 1, owner: 'x' });
    await storage.Project.insert({ orgId: 'o', name: 'loose', slug: 'b', n: 2 });
    // `{}` asks nothing; `{ owner: undefined }` asks for the field missing: two keys, two results — in either order.
    assert.strictEqual((await storage.Project.select({}).fetch()).length, 2);
    assert.deepStrictEqual(
      (await storage.Project.select({ owner: undefined }).fetch()).map((row) => row.name),
      ['loose'],
    );
    assert.deepStrictEqual(
      (await storage.Project.select({ orgId: 'o', owner: undefined }).fetch()).map((row) => row.name),
      ['loose'],
    );
    assert.strictEqual((await storage.Project.select({ orgId: 'o' }).fetch()).length, 2);
  });

  await t.test(
    'equal queries share one live run, and a result the catalog has not moved since is read from the cache',
    async (t2) => {
      const fsi = counting(memory());
      // Two records cached at most: a run that reads records shows as reads of data/.
      const storage = await createStorage(t2, 'Q', { fsi, schema, cache: { max: 2 } });
      // Through the database: a Document (a collection's insert hands one out) would pin its entry.
      for (let i = 0; i < 10; i++) {
        await storage.insert({ orgId: 'o', name: `n${i}`, slug: `s${i}`, n: i, $type: 'Project' });
      }
      const a = [];
      const b = [];
      const stopA = storage.Project.select({ orgId: 'o', n: { $gte: 3 } })
        .order('n')
        .limit(4)
        .watch((rows) => a.push(rows.length));
      await tick();
      fsi.reset();
      // The same query, built again: no run of its own — the rows as they are, at once.
      const stopB = storage.Project.select({ n: { $gte: 3 }, orgId: 'o' })
        .order('n')
        .limit(4)
        .watch((rows) => b.push(rows.length));
      await tick();
      assert.deepStrictEqual([a, b], [[4], [4]]);
      assert.strictEqual(fsi.dataReads(), 0, 'shared: nothing read for the second');
      // A fetch of the same key reads nothing while the run keeps its rows.
      const rows = await storage.Project.select({ orgId: 'o', n: { $gte: 3 } })
        .order('n')
        .limit(4)
        .fetch();
      assert.deepStrictEqual(
        rows.map((row) => row.n),
        [3, 4, 5, 6],
      );
      assert.strictEqual(fsi.dataReads(), 0, 'from the live run');
      await storage.Project.update(rows[0].id, { n: 30 });
      await tick();
      assert.deepStrictEqual(a.at(-1), 4);
      assert.strictEqual(a.length, b.length, 'both heard it');
      stopA();
      await storage.Project.update(rows[1].id, { n: 31 });
      await tick();
      assert.strictEqual(b.length, a.length + 1, 'the run goes on for the one left');
      stopB();
      // Unobserved: the last rows stay in the cache while the catalog does not move.
      fsi.reset();
      const again = await storage.Project.select({ orgId: 'o', n: { $gte: 3 } })
        .order('n')
        .limit(4)
        .fetch();
      assert.deepStrictEqual(
        again.map((row) => row.n),
        [5, 6, 7, 8],
      );
      assert.strictEqual(fsi.dataReads(), 0, 'kept after the run stopped');
      await storage.Project.update(again[0].id, { note: 'moved' });
      fsi.reset();
      const moved = await storage.Project.select({ orgId: 'o', n: { $gte: 3 } })
        .order('n')
        .limit(4)
        .fetch();
      assert.strictEqual(moved[0].note, 'moved', 'the catalog moved: read again');
      assert.ok(fsi.dataReads() > 0, 'read again');
      // A filter has no key: its own run every time.
      const filtered = storage.Project.select({ orgId: 'o' }).filter((row) => row.n > 3);
      await filtered.fetch();
      fsi.reset();
      await filtered.fetch();
      assert.ok(fsi.dataReads() > 0, 'uncached');
    },
  );

  await t.test('page() and after() visit every row once under inserts that land between the pages', async (t2) => {
    const storage = await createStorage(t2, 'P', { schema });
    const ids = [];
    for (let i = 0; i < 23; i++) {
      ids.push((await storage.Project.insert({ orgId: 'o', name: `n${i}`, slug: `s${i}`, n: i % 5, k: i })).id);
    }
    // Ties on n are broken by the id: every row once, in one order.
    const cursor = storage.Project.select({ orgId: 'o' }).order('n').limit(4);
    const seen = [];
    let page = await cursor.page();
    let pages = 1;
    while (page.next !== null) {
      seen.push(...page.rows.map((row) => row.id));
      // A row that sorts before the edge is not seen; one after it is, once.
      if (pages === 2) {
        await storage.Project.insert({ orgId: 'o', name: 'before', slug: 'before', n: 0, k: 100 });
        await storage.Project.insert({ orgId: 'o', name: 'late', slug: 'late', n: 4, k: 101 });
        ids.push('late');
      }
      page = await cursor.after(page.next).page();
      pages++;
    }
    seen.push(...page.rows.map((row) => row.id));
    assert.strictEqual(new Set(seen).size, seen.length, 'no row twice');
    assert.strictEqual(seen.length, 24, 'every row that was there, and the one that came after the edge');
    assert.ok(pages >= 6);
    const late = await storage.Project.select({ slug: 'late' }).one();
    assert.ok(seen.includes(late.id));
    // `stream()` walks the result in pages, the window honoured; `for await` is a stream.
    const walked = [];
    for await (const row of storage.Project.select({ orgId: 'o' }).order('n').stream({ batch: 4 })) walked.push(row.id);
    const whole = (await storage.Project.select({ orgId: 'o' }).order('n').fetch()).map((row) => row.id);
    assert.deepStrictEqual(walked, whole);
    const four = [];
    for await (const row of cursor) four.push(row.id);
    assert.deepStrictEqual(four, whole.slice(0, 4), 'the limit holds');
    const windowed = [];
    for await (const row of storage.Project.select({ orgId: 'o' }).order('n').offset(3).limit(7).stream({ batch: 2 })) {
      windowed.push(row.id);
    }
    assert.deepStrictEqual(windowed, whole.slice(3, 10));
    await assert.rejects(async () => {
      for await (const row of cursor.stream({ batch: 0 })) void row;
    }, TypeError);
    // Without a limit: one page, no next; offset applies to the first page only.
    const only = await storage.Project.select({ orgId: 'o' }).order('n').page();
    assert.strictEqual(only.next, null);
    assert.strictEqual(only.rows.length, 25);
    const offset = await storage.Project.select({ orgId: 'o' }).order('n').limit(3).offset(2).page();
    assert.deepStrictEqual(
      offset.rows.map((row) => row.id),
      whole.slice(2, 5),
    );
    const following = await storage.Project.select({ orgId: 'o' })
      .order('n')
      .limit(3)
      .offset(2)
      .after(offset.next)
      .page();
    assert.deepStrictEqual(
      following.rows.map((row) => row.id),
      whole.slice(5, 8),
      'offset does not apply after an edge',
    );
    // Unordered: by id.
    const byId = await storage.Project.select({ orgId: 'o' }).limit(10).page();
    assert.deepStrictEqual(
      byId.rows.map((row) => row.id),
      [...whole].sort().slice(0, 10),
    );
    const rest = await storage.Project.select({ orgId: 'o' }).limit(100).after(byId.next).page();
    assert.deepStrictEqual(
      rest.rows.map((row) => row.id),
      [...whole].sort().slice(10),
    );
    assert.strictEqual(rest.next, null);
    assert.throws(() => cursor.after({ keys: [], id: 'x' }), TypeError);
    assert.throws(() => cursor.after('x'), TypeError);
  });

  await t.test(
    'distinct() and countBy() group the matches by a field, in the sort order; nearest() ranks by distance',
    async (t2) => {
      const fsi = counting(memory());
      const storage = await createStorage(t2, 'D', { fsi, schema, cache: { max: 2 } });
      for (let i = 0; i < 12; i++) {
        await storage.insert({
          orgId: `o${i % 3}`,
          kind: i % 2 ? 'lib' : 'app',
          name: `n${i}`,
          slug: `s${i}`,
          n: i % 4,
          v: [i, 12 - i],
          $type: 'Project',
        });
      }
      await storage.insert({ orgId: 'o0', name: 'none', slug: 'none', $type: 'Project' });
      // An indexed field under a covered query: from the catalog, no record read.
      fsi.reset();
      assert.deepStrictEqual(
        await storage.Project.distinct('kind'),
        [null, 'app', 'lib'],
        'a record without the field: null',
      );
      assert.deepStrictEqual(await storage.Project.distinct('orgId', { kind: 'lib' }), ['o0', 'o1', 'o2']);
      assert.strictEqual(fsi.dataReads(), 0, 'from the catalog');
      assert.deepStrictEqual(await storage.Project.countBy('orgId'), [
        { value: 'o0', count: 5 },
        { value: 'o1', count: 4 },
        { value: 'o2', count: 4 },
      ]);
      // A field the catalog does not hold: the records read; a record without the field groups under null.
      assert.deepStrictEqual(await storage.Project.distinct('n'), [null, 0, 1, 2, 3]);
      assert.deepStrictEqual(await storage.Project.select({ orgId: 'o1' }).countBy('n'), [
        { value: 0, count: 1 },
        { value: 1, count: 1 },
        { value: 2, count: 1 },
        { value: 3, count: 1 },
      ]);
      // An array field groups by the whole array.
      assert.strictEqual((await storage.Project.distinct('v')).length, 13, 'twelve arrays, and null');
      await assert.rejects(storage.Project.select().distinct(''), TypeError);
      // Nearest by cosine, by euclidean, by a function; k best, nearest first; a row without a vector is skipped.
      const nearest = await storage.Project.select().nearest('v', [1, 11], 3);
      assert.deepStrictEqual(
        nearest.map(({ row }) => row.name),
        ['n1', 'n0', 'n2'],
      );
      assert.ok(nearest[0].distance <= nearest[1].distance && nearest[1].distance <= nearest[2].distance);
      assert.deepStrictEqual(
        (await storage.Project.select({ kind: 'app' }).nearest('v', [4.5, 7.5], 2, { distance: 'euclidean' })).map(
          ({ row }) => row.name,
        ),
        ['n4', 'n6'],
      );
      const farthest = (a, b) => -Math.abs(a[0] - b[0]);
      assert.deepStrictEqual(
        (await storage.Project.select().nearest('v', [0, 0], 1, { distance: farthest }))[0].row.name,
        'n11',
      );
      assert.deepStrictEqual(await storage.Project.select().nearest('v', [1, 2, 3], 2), [], 'no vector of that length');
      assert.deepStrictEqual((await storage.Project.select().projection(['name']).nearest('v', [0, 12], 1))[0].row, {
        id: (await storage.Project.select({ name: 'n0' }).one()).id,
        name: 'n0',
      });
      await assert.rejects(storage.Project.select().nearest('v', [1, 'x'], 1), TypeError);
      await assert.rejects(storage.Project.select().nearest('v', [1], 1, { distance: 'nope' }), TypeError);
      await assert.rejects(storage.Project.select().nearest('v', [1], -1), TypeError);
    },
  );

  await t.test(
    'an ordered, limited cursor over an index reads offset + limit records and no more; explain() names the index',
    async (t2) => {
      const fsi = counting(memory());
      const compound = { entities: { Task: { index: ['boardId', ['boardId', 'rank'], ['boardId', 'done', 'rank']] } } };
      const storage = await createStorage(t2, 'X', { fsi, schema: compound, cache: { max: 2 } });
      const all = [];
      for (let i = 0; i < 60; i++) {
        const data = { boardId: `b${i % 3}`, rank: (i * 7) % 60, done: i % 4 === 0, title: `t${i}` };
        const id = await storage.insert({ ...data, $type: 'Task' });
        all.push({ id, ...data, $type: 'Task' });
      }
      const byRank = (a, b) => a.rank - b.rank || (a.id < b.id ? -1 : 1);
      const reference = all.filter((row) => row.boardId === 'b1' && row.rank >= 10).sort(byRank);
      const cursor = storage.Task.select({ boardId: 'b1', rank: { $gte: 10 } })
        .order('rank')
        .limit(4)
        .offset(3);
      assert.deepStrictEqual(cursor.explain(), {
        scan: 'index',
        index: ['boardId', 'rank'],
        prefix: ['b1'],
        range: { field: 'rank', lower: { value: 10, inclusive: true }, upper: null },
        desc: false,
        sortedByIndex: true,
        covered: false,
        residual: false,
        uses: { equalities: ['boardId'], ranges: ['rank'], order: ['rank'] },
      });
      fsi.reset();
      const rows = await cursor.fetch();
      assert.deepStrictEqual(rows, reference.slice(3, 7));
      assert.strictEqual(fsi.dataReads(), 7, 'offset + limit records, not the board');
      // Backwards, a bounded range, a three-field key.
      const back = storage.Task.select({ boardId: 'b1', rank: { $gt: 10, $lte: 40 } })
        .desc('rank')
        .limit(2);
      assert.strictEqual(back.explain().desc, true);
      assert.deepStrictEqual(
        await back.fetch(),
        [...reference]
          .filter((row) => row.rank > 10 && row.rank <= 40)
          .sort(byRank)
          .reverse()
          .slice(0, 2),
      );
      const three = storage.Task.select({ boardId: 'b2', done: true }).order('rank');
      assert.deepStrictEqual(three.explain().index, ['boardId', 'done', 'rank']);
      assert.deepStrictEqual(
        (await three.fetch()).map((row) => row.rank),
        all
          .filter((row) => row.boardId === 'b2' && row.done)
          .sort(byRank)
          .map((row) => row.rank),
      );
      // A sort the index cannot serve: read by the prefix, sorted after — the oracle's order still.
      const resorted = storage.Task.select({ boardId: 'b0' }).order('title').limit(5);
      const made = resorted.explain();
      assert.strictEqual(made.scan, 'index');
      assert.strictEqual(made.sortedByIndex, false);
      assert.deepStrictEqual(
        (await resorted.fetch()).map((row) => row.title),
        all
          .filter((row) => row.boardId === 'b0')
          .map((row) => row.title)
          .sort()
          .slice(0, 5),
      );
      // A field with no index at all: the collection; an equality on an indexed one: the posting lists.
      assert.strictEqual(storage.Task.select({ title: 't1' }).explain().scan, 'collection');
      assert.strictEqual(
        storage.Task.select({ boardId: 'b0', $or: [{ done: true }, { rank: 1 }] }).explain().scan,
        'index',
      );
      assert.strictEqual(storage.Task.select({ boardId: { $in: ['b0', 'b1'] } }).explain().scan, 'postings');
      // A live query over the index stays a fresh run.
      const seen = [];
      const stop = cursor.watch((page) => seen.push(page));
      await tick();
      await storage.Task.update(reference[4].id, { rank: 11 });
      await tick();
      assert.deepStrictEqual(seen.at(-1), await cursor.fetch());
      stop();
      // The plan is a copy.
      const copy = cursor.explain();
      copy.index.push('x');
      assert.deepStrictEqual(cursor.explain().index, ['boardId', 'rank']);
    },
  );

  await t.test(
    'an unordered limit over an index range is the first rows by id, as a run of every candidate gives',
    async (t2) => {
      const compound = { entities: { Task: { index: [['boardId', 'rank']] } } };
      const storage = await createStorage(t2, 'W', { fsi: memory(), schema: compound });
      for (let i = 0; i < 40; i++) await storage.insert({ boardId: `b${i % 2}`, rank: (i * 7) % 40, $type: 'Task' });
      const cursor = storage.Task.select({ boardId: 'b1', rank: { $gte: 10 } });
      assert.strictEqual(cursor.explain().sortedByIndex, false, 'a range: not a whole key, so not in id order');
      const every = await cursor.fetch();
      const ids = every.map((row) => row.id);
      assert.deepStrictEqual(ids, ids.slice().sort(), 'the result without keys: by id');
      assert.deepStrictEqual(await cursor.limit(3).fetch(), every.slice(0, 3));
      assert.deepStrictEqual(await cursor.offset(2).limit(3).fetch(), every.slice(2, 5));
      assert.deepStrictEqual(await cursor.one(), every[0]);
      // A whole-key match comes in id order already.
      assert.strictEqual(storage.Task.select({ boardId: 'b0', rank: 7 }).explain().sortedByIndex, true);
    },
  );

  await t.test('an index with fields beyond the order’s keys serves the prefix and sorts after', async (t2) => {
    const compound = { entities: { Task: { index: [['boardId', 'done', 'rank']] } } };
    const storage = await createStorage(t2, 'Y', { fsi: memory(), schema: compound });
    const all = [];
    for (let i = 0; i < 30; i++) {
      const data = { boardId: 'b', done: i % 3 === 0, rank: (i * 7) % 30, $type: 'Task' };
      all.push({ ...data, id: await storage.insert(data) });
    }
    const cursor = storage.Task.select({ boardId: 'b' }).order('done');
    const made = cursor.explain();
    assert.deepStrictEqual(made.index, ['boardId', 'done', 'rank']);
    assert.strictEqual(
      made.sortedByIndex,
      false,
      'rank lies beyond the order: equal done would come by rank, not by id',
    );
    const byDone = (a, b) => (a.done === b.done ? (a.id < b.id ? -1 : 1) : a.done ? 1 : -1);
    assert.deepStrictEqual(await cursor.fetch(), all.slice().sort(byDone));
    // With the next key in the order too, the index serves the sort whole.
    const full = storage.Task.select({ boardId: 'b' }).order('done').order('rank');
    assert.strictEqual(full.explain().sortedByIndex, true);
    const byBoth = (a, b) => (a.done !== b.done ? (a.done ? 1 : -1) : a.rank - b.rank || (a.id < b.id ? -1 : 1));
    assert.deepStrictEqual(await full.fetch(), all.slice().sort(byBoth));
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
