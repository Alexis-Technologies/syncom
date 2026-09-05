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
  });

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
    await assert.rejects(() => storage.update(gone, { n: 4 }), /not found/);
  });

  await t.test('applyRemote: in order per origin, duplicates and gaps skipped', async (t2) => {
    const { storage } = await openTemp(t2);
    const changes = [];
    storage.on('change', (op, via) => changes.push({ op, via }));

    const first = await storage.applyRemote([remoteOp('peer', 1, 'write', 'r1', { data: { a: 1 } })], { via: 'L' });
    assert.deepStrictEqual(first, { applied: 1, duplicates: 0, gaps: 0 });
    assert.deepStrictEqual(await storage.get('r1'), { a: 1 });
    assert.deepStrictEqual(changes[0].via, 'L');
    assert.strictEqual(changes[0].op.origin, 'peer');

    const again = await storage.applyRemote([
      remoteOp('peer', 1, 'write', 'r1', { data: { a: 1 } }),
      remoteOp('peer', 3, 'set', 'r1', { data: { b: 1 } }),
      { origin: storage.nodeId, seq: 1, ts: 1, type: 'write', id: 'x', data: {} },
      'garbage',
    ]);
    assert.deepStrictEqual(again, { applied: 0, duplicates: 2, gaps: 1 });
    assert.deepStrictEqual(await storage.get('r1'), { a: 1 });

    const next = await storage.applyRemote([
      remoteOp('peer', 2, 'set', 'r1', { data: { b: 2 } }),
      remoteOp('peer', 3, 'inc', 'r1', { key: 'n', value: 4 }),
      remoteOp('peer', 4, 'delete', 'r1'),
    ]);
    assert.deepStrictEqual(next, { applied: 3, duplicates: 0, gaps: 0 });
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

  await t.test('identity, seq and vector survive a reopen; the log tail is replayed', async (t2) => {
    const dir = await createTemp();
    t2.after(() => cleanupTemp(dir));
    const first = await syncom.open({ path: dir, logger: false });
    const id = await first.insert({ n: 1 });
    await first.applyRemote([remoteOp('peer', 1, 'write', 'r', { data: { p: 1 } })]);
    const { nodeId } = first;
    await first.close();
    await assert.rejects(() => first.insert({ n: 2 }), /closed/);

    // Crash between "logged" and "written": the record file is gone.
    await fs.rm(path.join(dir, 'data', `${id}.json`));

    const second = await syncom.open({ path: dir, logger: false });
    assert.strictEqual(second.nodeId, nodeId);
    assert.deepStrictEqual(second.vector, { [nodeId]: 1, peer: 1 });
    assert.deepStrictEqual(await second.get(id), { n: 1 }, 'replayed from the log');
    const ops = [];
    second.on('change', (op) => ops.push(op));
    await second.insert({ n: 3 });
    assert.strictEqual(ops[0].seq, 2, 'the own seq continues, never repeats');
    assert.strictEqual(await second.validate(), true);
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

test('Storage: events are contained', async (t) => {
  const collect = () => {
    const entries = [];
    return { entries, logger: { debug: (entry) => entries.push(entry), info() {}, warn() {}, error() {} } };
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
