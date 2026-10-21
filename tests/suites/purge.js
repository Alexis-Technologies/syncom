'use strict';

// Forgetting for good, against whichever half the caller builds: nothing of
// the record left in data/ or log/, nothing later revives it, peers scrub
// too, a bootstrap carries the purged tombstone, a torn scrub is retried.

const { createMesh, settle, waitUntil } = require('../utils/mesh.js');

const SECRET = 'SSN-123-45-6789';

// Every byte under `<path>/log` and `<path>/data`, through the storage's own backend.
const dump = async (storage, dir) => {
  const { fsi } = storage;
  let text = '';
  for (const name of await fsi.list(dir)) text += await fsi.read(dir, name);
  return text;
};
const holdsSecret = async (storage) => {
  const base = storage.path;
  const texts = await Promise.all([
    dump(storage, `${base}/data`),
    dump(storage, `${base}/log`),
    dump(storage, `${base}/log/open`),
  ]);
  return texts.some((text) => text.includes(SECRET));
};

const runPurgeTests = async (t, assert, createStorage) => {
  await t.test('after a purge nothing of the record is left, and nothing later revives it', async (t2) => {
    let storage = await createStorage(t2, 'A', {
      schema: { entities: { Person: {} } },
      sync: { log: { rollAfter: 1 } },
    });
    const ops = [];
    storage.on('change', (op) => ops.push(op));
    const hooks = [];
    const person = await storage.Person.insert({ name: 'Ada', ssn: SECRET });
    await storage.update(person.id, { ssn: SECRET, note: 'x' });
    await storage.inc(person.id, 'visits', 3);
    await storage.add(person.id, 'aliases', [SECRET]);
    const keep = await storage.insert({ ssn: 'KEEP' });
    assert.strictEqual(await holdsSecret(storage), true, 'before: the payload is in the log and the record');
    const record = await storage.record(person.id);
    const updates = [];
    record.on('update', (data) => updates.push(data));
    await storage.purge(person.id, { actor: 'dpo' });
    assert.strictEqual(await holdsSecret(storage), false, 'after: gone from data/ and log/');
    assert.deepStrictEqual(updates, [null]);
    assert.strictEqual(await storage.get(person.id), null);
    assert.strictEqual(await storage.has(person.id), false);
    assert.strictEqual(storage.hasRecord(person.id), false);
    assert.deepStrictEqual(await storage.list(), [keep]);
    assert.strictEqual(await storage.Person.count(), 0);
    assert.strictEqual(await storage.validate(), true, 'the chain is intact');
    const purge = ops.at(-1);
    assert.deepStrictEqual([purge.type, purge.actor, purge.id], ['purge', 'dpo', person.id]);
    const entries = storage.log.since(undefined).filter((entry) => entry.op.id === person.id);
    assert.ok(entries.length >= 5);
    const bare = (op) => !('data' in op) && !('key' in op) && !('value' in op);
    assert.ok(entries.every((entry) => entry.scrubbed === true && bare(entry.op)));
    const page = await storage.snapshot();
    const tombstone = page.records.find((r) => r.id === person.id);
    assert.deepStrictEqual(tombstone.data, {});
    assert.ok(Array.isArray(tombstone.meta.purged));
    // Nothing lands on it: a local set or write, a peer's newer write.
    await storage.set(person.id, { name: 'Back', ssn: SECRET });
    await assert.rejects(() => storage.update(person.id, { name: 'Back' }), /not found/);
    await storage.applyRemote([
      { origin: 'peer', seq: 1, ts: Date.now() + 100_000, type: 'write', id: person.id, data: { ssn: SECRET } },
    ]);
    assert.strictEqual(await storage.get(person.id), null);
    assert.strictEqual(await holdsSecret(storage), false, 'the peer’s op was scrubbed on arrival');
    assert.strictEqual(storage.vector.peer, 1, 'but counted');
    await storage.purge(person.id);
    assert.strictEqual(await storage.get(person.id), null, 'idempotent');
    // A reopen replays nothing of it.
    await storage.close();
    storage = await createStorage(t2, 'A', { schema: { entities: { Person: {} } }, sync: { log: { rollAfter: 1 } } });
    assert.strictEqual(await storage.get(person.id), null);
    assert.deepStrictEqual(await storage.get(keep), { ssn: 'KEEP' });
    assert.strictEqual(await holdsSecret(storage), false);
    assert.deepStrictEqual(hooks, []);
  });

  await t.test('an encrypted record is purged too: the file goes, the catalog follows', async (t2) => {
    const storage = await createStorage(t2, 'A');
    const id = await storage.insert({ ssn: SECRET }, { encrypted: true });
    assert.deepStrictEqual(await storage.list(), [id]);
    await storage.purge(id);
    assert.deepStrictEqual(await storage.list(), []);
    assert.strictEqual(await storage.get(id), null);
    assert.strictEqual(storage.log.length, 0, 'an encrypted record has no ops');
  });

  await t.test(
    'a purge reaches every peer, which scrubs its own log; a bootstrap carries the tombstone',
    async (t2) => {
      const mesh = await createMesh(
        t2,
        ['A', 'B', 'C'],
        [
          ['B', 'A'],
          ['C', 'B'],
        ],
        createStorage,
        { sync: { log: { rollAfter: 2 }, retention: { ops: 4 } } },
      );
      const [a, b, c] = ['A', 'B', 'C'].map((name) => mesh.get(name));
      await waitUntil(() => b.sync.peers()[0]?.subscribed && c.sync.peers()[0]?.subscribed);
      const id = await a.insert({ ssn: SECRET });
      await a.update(id, { more: SECRET });
      await settle([a, b, c]);
      assert.deepStrictEqual(await c.get(id), { ssn: SECRET, more: SECRET });
      assert.strictEqual(await holdsSecret(c), true);
      await a.purge(id);
      await settle([a, b, c]);
      for (const [name, storage] of [
        ['A', a],
        ['B', b],
        ['C', c],
      ]) {
        assert.strictEqual(await storage.get(id), null, name);
        assert.strictEqual(await holdsSecret(storage), false, `${name} scrubbed`);
      }
      // A late write from C (its clock ahead) does not bring it back anywhere.
      await c.set(id, { ssn: SECRET, late: true });
      await settle([a, b, c]);
      for (const storage of [a, b, c]) assert.strictEqual(await storage.get(id), null);
      assert.strictEqual(await holdsSecret(a), false);
      // A newcomer that must bootstrap from B gets the tombstone, not the data.
      for (let i = 0; i < 8; i++) await b.insert({ i });
      await b.log.flush();
      const d = await createStorage(t2, 'D', { sync: { autoStart: false, connect: mesh.connect } });
      const bootstraps = [];
      d.sync.on('bootstrap', (event) => bootstraps.push(event));
      await d.sync.addNode({ url: 'mem://B' });
      await d.sync.start();
      await waitUntil(() => bootstraps.length > 0);
      await settle([b, d]);
      assert.strictEqual(await d.get(id), null);
      assert.strictEqual(await holdsSecret(d), false);
      assert.strictEqual((await d.list()).length, 8);
    },
  );

  await t.test('a scrub that fails mid-way rejects the purge; the next purge finishes it', async (t2) => {
    const { createMemoryFsi } = require('../../src/backend.js');
    const inner = createMemoryFsi();
    let failing = false;
    const fsi = {
      read: (dir, name) => inner.read(dir, name),
      exists: (dir, name) => inner.exists(dir, name),
      remove: (dir, name) => inner.remove(dir, name),
      list: (dir) => inner.list(dir),
      // A rewrite of a sealed segment fails; the roll that seals one does not.
      write: async (dir, name, content) => {
        if (failing && name.startsWith('seg-') && (await inner.exists(dir, name))) throw new Error('disk full');
        return inner.write(dir, name, content);
      },
    };
    const storage = await createStorage(t2, 'A', { fsi, sync: { log: { rollAfter: 1 } } });
    const id = await storage.insert({ ssn: SECRET });
    await storage.update(id, { ssn: SECRET });
    failing = true;
    await assert.rejects(() => storage.purge(id), /disk full/);
    assert.strictEqual(await storage.get(id), null, 'the purge op itself landed');
    failing = false;
    await storage.purge(id);
    assert.strictEqual(await holdsSecret(storage), false);
    assert.strictEqual(await storage.validate(), true);
  });
};

module.exports = { runPurgeTests };
