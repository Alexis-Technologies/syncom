'use strict';

// A database over an engine given: `createDatabase({ engine })` — the files
// engine over memory here — stores every byte through it, a batch is one
// write set, a branch opens on the parent's engine, and an engine beside a
// backend is refused.

const test = require('node:test');
const assert = require('node:assert');
const { createDatabase, filesEngine, isEngine } = require('../src/all/all.js');
const { memory } = require('../src/memory/memory.js');
const { branch, drop } = require('../src/branch/branch.js');
const { PIECES_MIN } = require('../src/text/sequence.js');

// An engine whose write sets are counted: what a batch costs the medium.
const counting = (inner) => {
  // `dropped` and `copied` ride in write sets; `besides` counts a piece removed or a copy put outside one.
  const calls = { writes: 0, records: 0, dropped: 0, copied: 0, besides: 0 };
  const engine = {
    name: `${inner.name}+counting`,
    capabilities: inner.capabilities,
    remove: (path) => inner.remove(path),
    async open(path, options) {
      const db = await inner.open(path, options);
      return {
        ...db,
        pieces: {
          ...db.pieces,
          remove(id, name) {
            calls.besides++;
            return db.pieces.remove(id, name);
          },
        },
        copies: {
          ...db.copies,
          put(tag, id, text) {
            calls.besides++;
            return db.copies.put(tag, id, text);
          },
        },
        write(batch) {
          calls.writes++;
          calls.records += batch.records?.length ?? 0;
          for (const row of batch.records ?? []) calls.dropped += row.pieces?.remove?.length ?? 0;
          calls.copied += batch.copies?.put?.length ?? 0;
          return db.write(batch);
        },
      };
    },
  };
  return { engine, calls };
};

test('a database over an engine', async (t) => {
  await t.test(
    'createDatabase({ engine }) stores through it; fsi is the files engine’s backend, engine the one given',
    async () => {
      const fsi = memory();
      const engine = filesEngine(fsi);
      const db = await createDatabase({ path: 'app', engine, logger: false, defer: 0, lock: false });
      assert.strictEqual(db.engine, engine);
      assert.strictEqual(db.fsi, fsi, 'the files engine hands its backend out');
      assert.strictEqual(isEngine(db.engine), true);
      const id = await db.insert({ title: 'Draft' });
      await db.update(id, { title: 'Final' });
      assert.deepStrictEqual(await db.get(id), { title: 'Final' });
      assert.ok(Object.keys(fsi.dump()).includes(`app/data/${id}.json`), 'the record is where it always was');
      assert.ok(Object.keys(fsi.dump()).includes('app/node.json'));
      await db.close();
      // A reopen through the same engine reads it back.
      const again = await createDatabase({ path: 'app', engine, logger: false, defer: 0, lock: false });
      assert.deepStrictEqual(await again.get(id), { title: 'Final' });
      await again.close();
    },
  );

  await t.test('an engine and a backend together, or no engine at all, are refused by name', async () => {
    // Options are checked before anything is opened: a throw, not a rejection, like every other option.
    assert.throws(() => createDatabase({ path: 'x', engine: filesEngine(memory()), fsi: memory() }), {
      name: 'TypeError',
      message: /createDatabase\(\{ engine, fsi \}\): an engine or a backend, not both/,
    });
    assert.throws(() => createDatabase({ path: 'x', engine: { open() {} } }), {
      name: 'TypeError',
      message: /createDatabase\(\{ engine \}\): engine has no remove/,
    });
  });

  await t.test('a transaction of many records is ONE write set of the engine; a single write one too', async () => {
    const { engine, calls } = counting(filesEngine(memory()));
    const db = await createDatabase({ path: 'batch', engine, logger: false, defer: 0, lock: false, chain: false });
    await db.transact(async (tx) => {
      for (let i = 0; i < 25; i++) await tx.insert({ n: i });
    });
    assert.strictEqual(calls.writes, 1, 'one write set for the transaction');
    assert.strictEqual(calls.records, 25);
    await db.insert({ n: 'one' });
    assert.strictEqual(calls.writes, 2);
    assert.strictEqual(calls.records, 26);
    assert.strictEqual((await db.list()).length, 26);
    await db.close();
  });

  await t.test(
    'the pieces a record drops and the tags’ copies ride in the landing’s write set, nothing beside it',
    async () => {
      const { engine, calls } = counting(filesEngine(memory()));
      const db = await createDatabase({ path: 'set', engine, logger: false, defer: 0, lock: false, chain: false });
      const id = await db.insert({ title: 'A' });
      // A text of more runs than fit the record file: its pieces ride beside it (src/text/sequence.js PIECES_MIN).
      for (let i = 0; i < PIECES_MIN + 10; i++) await db.splice(id, 'body', 0, 0, String.fromCharCode(97 + (i % 26)));
      await db.tag('v1');
      const before = { ...calls };
      await db.update(id, { title: 'B' });
      assert.strictEqual(calls.writes, before.writes + 1, 'one write set for the update');
      assert.strictEqual(calls.copied, before.copied + 1, 'the tag’s copy rode in it');
      for (let i = 0; i < 20; i++) await db.splice(id, 'body', 0, 0, 'Z');
      assert.ok(calls.dropped > before.dropped, 'the pieces the text left behind rode in a write set');
      assert.strictEqual(calls.besides, 0, 'no copy put and no piece removed beside a write set');
      assert.strictEqual((await db.at('v1').get(id)).title, 'A', 'the tag reads the record as it was');
      assert.strictEqual((await db.get(id)).body.length, PIECES_MIN + 30);
      await db.close();
    },
  );

  await t.test('a branch opens on the parent’s engine and drop() removes it through the engine', async () => {
    const fsi = memory();
    const parent = await createDatabase({ path: 'p', engine: filesEngine(fsi), logger: false, defer: 0, lock: false });
    const id = await parent.insert({ title: 'root' });
    const child = await branch(parent, { path: 'b', logger: false, defer: 0 });
    assert.strictEqual(child.engine, parent.engine);
    assert.deepStrictEqual(await child.get(id), { title: 'root' });
    assert.ok((await fsi.list('b')).includes('branch.json'));
    await drop(child);
    assert.deepStrictEqual(await fsi.list('b'), [], 'every file of the branch went');
    await parent.close();
  });
});
