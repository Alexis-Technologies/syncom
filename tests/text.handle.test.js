'use strict';

// A synchronous editor's handle (`storage.openText`, src/text/handle.js):
// edits made and read at once over the handle's own reading, logged a
// window later as one transaction — keystrokes that continue each other as
// one op — and another writer's ops reaching it as deltas in its indices.

const test = require('node:test');
const assert = require('node:assert');
const { open } = require('../src/index.js');
const { text } = require('../src/text/text.js');
const { sync } = require('../src/sync/sync.js');
const { memory } = require('../src/memory/memory.js');
const { createMesh, settle } = require('./utils/mesh.js');

const openMemory = (path, fsi = memory(), options = {}) =>
  open({ path, fsi, logger: false, lock: false, plugins: [text, sync], ...options });

test('a handle’s edit applies to its reading at once, or throws and changes nothing; logged as one op when flushed', async () => {
  const fsi = memory();
  const storage = await openMemory('/handle', fsi);
  const id = await storage.insert({ title: 'doc' });
  const handle = await storage.openText(id, 'body', { window: 1000 });
  const heard = [];
  handle.observe((delta, event) => heard.push([delta, event.local]));
  const next = storage.log.next;
  for (let i = 0; i < 20; i++) handle.insert(i, 'abcdefghijklmnopqrst'[i]);
  handle.delete(0, 2);
  handle.format(0, 3, { bold: true });
  assert.strictEqual(handle.toString(), 'cdefghijklmnopqrst', 'read at once');
  assert.strictEqual(handle.length, 18);
  assert.strictEqual(handle.slice(0, 3), 'cde');
  assert.ok(handle.pending);
  assert.strictEqual(heard.length, 22, 'every edit told, as it is made');
  assert.deepStrictEqual(heard[0], [[{ insert: 'a' }], true]);
  // Refused at once: nothing changed, nothing to log.
  assert.throws(() => handle.insert(99, 'x'), { code: 'OUT_OF_RANGE' });
  assert.throws(() => handle.delete(0, 99), { code: 'OUT_OF_RANGE' });
  assert.throws(() => handle.insert(0, 42), TypeError);
  await assert.rejects(
    storage.transact((tx) => tx.openText(id, 'body')),
    TypeError,
  );
  await assert.rejects(storage.openText(id, 'title'), { code: 'FIELD_KIND' }, 'a register is no text');
  assert.strictEqual(handle.toString(), 'cdefghijklmnopqrst');
  assert.strictEqual(storage.log.next, next, 'nothing logged before the flush');
  assert.strictEqual((await storage.get(id)).body, undefined, 'and nothing read through the storage');
  await handle.flush();
  assert.strictEqual(handle.pending, false);
  assert.strictEqual(storage.log.next - next, 3, 'the twenty keystrokes one op, the cuts one, the mark one');
  assert.strictEqual((await storage.get(id)).body, 'cdefghijklmnopqrst');
  const [first] = await storage.spans(id, 'body');
  assert.deepStrictEqual(first, { type: 'text', text: 'cde', marks: { bold: true } });
  // Closing the storage flushes what an open handle holds.
  handle.insert(18, '!');
  await storage.close();
  const reopened = await openMemory('/handle', fsi);
  assert.strictEqual((await reopened.get(id)).body, 'cdefghijklmnopqrst!');
  await reopened.close();
});

test('a handle’s edits reach no peer before they are logged; another writer’s ops reach it as deltas in its indices', async (t) => {
  const createStorage = (t2, name, options) => {
    const storage = openMemory(`/${name}`, memory(), options);
    t2.after(async () => (await storage).close().catch(() => {}));
    return storage;
  };
  const mesh = await createMesh(t, ['A', 'B'], [['A', 'B']], createStorage);
  const a = mesh.get('A');
  const b = mesh.get('B');
  const id = await a.insert({ title: 'doc' });
  await a.push(id, 'body', 'middle');
  await settle([a, b]);
  const handle = await a.openText(id, 'body', { window: 60_000 });
  const heard = [];
  handle.observe((delta, event) => heard.push([delta, event.local]));
  handle.insert(0, '>>');
  // B writes at its end while A's keystrokes wait: B never sees them…
  await b.push(id, 'body', '!');
  await settle([a, b]);
  assert.strictEqual((await b.get(id)).body, 'middle!', 'nothing of the handle’s before its flush');
  // …and A's handle takes B's op, in its own indices: after '>>middle'.
  assert.strictEqual(handle.toString(), '>>middle!');
  assert.deepStrictEqual(heard[heard.length - 1], [[{ retain: 8 }, { insert: '!' }], false]);
  await handle.flush();
  await settle([a, b]);
  assert.strictEqual((await b.get(id)).body, '>>middle!', 'logged, it replicates');
  assert.strictEqual((await a.get(id)).body, '>>middle!');
  // A flush() of the storage flushes the handle too.
  handle.insert(9, '?');
  await a.flush();
  assert.strictEqual(handle.pending, false);
  await handle.close();
  assert.throws(() => handle.insert(0, 'x'), { code: 'CLOSED' });
});

test('a flush that cannot be logged drops what was not logged: UNLOGGED, the reading as announced, a reset told', async () => {
  let refuse = false;
  const hooks = {
    beforeWrite: (ctx) => {
      if (refuse && ctx.type === 'splice') throw new Error('not now');
    },
  };
  const storage = await openMemory('/refused', memory(), { hooks });
  const id = await storage.insert({ title: 'doc' });
  await storage.push(id, 'body', 'kept');
  const handle = await storage.openText(id, 'body', { window: 60_000 });
  const heard = [];
  handle.observe((delta, event) => heard.push(event.reset === true ? 'reset' : delta));
  const errors = [];
  handle.on('error', (error) => errors.push(error.code));
  refuse = true;
  handle.insert(4, ' and lost');
  const next = storage.log.next;
  const flushed = handle.flushed;
  await assert.rejects(handle.flush(), (error) => {
    assert.strictEqual(error.code, 'UNLOGGED');
    assert.strictEqual(error.edits, 1);
    assert.strictEqual(error.cause.code, 'HOOK_FAILED');
    return true;
  });
  await assert.rejects(flushed, { code: 'UNLOGGED' });
  assert.deepStrictEqual(errors, ['UNLOGGED']);
  assert.strictEqual(heard[heard.length - 1], 'reset');
  assert.strictEqual(handle.toString(), 'kept', 'the field as the storage holds it');
  assert.strictEqual(storage.log.next, next, 'nothing appended');
  refuse = false;
  handle.insert(4, '!');
  await handle.flush();
  assert.strictEqual((await storage.get(id)).body, 'kept!');
  await handle.close();
  await storage.close();
});
