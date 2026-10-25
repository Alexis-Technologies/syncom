'use strict';

// Branches, against whichever half the caller builds: a fork stands at the
// parent (or at a tag of it) under a new identity, edits on either side
// merge both ways and reach the parent's peers, a compacted parent joins as
// state, signatures are required and met, a branch is dropped.

const { createMesh, settle } = require('../utils/mesh.js');
const { branch, merge, branchInfo, drop } = require('../../src/branch/branch.js');
const { prng } = require('../utils/mesh.js');

const dump = async (storage) => {
  const out = {};
  for (const id of await storage.list()) out[id] = await storage.get(id);
  return out;
};

const runBranchTests = async (t, assert, createStorage, branchPath) => {
  await t.test('a fork stands at the parent under a new identity; merges go both ways', async (t2) => {
    const parent = await createStorage(t2, 'A', { schema: { entities: { Post: { index: ['n'] } } } });
    const post = await parent.Post.insert({ n: 1, title: 'a' });
    await parent.inc(post.id, 'hits', 2);
    await parent.add(post.id, 'tags', ['x']);
    await parent.splice(post.id, 'body', 0, 0, 'hello');
    await parent.treeMove(post.id, 'outline', 'r');
    const other = await parent.insert({ plain: true });
    const gone = await parent.insert({ doomed: true });
    await parent.delete(gone);
    const child = await branch(parent, {
      path: branchPath(t2, 'child'),
      schema: { entities: { Post: { index: ['n'] } } },
    });
    t2.after(() => child.close().catch(() => {}));
    assert.notStrictEqual(child.nodeId, parent.nodeId, 'a new identity');
    assert.deepStrictEqual(await dump(child), await dump(parent), 'the same records');
    assert.strictEqual(await child.get(gone), null);
    assert.deepStrictEqual(await child.Post.select({ n: 1 }).fetch(), await parent.Post.select({ n: 1 }).fetch());
    const info = await branchInfo(child);
    assert.strictEqual(info.parent, parent.nodeId);
    assert.deepStrictEqual(info.forkedAt.vector, parent.vector);
    assert.strictEqual(info.forkedAt.eventId, parent.log.lastEventId);
    assert.strictEqual(info.forkedAt.tag, null);
    assert.strictEqual(await branchInfo(parent), null);
    await assert.rejects(() => branch(parent, { path: child.path }), { code: 'BRANCH_EXISTS', path: child.path });
    // Edits apart, merged both ways; a second merge has nothing to hand over.
    await child.Post.update(post.id, { title: 'from the branch' });
    await child.inc(post.id, 'hits', 1);
    await child.insert({ born: 'on the branch' });
    await parent.Post.update(post.id, { n: 2 });
    await parent.push(post.id, 'body', '!');
    await parent.delete(other);
    const up = await merge(child, { into: parent });
    assert.ok(up.ops >= 3 && up.joined === false, JSON.stringify(up));
    const down = await merge(parent, { into: child });
    assert.ok(down.ops >= 3 && down.joined === false, JSON.stringify(down));
    assert.deepStrictEqual(await dump(child), await dump(parent));
    assert.deepStrictEqual((await parent.get(post.id)).hits, 3);
    assert.deepStrictEqual((await parent.get(post.id)).title, 'from the branch');
    assert.strictEqual(await child.get(other), null);
    assert.deepStrictEqual(await merge(child, { into: parent }), { ops: 0, pages: 0, joined: false });
    assert.deepStrictEqual(await merge(parent, { into: child }), { ops: 0, pages: 0, joined: false });
    // A branch has a history and tags of its own.
    assert.ok((await child.history(post.id)).versions.length > 0);
    await child.tag('on-branch');
    assert.strictEqual(await child.at('on-branch').has(post.id), true);
    await assert.rejects(() => merge(parent, { into: parent }), TypeError);
    await assert.rejects(() => merge(parent, {}), TypeError);
    await assert.rejects(() => branch(parent, {}), TypeError);
    await assert.rejects(() => branch(parent, { path: 'x', from: 'v1' }), TypeError);
    await assert.rejects(() => branch({}, { path: 'x' }), TypeError);
    await assert.rejects(() => branchInfo({}), TypeError);
  });

  await t.test(
    'a fork from a tag stands at the tag; the parent’s peers receive what the branch merges back',
    async (t2) => {
      const mesh = await createMesh(t2, ['A', 'B'], [['A', 'B']], createStorage);
      const parent = mesh.get('A');
      const peer = mesh.get('B');
      const id = await parent.insert({ n: 1 });
      const tag = await parent.tag('v1');
      await parent.update(id, { n: 2 });
      const late = await parent.insert({ late: true });
      await settle([parent, peer]);
      const child = await branch(parent, { path: branchPath(t2, 'tagged'), from: { tag: 'v1' } });
      t2.after(() => child.close().catch(() => {}));
      assert.deepStrictEqual(await child.get(id), { n: 1 }, 'as at the tag');
      assert.strictEqual(await child.get(late), null);
      const info = await branchInfo(child);
      assert.deepStrictEqual(
        [info.forkedAt.tag, info.forkedAt.eventId, info.forkedAt.vector],
        ['v1', tag.eventId, tag.vector],
      );
      // What the branch writes reaches the parent's peers through the parent.
      await child.update(id, { fromBranch: true });
      await merge(child, { into: parent });
      await settle([parent, peer]);
      assert.deepStrictEqual(await peer.get(id), { n: 2, fromBranch: true });
      // And the parent's present reaches the branch.
      await merge(parent, { into: child });
      assert.deepStrictEqual(await child.get(late), { late: true });
      assert.deepStrictEqual(await child.get(id), { n: 2, fromBranch: true });
    },
  );

  await t.test(
    'a parent that compacted past the fork is joined as state; signatures are required and met',
    async (t2) => {
      const parent = await createStorage(t2, 'A', {
        sync: { log: { rollAfter: 1 }, retention: { ops: 4 }, signatures: 'require' },
      });
      const id = await parent.insert({ n: 0 });
      const child = await branch(parent, { path: branchPath(t2, 'compacted'), sync: { signatures: 'require' } });
      t2.after(() => child.close().catch(() => {}));
      for (let i = 1; i <= 8; i++) await parent.update(id, { n: i });
      assert.ok(parent.log.floor > 1, 'compacted');
      await child.update(id, { fromBranch: true });
      const result = await merge(parent, { into: child });
      assert.deepStrictEqual([result.joined, result.ops], [true, 0]);
      assert.ok(result.pages >= 1);
      assert.deepStrictEqual(
        await child.get(id),
        { n: 8, fromBranch: true },
        'the parent’s state joined, the branch’s edit kept',
      );
      // Back up: the branch's own ops are signed by its own key, and taken.
      const up = await merge(child, { into: parent });
      assert.ok(up.ops >= 1 && !up.joined);
      assert.deepStrictEqual(await parent.get(id), { n: 8, fromBranch: true });
      assert.deepStrictEqual(await merge(child, { into: parent }), { ops: 0, pages: 0, joined: false });
    },
  );

  await t.test('edits on both sides, merged in random order, converge; drop() removes the branch', async (t2) => {
    const parent = await createStorage(t2, 'A');
    const ids = [];
    for (let i = 0; i < 3; i++) ids.push(await parent.insert({ n: i }));
    const child = await branch(parent, { path: branchPath(t2, 'fuzz') });
    const random = prng(20261024);
    for (let step = 0; step < 40; step++) {
      const storage = random() < 0.5 ? parent : child;
      const id = ids[Math.floor(random() * ids.length)];
      const roll = random();
      try {
        if (roll < 0.3) await storage.update(id, { [`f${step % 3}`]: step });
        else if (roll < 0.5) await storage.inc(id, 'hits', 1);
        else if (roll < 0.65) await storage.add(id, 'tags', [`t${step % 4}`]);
        else if (roll < 0.75) await storage.remove(id, 'tags', [`t${step % 4}`]);
        else if (roll < 0.9) await storage.push(id, 'body', storage === parent ? 'p' : 'c');
        else await storage.delete(id);
      } catch (error) {
        if (!/not found/.test(error.message)) throw error;
      }
      if (step % 10 === 9) {
        if (random() < 0.5) await merge(child, { into: parent });
        else await merge(parent, { into: child });
      }
    }
    await merge(child, { into: parent });
    await merge(parent, { into: child });
    assert.deepStrictEqual(await dump(child), await dump(parent));
    // The blocks agree, not only what they read as.
    const metas = async (storage) =>
      (await storage.snapshot()).records.map((r) => [r.id, r.meta.blocks ?? {}, r.meta.counters]);
    assert.deepStrictEqual(await metas(child), await metas(parent));
    const path = child.path;
    const { fsi } = child;
    await child.tag('kept');
    await drop(child);
    for (const dir of [
      '',
      'data',
      'log',
      'log/open',
      'index',
      'keys',
      'blockchain',
      'tags/kept/data',
      'tags/kept/index',
    ]) {
      const names = await fsi.list(dir === '' ? path : `${path}/${dir}`).catch(() => []);
      assert.deepStrictEqual(names, [], dir || 'root');
    }
    await assert.rejects(() => child.insert({ x: 1 }), { code: 'CLOSED' });
    await assert.rejects(() => drop({}), TypeError);
  });

  await t.test(
    'drop() takes a branch alone: a storage with no branch.json is refused and keeps its files',
    async (t2) => {
      const parent = await createStorage(t2, 'A');
      const id = await parent.insert({ keep: true });
      await assert.rejects(() => drop(parent), { name: 'TypeError', message: /takes a branch/ });
      assert.deepStrictEqual(await parent.get(id), { keep: true }, 'still open, nothing removed');
      assert.ok((await parent.fsi.list(parent.path)).includes('node.json'));
    },
  );

  await t.test('branch() opens a new directory: a path that holds files — another storage — is refused', async (t2) => {
    const parent = await createStorage(t2, 'A');
    await parent.insert({ p: 1 });
    const other = await createStorage(t2, 'B');
    const kept = await other.insert({ o: 1 });
    await other.close();
    await assert.rejects(() => branch(parent, { path: other.path }), { code: 'BRANCH_EXISTS', path: other.path });
    const again = await createStorage(t2, 'B');
    assert.deepStrictEqual(await again.list(), [kept], 'the other storage is as it was');
    assert.strictEqual(again.nodeId, other.nodeId);
  });

  await t.test('a failed branch() leaves nothing behind: the next attempt starts clean', async (t2) => {
    const parent = await createStorage(t2, 'A');
    await parent.insert({ p: 1 });
    const path = branchPath(t2, 'aborted');
    await assert.rejects(() => branch(parent, { path, from: { tag: 'nope' } }), { code: 'TAG_NOT_FOUND' });
    let names = [];
    try {
      names = await parent.fsi.list(path);
    } catch {
      names = [];
    }
    assert.deepStrictEqual(names, [], 'no node.json, no lock, no log left');
    const child = await branch(parent, { path });
    t2.after(() => child.close().catch(() => {}));
    assert.notStrictEqual(child.nodeId, parent.nodeId);
    assert.deepStrictEqual(await child.list(), await parent.list());
  });

  await t.test(
    'a merge hands over every stream or joins as state: a third node’s ops the parent compacted are never skipped',
    async (t2) => {
      const parent = await createStorage(t2, 'A', { sync: { log: { rollAfter: 1 }, retention: { ops: 2 } } });
      const third = await createStorage(t2, 'T');
      // The third node's ops reach the parent one page per op, as a feed
      // would deliver them, so the parent rolls and compacts as it goes.
      let sent = 0;
      const feed = async () => {
        const entries = third.log.since(undefined) ?? [];
        const page = JSON.parse(JSON.stringify(entries.slice(sent).map((entry) => entry.op)));
        sent = entries.length;
        await parent.applyRemote(page, { via: { url: null, node: third.nodeId } });
      };
      for (let i = 1; i <= 3; i++) {
        await third.set(`t${i}`, { v: i });
        await feed();
      }
      const child = await branch(parent, { path: branchPath(t2, 'third') });
      t2.after(() => child.close().catch(() => {}));
      for (let i = 4; i <= 14; i++) {
        await third.set(`t${i}`, { v: i });
        await feed();
      }
      assert.ok(parent.log.floor > 4, 'the parent compacted past what the branch holds of the third node');
      const result = await merge(parent, { into: child });
      assert.strictEqual(result.joined, true, 'joined as state, not fed gaps');
      assert.deepStrictEqual(await dump(child), await dump(parent));
      assert.deepStrictEqual(await merge(parent, { into: child }), { ops: 0, pages: 0, joined: false });
    },
  );
};

module.exports = { runBranchTests };
