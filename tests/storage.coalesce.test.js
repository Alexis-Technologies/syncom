'use strict';

// Keystrokes sent without waiting for each, made at once (LOG-9), are logged
// as one op where each continues the one before it — typed at the end of the
// run it typed into, or a chain of cuts — while their group still gathers
// (src/commit.js coalesced, the text plugin's `coalesce`). The reading, a
// reopen and every peer read what the keystrokes made, one by one.

const test = require('node:test');
const assert = require('node:assert');
const { open } = require('../src/index.js');
const { text } = require('../src/text/text.js');
const { sync } = require('../src/sync/sync.js');
const { memory } = require('../src/memory/memory.js');
const { createMesh, settle, prng } = require('./utils/mesh.js');

const openMemory = (path, fsi = memory(), options = {}) =>
  open({ path, fsi, logger: false, lock: false, plugins: [text, sync], ...options });

test('keystrokes sent without waiting are one op while they continue each other: typed on, or cut back', async () => {
  const fsi = memory();
  const storage = await openMemory('/typed', fsi);
  const id = await storage.insert({ title: 'doc' });
  await storage.push(id, 'body', 'a');
  const heard = [];
  storage.on('change', (op, via, { changes }) => heard.push([op.type, changes.length]));
  let next = storage.log.next;
  let last = null;
  for (let i = 0; i < 50; i++) last = storage.splice(id, 'body', 1 + i, 0, 'x');
  await last;
  assert.strictEqual(storage.log.next - next, 1, 'fifty keystrokes, one op');
  assert.deepStrictEqual(heard, [['splice', 50]], 'announced once, with every keystroke’s change in order');
  next = storage.log.next;
  for (let i = 0; i < 10; i++) last = storage.splice(id, 'body', 50 - i, 1, '');
  await last;
  assert.strictEqual(storage.log.next - next, 1, 'ten cuts back, one op');
  assert.strictEqual((await storage.get(id)).body, `a${'x'.repeat(40)}`);
  // What breaks a run: an awaited keystroke, a jump, another field, another record.
  next = storage.log.next;
  await storage.splice(id, 'body', 41, 0, 'y');
  await storage.splice(id, 'body', 42, 0, 'y');
  last = storage.splice(id, 'body', 0, 0, 'z');
  storage.splice(id, 'body', 1, 0, 'z');
  storage.splice(id, 'title', 0, 0, 'q').catch(() => {});
  const other = await storage.insert({ title: 'other' });
  await last;
  storage.push(other, 'body', 'p');
  await storage.push(id, 'body', 'w');
  assert.strictEqual(storage.log.next - next, 6, 'two awaited, z and z one op, the other record twice, w alone');
  const expected = `zza${'x'.repeat(40)}yyw`;
  assert.strictEqual((await storage.get(id)).body, expected);
  await storage.close();
  const reopened = await openMemory('/typed', fsi);
  assert.strictEqual((await reopened.get(id)).body, expected, 'a reopen reads what was typed');
  await reopened.close();
});

test('two nodes typing in bursts at once converge, each keystroke logged as part of an op', async (t) => {
  const createStorage = (t2, name, options) => {
    const storage = openMemory(`/${name}`, memory(), options);
    t2.after(async () => (await storage).close().catch(() => {}));
    return storage;
  };
  const mesh = await createMesh(t, ['A', 'B'], [['A', 'B']], createStorage);
  const a = mesh.get('A');
  const b = mesh.get('B');
  const id = await a.insert({ title: 'doc' });
  await a.push(id, 'body', 'start ');
  await settle([a, b]);
  const random = prng(11);
  const pick = (n) => Math.floor(random() * n);
  let keystrokes = 0;
  // A peer's cut may land between a read and the keystrokes made from it:
  // a keystroke past the end then is nothing, as an editor would drop it.
  const typed = (write) =>
    write.catch((error) => {
      if (error.code !== 'OUT_OF_RANGE') throw error;
    });
  for (let round = 0; round < 40; round++) {
    const writes = [];
    for (const node of [a, b]) {
      const length = (await node.get(id)).body.length;
      let at = pick(length + 1);
      const typing = pick(3) > 0;
      const burst = 1 + pick(8);
      for (let i = 0; i < burst; i++) {
        if (typing) writes.push(typed(node.splice(id, 'body', at++, 0, 'xyz'[pick(3)])));
        else if (at > 0) writes.push(typed(node.splice(id, 'body', --at, 1, '')));
        keystrokes++;
      }
    }
    await Promise.all(writes);
    if (round % 5 === 4) await settle([a, b]);
  }
  await settle([a, b]);
  const left = (await a.get(id)).body;
  assert.strictEqual((await b.get(id)).body, left, 'one text on both nodes');
  assert.ok(a.log.next < keystrokes, `fewer ops than keystrokes logged (${a.log.next} for ${keystrokes})`);
});
