'use strict';

// The write path after the append: the queue is free once an op's seq is
// reserved — the disk, the file, the hooks and the listeners come in log
// order outside it — writes that queue behind one another go to the log as
// one file, a write builds on the one in flight before it, a failed group
// takes its writes back whole, and what the caller awaits is the landing.

const test = require('node:test');
const assert = require('node:assert');
const syncom = require('../src/all/all.js');
const { memory } = require('../src/memory/memory.js');

const open = async (t, options = {}) => {
  const storage = await syncom.open({ path: '/group', fsi: memory(), logger: false, ...options });
  t.after(() => storage.close().catch(() => {}));
  return storage;
};

// A backend whose writes wait for `release()`: what is in flight stays so
// until the test says.
const gated = (inner) => {
  let gate = null;
  return {
    fsi: {
      ...inner,
      async write(...args) {
        if (gate !== null) await gate.promise;
        return inner.write(...args);
      },
    },
    hold() {
      gate = {};
      gate.promise = new Promise((resolve) => {
        gate.release = resolve;
      });
    },
    release() {
      const held = gate;
      gate = null;
      held?.release();
    },
  };
};

test('a group commit on the storage', async (t) => {
  await t.test('writes queued behind one another land as one log file each group, in order', async (t2) => {
    const storage = await open(t2, { defer: 0 });
    const id = await storage.insert({ n: 0 });
    const files = () => storage.log.length;
    const before = files();
    // Issued together: the queue runs them one after another, their appends
    // join the groups a write in flight leaves behind.
    const writes = [];
    for (let i = 1; i <= 20; i++) writes.push(storage.update(id, { n: i }));
    await Promise.all(writes);
    assert.strictEqual(files() - before, 20, 'every op is in the log');
    const opened = (await storage.fsi.list('/group/log/open')).length;
    assert.ok(opened < 20, `fewer open files than ops: ${opened}`);
    assert.deepStrictEqual(await storage.get(id), { n: 20 });
    const seqs = storage.log.since(undefined).map((entry) => entry.op.seq);
    assert.deepStrictEqual(
      seqs,
      [...seqs].sort((a, b) => a - b),
      'in order',
    );
    assert.strictEqual(storage.stats().inflight, 0);
  });

  await t.test(
    'the queue is free at the append: the next write builds on the one in flight, a read waits for the disk',
    async (t2) => {
      const backend = gated(memory());
      const storage = await syncom.open({ path: '/g', fsi: backend.fsi, logger: false, defer: 0 });
      t2.after(() => {
        backend.release();
        return storage.close().catch(() => {});
      });
      const id = await storage.insert({ title: 'a' });
      backend.hold();
      const first = storage.push(id, 'body', 'x');
      const second = storage.push(id, 'body', 'y');
      // Both are past the queue: appended, in flight, not on disk.
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.strictEqual(storage.stats().queue, 0, 'the queue is empty while the disk is waited for');
      assert.strictEqual(storage.stats().inflight, 2);
      assert.deepStrictEqual(await storage.get(id), { title: 'a' }, 'a read sees what is durable');
      backend.release();
      await Promise.all([first, second]);
      assert.strictEqual(storage.stats().inflight, 0);
      assert.deepStrictEqual(await storage.get(id), { title: 'a', body: 'xy' }, 'the second built on the first');
    },
  );

  await t.test(
    'a group that does not reach the disk fails its writes whole; the next write starts over',
    async (t2) => {
      const inner = memory();
      let failing = false;
      // The log's open files fail, as a journal's append or a file per group.
      const fsi = {
        ...inner,
        write: (dir, name, text) =>
          failing && dir.endsWith('/log/open') ? Promise.reject(new Error('disk full')) : inner.write(dir, name, text),
        append: (dir, name, text) =>
          failing && dir.endsWith('/log/open') ? Promise.reject(new Error('disk full')) : inner.append(dir, name, text),
      };
      const storage = await syncom.open({ path: '/f', fsi, logger: false, defer: 0 });
      t2.after(() => storage.close().catch(() => {}));
      const id = await storage.insert({ n: 1 });
      const seq = storage.log.next;
      failing = true;
      const a = storage.update(id, { n: 2 });
      const b = storage.push(id, 'body', 'z');
      await assert.rejects(a, /disk full/);
      await assert.rejects(b, /disk full/);
      failing = false;
      assert.strictEqual(storage.stats().inflight, 0, 'nothing in flight');
      assert.strictEqual(storage.log.next, seq, 'the seqs were taken back');
      assert.deepStrictEqual(await storage.get(id), { n: 1 }, 'nothing of them was read');
      await storage.update(id, { n: 3 });
      assert.deepStrictEqual(await storage.get(id), { n: 3 }, 'the next write builds on what is durable');
      assert.strictEqual(storage.log.next, seq + 1);
    },
  );

  await t.test('two writes in flight cannot share a unique key', async (t2) => {
    const backend = gated(memory());
    const storage = await syncom.open({
      path: '/u',
      fsi: backend.fsi,
      logger: false,
      defer: 0,
      schema: { entities: { User: { unique: [['email']] } } },
    });
    t2.after(() => {
      backend.release();
      return storage.close().catch(() => {});
    });
    backend.hold();
    const first = storage.User.insert({ email: 'a@x' });
    const second = storage.User.insert({ email: 'a@x' });
    const rejected = assert.rejects(second, { code: 'VALIDATION_FAILED' });
    backend.release();
    await first;
    await rejected;
    assert.strictEqual((await storage.User.select().fetch()).length, 1);
  });

  await t.test(
    'afterWrite, commit and change come after the disk, in log order, and the call waits for them',
    async (t2) => {
      const backend = gated(memory());
      const seen = [];
      const storage = await syncom.open({
        path: '/e',
        fsi: backend.fsi,
        logger: false,
        defer: 0,
        hooks: { afterWrite: (ctx, op) => void seen.push(`hook:${op.data?.n ?? op.value?.content}`) },
      });
      t2.after(() => {
        backend.release();
        return storage.close().catch(() => {});
      });
      storage.on('change', (op) => seen.push(`change:${op.data?.n ?? op.value?.content}`));
      const id = await storage.insert({ n: 0 });
      seen.length = 0;
      backend.hold();
      const writes = [storage.update(id, { n: 1 }), storage.update(id, { n: 2 }), storage.push(id, 'body', 'c')];
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.deepStrictEqual(seen, [], 'nothing announced before the disk');
      backend.release();
      await Promise.all(writes);
      // Log order — the order the queue ran them in, not the order of the calls.
      const expected = [];
      for (const { op } of storage.log.since(undefined).slice(-3)) {
        const what = op.data?.n ?? op.value?.content;
        expected.push(`hook:${what}`, `change:${what}`);
      }
      assert.deepStrictEqual(seen, expected);
    },
  );

  await t.test('flush() lands what waits: the writes in flight, then the deferred files', async (t2) => {
    const storage = await open(t2, { defer: 10_000 });
    const id = await storage.insert({ n: 1 });
    await storage.update(id, { n: 2 });
    assert.strictEqual(storage.stats().deferred, 1);
    assert.strictEqual(await storage.fsi.exists('/group/data', `${id}.json`), false, 'the file waits');
    await storage.flush();
    assert.strictEqual(storage.stats().deferred, 0);
    assert.deepStrictEqual(JSON.parse(await storage.fsi.read('/group/data', `${id}.json`)).data, { n: 2 });
  });
});
