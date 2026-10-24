'use strict';

// Encryption at rest through the whole API: a storage opened with
// `encrypted: true`, per-call overrides, and what stays local.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs/promises');
const path = require('node:path');
const syncom = require('..');
const { createTemp, cleanupTemp } = require('./utils/temp.js');

test('encrypted storage', async (t) => {
  await t.test('every write path encrypts, reads decrypt, nothing becomes an op', async (t2) => {
    const dir = await createTemp();
    t2.after(() => cleanupTemp(dir));
    const storage = await syncom.open({
      path: dir,
      logger: false,
      encrypted: true,
      schema: { entities: { Note: {} } },
    });
    const ops = [];
    storage.on('change', (op) => ops.push(op));

    const id = await storage.insert({ title: 'Secret', body: 'x'.repeat(10_000) });
    const raw = JSON.parse(await fs.readFile(path.join(dir, 'data', `${id}.json`), 'utf8'));
    assert.strictEqual(raw.encrypted, true);
    assert.ok(!raw.data.includes('Secret'));
    assert.strictEqual((await storage.get(id)).title, 'Secret');

    await storage.update(id, { title: 'Still secret' });
    await storage.set(id, { title: 'Replaced' });
    const record = await storage.record(id);
    const updates = [];
    record.on('update', (data, delta) => updates.push(delta));
    record.title = 'Via record';
    await record.save();
    assert.strictEqual((await storage.get(id)).title, 'Via record');
    assert.strictEqual(await storage.swap(id, { title: 'Swapped' }, { title: 'Via record' }), true);
    assert.strictEqual(record.title, 'Swapped');
    assert.deepStrictEqual(updates.at(-1), { title: 'Swapped' });

    const note = await storage.Note.insert({ text: 'n' });
    assert.deepStrictEqual((await storage.list()).sort(), [id, note.id].sort());
    assert.strictEqual(await storage.has(id), true);
    await assert.rejects(() => storage.inc(id, 'hits', 1), /encrypted/);
    assert.strictEqual(ops.length, 0, 'encrypted records never leave the node');
    assert.deepStrictEqual((await storage.snapshot()).records, []);
    assert.strictEqual(await storage.validate(), true);

    await storage.delete(id);
    assert.strictEqual(await storage.get(id), null);
    assert.strictEqual(await storage.has(id), false);
    assert.deepStrictEqual(await storage.list(), [note.id]);
    assert.strictEqual(await record.data(), null);

    // A cold reopen decrypts with the stored key pair.
    await storage.close();
    const reopened = await syncom.open({ path: dir, logger: false, encrypted: true });
    assert.deepStrictEqual(await reopened.get(note.id), { text: 'n', $type: 'Note' });
    await reopened.close();
  });

  await t.test('per-call overrides go both ways, and a record never changes kind', async (t2) => {
    const dir = await createTemp();
    t2.after(() => cleanupTemp(dir));
    const storage = await syncom.open({ path: dir, logger: false, encrypted: true });
    const ops = [];
    storage.on('change', (op) => ops.push(op));
    const shared = await storage.insert({ shared: true }, { encrypted: false });
    assert.strictEqual(ops.length, 1, 'an explicitly replicated record is an op');
    await assert.rejects(() => storage.set(shared, { x: 1 }, { encrypted: true }), {
      code: 'ENCRYPTED',
      message: /replicated and cannot become encrypted/,
    });

    const plain = await syncom.open({ path: await createTemp(), logger: false });
    const local = await plain.insert({ local: true }, { encrypted: true });
    assert.deepStrictEqual(await plain.get(local), { local: true });
    assert.strictEqual(plain.log.length, 0);
    await plain.set(local, { local: 'still' });
    assert.strictEqual(plain.log.length, 0, 'set on an encrypted record stays encrypted and local');
    await storage.close();
    await plain.close();
  });

  await t.test("a peer's op on a record sealed here is skipped: logged and relayed, never applied", async (t2) => {
    const dir = await createTemp();
    t2.after(() => cleanupTemp(dir));
    const storage = await syncom.open({ path: dir, logger: false, encrypted: true });
    const id = await storage.insert({ secret: 'mine' });
    const op = { origin: 'peer', seq: 1, ts: Date.now() + 1, type: 'set', id, data: { secret: 'theirs' } };
    const result = await storage.applyRemote([op]);
    assert.strictEqual(result.applied, 1);
    assert.strictEqual(result.skipped, 1, 'accepted for the log and the vector, not for the record');
    assert.deepStrictEqual(await storage.get(id), { secret: 'mine' });
    const entry = storage.log.since(undefined).find((e) => e.op.origin === 'peer');
    assert.strictEqual(entry.skipped, true, 'flagged, so no replay or fold applies it');
    assert.strictEqual(storage.vector.peer, 1, 'the vector moved');
    await storage.close();
    const reopened = await syncom.open({ path: dir, logger: false, encrypted: true });
    assert.deepStrictEqual(await reopened.get(id), { secret: 'mine' }, 'the replay leaves the sealed record alone');
    await reopened.close();
  });
});
