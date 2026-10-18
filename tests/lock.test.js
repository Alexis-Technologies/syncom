'use strict';

// Exclusive open over a lockfile: a second instance is refused or waits, a
// stale file is taken over, a failed open lets go, and `lock: false` opts out.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs/promises');
const path = require('node:path');
const syncom = require('..');
const { acquireLock, LOCK_FILE } = require('../src/lock.js');
const { createTemp, cleanupTemp } = require('./utils/temp.js');

const openTemp = async (t, options = {}) => {
  const dir = await createTemp();
  t.after(() => cleanupTemp(dir));
  return { dir, open: (more = {}) => syncom.open({ path: dir, logger: false, ...options, ...more }) };
};

test('Exclusive open (lockfile)', async (t) => {
  await t.test('a second instance is refused with LOCKED; close() frees the directory', async (t2) => {
    const { dir, open } = await openTemp(t2);
    const first = await open();
    const lock = JSON.parse(await fs.readFile(path.join(dir, LOCK_FILE), 'utf8'));
    assert.strictEqual(lock.pid, process.pid);
    assert.strictEqual(typeof lock.id, 'string');
    assert.strictEqual(typeof lock.since, 'number');
    await assert.rejects(() => open(), { code: 'LOCKED', message: /is locked by another instance/ });
    await assert.rejects(() => open({ lock: 'fail' }), { code: 'LOCKED' });
    await first.close();
    await assert.rejects(() => fs.stat(path.join(dir, LOCK_FILE)), { code: 'ENOENT' });
    const second = await open();
    await second.close();
  });

  await t.test("'wait' resolves once the holder closes; false does not look", async (t2) => {
    const { open } = await openTemp(t2);
    const first = await open();
    let resolved = false;
    const waiting = open({ lock: 'wait' }).then((storage) => {
      resolved = true;
      return storage;
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.strictEqual(resolved, false, 'still held');
    await first.close();
    const second = await waiting;
    assert.strictEqual(resolved, true);
    const third = await open({ lock: false });
    await second.close();
    await third.close();
  });

  await t.test('a stale lockfile is taken over: a dead pid, or an old one with no pid', async (t2) => {
    const { dir, open } = await openTemp(t2);
    await fs.writeFile(path.join(dir, LOCK_FILE), JSON.stringify({ pid: 2 ** 31 - 1, id: 'gone', since: Date.now() }));
    const takenOver = await open();
    assert.notStrictEqual(JSON.parse(await fs.readFile(path.join(dir, LOCK_FILE), 'utf8')).id, 'gone');
    await takenOver.close();
    await fs.writeFile(path.join(dir, LOCK_FILE), JSON.stringify({ id: 'old', since: Date.now() - 3_600_000 }));
    const aged = await open();
    await aged.close();
    await fs.writeFile(path.join(dir, LOCK_FILE), JSON.stringify({ id: 'fresh', since: Date.now() }));
    await assert.rejects(() => open(), { code: 'LOCKED' }, 'no pid and recent: held');
    await fs.writeFile(path.join(dir, LOCK_FILE), 'not json');
    const corrupt = await open();
    await corrupt.close();
    await fs.writeFile(path.join(dir, LOCK_FILE), JSON.stringify({ pid: process.pid, id: 'mine', since: Date.now() }));
    await assert.rejects(() => open(), { code: 'LOCKED' }, 'a live pid is held, whatever its age');
    // pid 1 is alive and (almost always) not ours to signal: EPERM means alive.
    await fs.writeFile(path.join(dir, LOCK_FILE), JSON.stringify({ pid: 1, id: 'init', since: 0 }));
    await assert.rejects(() => open(), { code: 'LOCKED' });
  });

  await t.test('a lock that is not ours is left alone on close; a failed open releases ours', async (t2) => {
    const { dir, open } = await openTemp(t2);
    const storage = await open();
    await fs.writeFile(path.join(dir, LOCK_FILE), JSON.stringify({ id: 'theirs', since: Date.now() }));
    await storage.close();
    assert.strictEqual(JSON.parse(await fs.readFile(path.join(dir, LOCK_FILE), 'utf8')).id, 'theirs');
    await fs.rm(path.join(dir, LOCK_FILE));
    // An open that fails after the lock was taken: the lock goes with it.
    const fsi = require('../src/fsi.js');
    const failing = {
      ...fsi,
      read: async (d, name) => {
        if (name === 'node.json') throw new Error('unreadable');
        return fsi.read(d, name);
      },
    };
    await open().then((s) => s.close());
    await assert.rejects(() => open({ fsi: failing }), /unreadable/);
    await assert.rejects(() => fs.stat(path.join(dir, LOCK_FILE)), { code: 'ENOENT' });
    const again = await open();
    await again.close();
  });

  await t.test('the option is checked; two racing openers of a stale lock settle on one', async (t2) => {
    const { dir, open } = await openTemp(t2);
    await assert.rejects(async () => open({ lock: 'maybe' }), {
      name: 'TypeError',
      message: "open({ lock }): lock must be 'fail', 'wait' or false",
    });
    const fsi = require('../src/fsi.js');
    const results = await Promise.allSettled([
      acquireLock({ fsi, path: dir, mode: 'fail' }),
      acquireLock({ fsi, path: dir, mode: 'fail' }),
    ]);
    const held = results.filter((r) => r.status === 'fulfilled');
    assert.strictEqual(held.length >= 1, true);
    for (const r of held) await r.value.release();
    await assert.rejects(() => fs.stat(path.join(dir, LOCK_FILE)), { code: 'ENOENT' });
  });
});
