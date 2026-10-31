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
const { PREPEND_MAX } = require('../src/text/kind.js');

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

test('a word typed backward through a handle is one op: each keystroke grows the edit before it at its start', async () => {
  const fsi = memory();
  const storage = await openMemory('/backward', fsi);
  const id = await storage.insert({ title: 'doc' });
  const handle = await storage.openText(id, 'body', { window: 60_000 });
  const heard = [];
  handle.observe((delta) => heard.push(delta));
  const logged = [];
  storage.on('change', (op) => logged.push(op.value));
  let next = storage.log.next;
  for (const ch of 'olleh') handle.insert(0, ch);
  assert.strictEqual(handle.toString(), 'hello');
  assert.deepStrictEqual(heard, [
    [{ insert: 'o' }],
    [{ insert: 'l' }],
    [{ insert: 'l' }],
    [{ insert: 'e' }],
    [{ insert: 'h' }],
  ]);
  await handle.flush();
  assert.strictEqual(storage.log.next - next, 1, 'one op');
  assert.deepStrictEqual(logged, [{ content: 'hello', at: '^' }]);
  assert.strictEqual((await storage.get(id)).body, 'hello');
  // Backward inside the text, after the edit before it typed on: one op, the run's next offset with it.
  next = storage.log.next;
  handle.insert(2, 'a');
  handle.insert(3, 'b');
  handle.insert(2, 'z');
  handle.insert(5, 'c');
  assert.strictEqual(handle.toString(), 'hezabcllo');
  await handle.flush();
  assert.strictEqual(storage.log.next - next, 1, 'typed on, backward, typed on: one op');
  // Another writer's turn between two keystrokes: the second an op of its own.
  next = storage.log.next;
  handle.insert(0, '2');
  await storage.update(id, { title: 'renamed' });
  handle.insert(0, '1');
  // At most PREPEND_MAX slots an op.
  for (let i = 0; i < PREPEND_MAX + 10; i++) handle.insert(0, '.');
  await handle.flush();
  // The update; `2` alone; `1` and the dots typed before it, PREPEND_MAX slots an op (3 ops had `2` grown).
  assert.strictEqual(storage.log.next - next, 1 + 1 + 2);
  const text = (await storage.get(id)).body;
  assert.strictEqual(text, `${'.'.repeat(PREPEND_MAX + 10)}12hezabcllo`);
  assert.strictEqual(handle.toString(), text);
  await handle.close();
  await storage.close();
  const reopened = await openMemory('/backward', fsi);
  assert.strictEqual((await reopened.get(id)).body, text);
  await reopened.close();
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

test('a keystroke typed backward after another writer’s turn is an op of its own: nothing of that turn is lost', async () => {
  const storage = await openMemory('/prepend-turn');
  const id = await storage.insert({ title: 'doc' });
  await storage.splice(id, 'body', 0, 0, 'XY');
  const handle = await storage.openText(id, 'body', { window: 60_000 });
  handle.insert(1, 'c');
  // Another writer's turn reaches the overlay between the keystrokes.
  await storage.splice(id, 'body', 0, 0, 'P');
  assert.strictEqual(handle.toString(), 'PXcY');
  // Typed on (grown into the pending edit), then typed right before it: no prepend — a turn came since.
  handle.insert(3, 'd');
  handle.insert(2, 'b');
  assert.strictEqual(handle.toString(), 'PXbcdY', 'the other writer’s P is kept');
  await handle.flush();
  assert.strictEqual((await storage.get(id)).body, 'PXbcdY');
  // What the handle shows is what the storage holds: a delete lands where the editor meant it.
  handle.delete(0, 1);
  await handle.flush();
  assert.strictEqual((await storage.get(id)).body, 'XbcdY');
  assert.strictEqual(handle.toString(), 'XbcdY');
  await handle.close();
  await storage.close();
});

test('a flush taken behind one that cannot be logged is dropped with it: nothing anchored in the dropped edits is logged', async () => {
  let gate = null;
  let failOnce = false;
  const hooks = {
    beforeWrite: async () => {
      if (gate === null) return;
      await gate;
      if (failOnce) {
        failOnce = false;
        throw new Error('not now');
      }
    },
  };
  const storage = await openMemory('/queued', memory(), { hooks });
  const id = await storage.insert({ title: 'doc' });
  await storage.push(id, 'body', 'hello');
  const handle = await storage.openText(id, 'body', { window: 60_000 });
  const heard = [];
  handle.observe((delta, event) => heard.push(event.reset === true ? 'reset' : delta));
  let release;
  gate = new Promise((resolve) => (release = resolve));
  failOnce = true;
  handle.insert(5, 'X');
  const first = handle.flush();
  // Typed while the first flush waits on the hook: the second flush is taken behind it.
  handle.insert(6, 'Y');
  const second = handle.flush();
  const next = storage.log.next;
  release();
  await assert.rejects(first, (error) => error.code === 'UNLOGGED' && error.edits === 2);
  await assert.rejects(second, (error) => error.code === 'UNLOGGED' && error.edits === 2);
  assert.strictEqual(storage.log.next, next, 'nothing of either flush is logged');
  assert.strictEqual(handle.toString(), 'hello');
  assert.strictEqual((await storage.get(id)).body, 'hello');
  assert.strictEqual(heard[heard.length - 1], 'reset');
  gate = null;
  handle.insert(5, '!');
  await handle.flush();
  assert.strictEqual((await storage.get(id)).body, 'hello!', 'the handle goes on');
  await handle.close();
  await storage.close();
});

test('flushed read while a failing flush is out rejects with its UNLOGGED, and with nothing pending it follows the flush in flight', async () => {
  let gate = null;
  const hooks = {
    beforeWrite: async () => {
      if (gate === null) return;
      await gate;
      throw new Error('not now');
    },
  };
  const storage = await openMemory('/waiting', memory(), { hooks });
  const id = await storage.insert({ title: 'doc' });
  await storage.push(id, 'body', 'kept');
  const handle = await storage.openText(id, 'body', { window: 60_000 });
  handle.on('error', () => {});
  let release;
  gate = new Promise((resolve) => (release = resolve));
  handle.insert(4, 'A');
  const flush = handle.flush();
  const inFlight = handle.flushed;
  handle.insert(5, 'B');
  const behind = handle.flushed;
  release();
  await assert.rejects(flush, { code: 'UNLOGGED' });
  await assert.rejects(inFlight, { code: 'UNLOGGED' });
  await assert.rejects(behind, { code: 'UNLOGGED' });
  assert.strictEqual(handle.pending, false);
  await handle.flushed;
  gate = null;
  await handle.close();
  await storage.close();
});

test('the storage flushes every handle: one whose edits cannot be logged stops none of the others — flush() and tag() refuse, close() says how many', async () => {
  const { versions } = require('../src/versions/versions.js');
  const hooks = {
    beforeWrite: (ctx) => {
      if (ctx.id === 'a' && ctx.type === 'splice') throw new Error('a is refused');
    },
  };
  const fsi = memory();
  const warnings = [];
  const logger = { warn: (entry) => warnings.push(entry), error: () => {}, info: () => {}, debug: () => {} };
  const storage = await openMemory('/every', fsi, { hooks, logger, plugins: [text, sync, versions] });
  await storage.set('a', { title: 'a' });
  await storage.set('b', { title: 'b' });
  const ha = await storage.openText('a', 'body', { window: 60_000 });
  const hb = await storage.openText('b', 'body', { window: 60_000 });
  ha.insert(0, 'A');
  hb.insert(0, 'B');
  await assert.rejects(
    storage.flush(),
    (error) => error.code === 'UNLOGGED' && error.handles === 1 && error.edits === 1,
  );
  assert.strictEqual(hb.pending, false, 'B is logged all the same');
  assert.ok(
    warnings.some((entry) => entry.event === 'handle.unlogged' && entry.id === 'a'),
    'said, with nobody listening',
  );
  ha.insert(0, 'A');
  hb.insert(1, 'C');
  await assert.rejects(storage.tag('t'), { code: 'UNLOGGED' });
  assert.deepStrictEqual(await storage.tags(), [], 'no tag with a part of the edits');
  assert.strictEqual(hb.pending, false);
  ha.insert(0, 'A');
  await storage.close();
  const closed = warnings.find((entry) => entry.event === 'edits.unlogged');
  assert.deepStrictEqual([closed.handles, closed.edits], [1, 1]);
  const reopened = await openMemory('/every', fsi, { plugins: [text, sync, versions] });
  assert.strictEqual((await reopened.get('b')).body, 'BC');
  assert.strictEqual((await reopened.get('a')).body, undefined);
  await reopened.close();
});

test('an afterWrite hook that throws after the append leaves the edits logged: the handle keeps them and the flush rejects with the hook’s error, not UNLOGGED', async () => {
  let throwOnce = false;
  const hooks = {
    afterWrite: () => {
      if (!throwOnce) return;
      throwOnce = false;
      throw new Error('after the append');
    },
  };
  const storage = await openMemory('/after', memory(), { hooks });
  const id = await storage.insert({ title: 'doc' });
  const handle = await storage.openText(id, 'body', { window: 60_000 });
  const heard = [];
  handle.observe((delta, event) => heard.push(event.reset === true ? 'reset' : delta));
  throwOnce = true;
  handle.insert(0, 'hello');
  await assert.rejects(handle.flush(), { code: 'HOOK_FAILED' });
  assert.strictEqual((await storage.get(id)).body, 'hello', 'logged');
  assert.strictEqual(handle.toString(), 'hello', 'kept');
  assert.ok(!heard.includes('reset'), 'nothing to read again');
  handle.insert(5, '!');
  await handle.flush();
  assert.strictEqual((await storage.get(id)).body, 'hello!');
  await handle.close();
  await storage.close();
});

test('an edit made while close() awaits its flush is refused: CLOSED', async () => {
  const storage = await openMemory('/closing');
  const id = await storage.insert({ title: 'doc' });
  const handle = await storage.openText(id, 'body', { window: 60_000 });
  handle.insert(0, 'ab');
  const closing = handle.close();
  assert.throws(() => handle.insert(2, 'c'), { code: 'CLOSED' });
  await closing;
  assert.strictEqual((await storage.get(id)).body, 'ab');
  await storage.close();
});

test('handles follow the storage through one listener: as many as the application opens, past maxListeners', async () => {
  const storage = await openMemory('/many');
  const id = await storage.insert({ title: 'doc' });
  await storage.push(id, 'body', 'x');
  const listeners = storage.listenerCount('transaction');
  const handles = [];
  for (let i = 0; i < 150; i++) handles.push(await storage.openText(id, 'body', { window: 60_000 }));
  assert.strictEqual(storage.listenerCount('transaction'), listeners + 1, 'one listener for them all');
  await storage.splice(id, 'body', 1, 0, 'y');
  for (const handle of handles) assert.strictEqual(handle.toString(), 'xy');
  for (const handle of handles) await handle.close();
  assert.strictEqual(storage.listenerCount('transaction'), listeners, 'taken off with the last');
  await storage.close();
});

test('a field’s reservations go with its last handle: the storage grows the field’s runs again while a handle on another field stays open', async () => {
  let refuse = false;
  const hooks = {
    beforeWrite: (ctx) => {
      if (refuse && ctx.key === 'body') throw new Error('not now');
    },
  };
  const storage = await openMemory('/fields', memory(), { hooks });
  const id = await storage.insert({ title: 'doc' });
  await storage.push(id, 'body', 'start');
  await storage.push(id, 'notes', 'n');
  const body = await storage.openText(id, 'body', { window: 60_000 });
  const notes = await storage.openText(id, 'notes', { window: 60_000 });
  body.on('error', () => {});
  // The body handle reserves the run's next offset for a keystroke that is then refused: a stale reservation.
  body.insert(5, 'a');
  refuse = true;
  await assert.rejects(body.close(), { code: 'UNLOGGED' });
  refuse = false;
  const ops = [];
  storage.on('change', (op) => ops.push(op.value));
  // The notes handle still open, the storage writes at the body run's end: the run grows (`run`), no run of its
  // own (`at`) against a reservation the field no longer has.
  await storage.splice(id, 'body', 5, 0, 'b');
  assert.ok(ops[0].run !== undefined, `the run grown: ${JSON.stringify(ops[0])}`);
  notes.insert(1, 'o');
  await notes.close();
  assert.strictEqual((await storage.get(id)).notes, 'no');
  await storage.close();
});
