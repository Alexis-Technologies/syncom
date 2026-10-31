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

test('a handle’s applyDelta is the storage’s: embeds, their markers and marks, an insert plain unless it says', async () => {
  const storage = await openMemory('/delta');
  const a = await storage.insert({ title: 'a' });
  const b = await storage.insert({ title: 'b' });
  const paragraph = { type: 'paragraph', parents: [], attrs: {}, isEmbed: false };
  const steps = [
    [
      { insert: 'Hi ' },
      { insert: 'there', attributes: { bold: true } },
      { insert: { embed: paragraph } },
      { insert: { embed: { type: 'img', attrs: { src: 'x' } } }, attributes: { em: true } },
      { insert: 'end' },
    ],
    // Typed inside the bold word with no attributes: plain, as a delta says it.
    [{ retain: 5 }, { insert: '!' }],
    [{ retain: 9 }, { retain: 1, attributes: { embed: { type: 'heading', attrs: { level: 2 } } } }],
    [{ retain: 1 }, { delete: 2 }, { retain: 2, attributes: { bold: null } }],
  ];
  const handle = await storage.openText(b, 'body', { window: 60_000 });
  for (const delta of steps) {
    await storage.applyDelta(a, 'body', delta);
    handle.applyDelta(delta);
  }
  const expected = await storage.spans(a, 'body');
  assert.deepStrictEqual(handle.spans(), expected, 'the handle reads as the storage would');
  assert.deepStrictEqual(
    expected.slice(0, 2),
    [
      { type: 'text', text: 'Hth!', marks: {} },
      { type: 'text', text: 'ere', marks: { bold: true } },
    ],
    'the letter typed inside the bold word plain',
  );
  await handle.flush();
  assert.deepStrictEqual(await storage.spans(b, 'body'), expected, 'and is logged so');
  assert.throws(() => handle.applyDelta([{ insert: 7 }]), TypeError);
  await handle.close();
  await storage.close();
});

test('several writers of one node on one text never grow one run from two readings: nothing typed is lost', async () => {
  const storage = await openMemory('/writers');
  const id = await storage.insert({ title: 'doc' });
  await storage.push(id, 'body', 'start');
  const one = await storage.openText(id, 'body', { window: 60_000 });
  const two = await storage.openText(id, 'body', { window: 60_000 });
  // Each types at the end of the same run, over its own reading, and the storage too.
  one.insert(5, 'abc');
  two.insert(5, 'xyz');
  const direct = storage.splice(id, 'body', 5, 0, '123');
  one.insert(8, 'de');
  two.insert(8, 'uv');
  await direct;
  await one.flush();
  await two.flush();
  const text = (await storage.get(id)).body;
  for (const word of ['abcde', 'xyzuv', '123']) assert.ok(text.includes(word), `${word} whole in ${text}`);
  assert.strictEqual(text.length, 'start'.length + 13, 'every character');
  assert.deepStrictEqual([one.toString(), two.toString()], [text, text], 'each handle reads the field');
  await one.close();
  await two.close();
  // The last handle closed, the storage is the one writer: it grows its runs again.
  const next = storage.log.next;
  await storage.splice(id, 'body', text.length, 0, '!');
  await storage.splice(id, 'body', text.length + 1, 0, '?');
  assert.strictEqual(storage.log.next - next, 2);
  await storage.close();
});

test('a handle logs its edits a window after them: a timer of the storage’s defer, a throwing observer contained', async () => {
  const warnings = [];
  const logger = { warn: (entry) => warnings.push(entry.event), error: () => {}, info: () => {}, debug: () => {} };
  const storage = await openMemory('/window', memory(), { defer: 5, logger });
  const id = await storage.insert({ title: 'doc' });
  await assert.rejects(storage.openText(id, 'body', { window: -1 }), TypeError);
  const handle = await storage.openText(id, 'body');
  handle.observe(() => {
    throw new Error('an observer that throws');
  });
  const next = storage.log.next;
  handle.insert(0, 'a');
  handle.insert(1, 'b');
  assert.strictEqual(storage.log.next, next, 'nothing logged at once');
  await handle.flushed;
  assert.strictEqual(storage.log.next - next, 1, 'the window’s two keystrokes, one op, logged by the timer');
  assert.strictEqual((await storage.get(id)).body, 'ab');
  assert.ok(warnings.includes('listener.error'), 'the observer’s throw is a warning, not the edit’s');
  await handle.close();
  await storage.close();
});

test('a handle’s edits of a validated record are validated as the flush logs them: one refused, nothing logged', async () => {
  const { schema } = require('../src/schema/schema.js');
  // A note's body is at most ten characters.
  const Note = (value) => {
    if (value.body === undefined || value.body.length <= 10) return true;
    Note.errors = [{ instancePath: '/body', message: 'too long', keyword: 'maxLength' }];
    return false;
  };
  const storage = await openMemory('/validated', memory(), {
    plugins: [text, sync, schema],
    schema: { entities: { Note: { schema: Note } } },
  });
  const note = await storage.Note.insert({ title: 'n' });
  const handle = await storage.openText(note.id, 'body', { window: 60_000 });
  handle.insert(0, 'short');
  await handle.flush();
  assert.strictEqual((await storage.get(note.id)).body, 'short', 'validated, and logged');
  const next = storage.log.next;
  handle.insert(5, ' and far too long');
  await assert.rejects(handle.flush(), (error) => error.code === 'UNLOGGED' && error.cause.name === 'ValidationError');
  assert.strictEqual(storage.log.next, next, 'nothing logged');
  assert.strictEqual(handle.toString(), 'short');
  await handle.close();
  await storage.close();
});
