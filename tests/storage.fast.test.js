'use strict';

// A write made at once (Storage#fastCommit, src/commit.js commitAtOnce): on
// an idle queue, for a live record the storage holds, with nothing
// asynchronous configured, a write is made, applied and appended before the
// call returns, and lands and is announced as its group is written. It is
// the same write as one through the queue — the same op, the same order,
// the same errors — which is what these tests hold.

const test = require('node:test');
const assert = require('node:assert');
const { open } = require('../src/index.js');
const { text } = require('../src/text/text.js');
const { memory } = require('../src/memory/memory.js');

const openMemory = async (t, options = {}) => {
  const storage = await open({ path: '/fast', fsi: memory(), logger: false, lock: false, plugins: [text], ...options });
  t.after(() => storage.close().catch(() => {}));
  return storage;
};

// A seeded generator: the same workload every run.
const lcg = (seed) => () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 2 ** 32;
};

test('a write made at once is appended before the call returns and announced before it resolves; a refused one is a rejection that appends nothing', async (t) => {
  const storage = await openMemory(t);
  const id = await storage.insert({ title: 'doc' });
  await storage.push(id, 'body', 'ab');
  const heard = [];
  storage.on('change', (op) => heard.push(op.type));
  const next = storage.log.next;
  const pending = storage.splice(id, 'body', 1, 0, 'x');
  assert.ok(pending instanceof Promise);
  assert.strictEqual(storage.log.next, next + 1, 'the seq is taken at once: the write did not wait for the queue');
  assert.deepStrictEqual(heard, [], 'announced once its group is written, not before');
  assert.strictEqual(await pending, undefined);
  assert.deepStrictEqual(heard, ['splice']);
  assert.deepStrictEqual(await storage.get(id), { title: 'doc', body: 'axb' });
  // Refused: a rejection, never a throw, and nothing minted.
  const outOfRange = storage.splice(id, 'body', 99, 0, 'y');
  assert.ok(outOfRange instanceof Promise);
  await assert.rejects(outOfRange, { code: 'OUT_OF_RANGE' });
  await assert.rejects(storage.splice(id, 'body', 0, 0, 42), TypeError);
  await assert.rejects(storage.inc(id, 'title', 1), { code: 'FIELD_KIND' });
  await assert.rejects(storage.setAt(id, 'body', -1, 'z'), TypeError);
  assert.strictEqual(storage.log.next, next + 1, 'nothing appended for any of them');
  assert.deepStrictEqual(heard, ['splice']);
});

test('a write behind an unfinished landing goes through the queue and lands after it', async (t) => {
  const base = memory();
  const gate = { held: null, entered: false };
  // The record files wait at the gate while it is held; the log's journal does not.
  const fsi = {
    ...base,
    write: async (dir, name, content) => {
      if (gate.held !== null && dir.endsWith('/data')) {
        gate.entered = true;
        await gate.held;
      }
      return base.write(dir, name, content);
    },
  };
  const storage = await open({ path: '/gated', fsi, logger: false, lock: false, plugins: [text], defer: 5 });
  t.after(() => storage.close().catch(() => {}));
  const id = await storage.insert({ title: 'doc' });
  let release = null;
  gate.held = new Promise((resolve) => (release = resolve));
  await storage.push(id, 'body', 'a');
  // The window's timer lands the deferred file as a step of the landings —
  // held at the gate, the queue idle.
  while (!gate.entered) await new Promise((resolve) => setTimeout(resolve, 1));
  const heard = [];
  storage.on('change', (op) => heard.push(op.value.content));
  const next = storage.log.next;
  let behind = null;
  try {
    behind = storage.push(id, 'body', 'b');
    assert.strictEqual(storage.log.next, next, 'behind a landing step, the write waits for its turn of the queue');
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepStrictEqual(heard, [], 'and is not announced while the landing ahead of it is unfinished');
  } finally {
    // Whatever was asserted, the landing goes on: nothing is left waiting at the gate.
    gate.held = null;
    release();
  }
  await behind;
  assert.deepStrictEqual(heard, ['b']);
  assert.deepStrictEqual(await storage.get(id), { title: 'doc', body: 'ab' });
});

test('flush() and close() wait for the writes made at once', async () => {
  const fsi = memory();
  const options = { path: '/kept', fsi, logger: false, lock: false, plugins: [text] };
  let storage = await open(options);
  const id = await storage.insert({ title: 'doc' });
  await storage.update(id, { title: 'kept' });
  // Not awaited: the calls return at once, their landings follow.
  storage.inc(id, 'hits', 1);
  storage.inc(id, 'hits', 2);
  storage.push(id, 'body', 'abc');
  await storage.flush();
  assert.deepStrictEqual(await storage.get(id), { title: 'kept', hits: 3, body: 'abc' });
  storage.push(id, 'body', 'd');
  await storage.close();
  storage = await open(options);
  assert.deepStrictEqual(await storage.get(id), { title: 'kept', hits: 3, body: 'abcd' }, 'what was written reopens');
  await storage.close();
});

test('a seeded workload made at once reads, logs and announces as the same workload through the queue', async () => {
  // An afterWrite hook keeps every write in the queue: the same ops, the other path.
  const run = async (hooks) => {
    const storage = await open({ path: '/same', fsi: memory(), logger: false, lock: false, plugins: [text], hooks });
    const changes = [];
    storage.on('change', (op, via, { changes: of }) => changes.push(JSON.stringify(of)));
    const id = await storage.insert({ title: 'doc', done: false });
    await storage.push(id, 'items', [0, 1, 2]);
    const random = lcg(42);
    const pick = (n) => Math.floor(random() * n);
    let body = 0;
    let items = 3;
    for (let round = 0; round < 60; round++) {
      // A burst, some of it awaited, some pipelined behind it.
      const writes = [];
      const burst = 1 + pick(6);
      for (let i = 0; i < burst; i++) {
        const kind = pick(8);
        let write;
        if (kind < 3 || body === 0) {
          write = storage.splice(id, 'body', pick(body + 1), 0, 'xy'[pick(2)]);
          body++;
        } else if (kind === 3) {
          write = storage.splice(id, 'body', pick(body), 1, '');
          body--;
        } else if (kind === 4) write = storage.inc(id, 'hits', 1 + pick(3));
        else if (kind === 5) write = storage.update(id, { done: pick(2) === 0, round });
        else if (kind === 6) write = storage.setAt(id, 'items', pick(items), round);
        else {
          write = storage.push(id, 'items', [round]);
          items++;
        }
        if (pick(2) === 0) await write;
        else writes.push(write);
      }
      await Promise.all(writes);
    }
    await storage.flush();
    const result = { data: await storage.get(id), changes, logged: storage.log.next };
    await storage.close();
    return result;
  };
  const atOnce = await run(undefined);
  const queued = await run({ afterWrite: () => {} });
  assert.deepStrictEqual(atOnce.data, queued.data);
  assert.strictEqual(atOnce.logged, queued.logged, 'the same number of ops logged');
  assert.deepStrictEqual(atOnce.changes, queued.changes, 'every change announced the same, in the same order');
});
