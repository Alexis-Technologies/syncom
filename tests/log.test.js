'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs/promises');
const path = require('node:path');
const { OpLog } = require('../src/log.js');
const { createTemp, cleanupTemp } = require('./utils/temp.js');

const op = (origin, seq, extra = {}) => ({
  type: 'set',
  origin,
  seq,
  ts: seq,
  id: `r${seq}`,
  data: { v: seq },
  ...extra,
});

test('OpLog', async (t) => {
  await t.test('append assigns seqs, tracks the vector and answers since()', async () => {
    const dir = await createTemp();
    try {
      const log = await new OpLog(dir);
      assert.strictEqual(log.floor, 1);
      assert.strictEqual(log.next, 1);
      assert.deepStrictEqual(log.since(undefined), []);
      assert.deepStrictEqual(await log.append([]), []);

      const first = await log.append([op('A', 1), op('A', 2)]);
      assert.deepStrictEqual(
        first.map((entry) => entry.seq),
        [1, 2],
      );
      await log.append([op('B', 1, { scope: 's' })]);
      // Seqs run per origin AND scope: a scoped op has its own vector key.
      assert.deepStrictEqual(log.vector, { A: 2, 'B@s': 1 });
      assert.strictEqual(log.lastEventId, `${log.epoch}.3`);

      assert.strictEqual(log.since(undefined).length, 3);
      assert.strictEqual(log.since(log.formatId(0)).length, 3);
      assert.deepStrictEqual(
        log.since(log.formatId(2)).map((entry) => entry.op.origin),
        ['B'],
      );
      assert.deepStrictEqual(log.since(log.formatId(3)), []);
      assert.strictEqual(log.since(log.formatId(1), { limit: 1 }).length, 1);
      // Unscoped ops are global: every subscriber gets them; scoped ones
      // reach only the subscribers that asked for the scope.
      assert.strictEqual(log.since(undefined, { scopes: ['s'] }).length, 3);
      assert.strictEqual(log.since(undefined, { scopes: ['*'] }).length, 3);
      assert.strictEqual(log.since(undefined, { scopes: ['other'] }).length, 2);
      assert.strictEqual(log.since(undefined, { scopes: ['other'] })[0].op.scope, undefined);

      assert.strictEqual(log.since('other-epoch.1'), null);
      assert.strictEqual(log.since('garbage'), null);
      await log.close();
    } finally {
      await cleanupTemp(dir);
    }
  });

  await t.test('reopen restores epoch, next, vector and entries', async () => {
    const dir = await createTemp();
    try {
      const log = await new OpLog(dir);
      await log.append([op('A', 1), op('A', 2)]);
      const { epoch } = log;
      await log.close();

      const reopened = await new OpLog(dir);
      assert.strictEqual(reopened.epoch, epoch);
      assert.strictEqual(reopened.next, 3);
      assert.deepStrictEqual(reopened.vector, { A: 2 });
      assert.strictEqual(reopened.since(reopened.formatId(0)).length, 2);
      // Unsealed entries are the tail a reopen replays.
      assert.strictEqual(reopened.tail().length, 2);
      const more = await reopened.append([op('A', 3)]);
      assert.strictEqual(more[0].seq, 3);
    } finally {
      await cleanupTemp(dir);
    }
  });

  await t.test('rolls open files into a segment and compacts past retention', async () => {
    const dir = await createTemp();
    try {
      const log = await new OpLog(dir, { rollAfter: 2, retention: { ops: 4 } });
      for (let seq = 1; seq <= 8; seq++) await log.append([op('A', seq)]);
      const names = (await fs.readdir(path.join(dir, 'log'))).sort();
      assert.ok(names.some((name) => name.startsWith('seg-')));
      // Retained ops are bounded; the floor moved up; the vector did not forget.
      assert.ok(log.length <= 6, `retained ${log.length}`);
      assert.ok(log.floor > 1);
      assert.deepStrictEqual(log.vector, { A: 8 });
      assert.strictEqual(log.since(undefined), null, 'a fresh subscriber must bootstrap once history was compacted');
      assert.strictEqual(log.since(log.formatId(log.floor - 2)), null);
      assert.ok(Array.isArray(log.since(log.formatId(log.floor - 1))));
      assert.deepStrictEqual(
        log.since(log.formatId(7)).map((entry) => entry.seq),
        [8],
      );
      assert.strictEqual(log.tail().length, 0);

      const reopened = await new OpLog(dir, { rollAfter: 2, retention: { ops: 4 } });
      assert.strictEqual(reopened.floor, log.floor);
      assert.strictEqual(reopened.length, log.length);
      assert.deepStrictEqual(reopened.vector, { A: 8 });
    } finally {
      await cleanupTemp(dir);
    }
  });

  await t.test('age-based retention drops old segments', async () => {
    const dir = await createTemp();
    try {
      const log = await new OpLog(dir, { rollAfter: 2, retention: { ops: 0, days: 1 } });
      const old = Date.now() - 3 * 86_400_000;
      await log.append([op('A', 1, { ts: old })]);
      await log.append([op('A', 2, { ts: old })]);
      await log.append([op('A', 3)]);
      await log.append([op('A', 4)]);
      assert.deepStrictEqual(
        log.since(log.formatId(log.floor - 1)).map((entry) => entry.seq),
        [3, 4],
      );
    } finally {
      await cleanupTemp(dir);
    }
  });

  await t.test('survives a torn open file, a lost index and a duplicated roll', async () => {
    const dir = await createTemp();
    try {
      const warnings = [];
      const logger = { warn: (entry) => warnings.push(entry) };
      const log = await new OpLog(dir, { rollAfter: 3, logger });
      for (let seq = 1; seq <= 4; seq++) await log.append([op('A', seq)]);
      const { epoch } = log;
      await log.close();

      const logDir = path.join(dir, 'log');
      // Crash mid-roll: the sealed batch is still in open/ too.
      const segment = (await fs.readdir(logDir)).find((name) => name.startsWith('seg-'));
      const sealed = JSON.parse(await fs.readFile(path.join(logDir, segment), 'utf8'));
      await fs.writeFile(path.join(logDir, 'open', '0000000001.json'), JSON.stringify(sealed));
      // Crash mid-append: a torn file for a batch nobody was told about.
      await fs.writeFile(path.join(logDir, 'open', '0000000009.json'), '{"entries":[{"seq":9,');

      const reopened = await new OpLog(dir, { rollAfter: 3, logger });
      assert.strictEqual(reopened.epoch, epoch);
      assert.deepStrictEqual(
        reopened.since(reopened.formatId(0)).map((entry) => entry.seq),
        [1, 2, 3, 4],
      );
      assert.strictEqual(reopened.next, 5, 'the torn batch must not advance the seq');
      assert.ok(warnings.some((entry) => entry.event === 'log.open.unreadable'));
      await reopened.close();

      // A lost index is a new epoch: old ids cannot resume, data is kept.
      await fs.rm(path.join(logDir, 'index.json'));
      const fresh = await new OpLog(dir, { rollAfter: 3, logger });
      assert.notStrictEqual(fresh.epoch, epoch);
      assert.strictEqual(fresh.since(`${epoch}.2`), null);
      assert.strictEqual(fresh.since(fresh.formatId(0)).length, 4);
      assert.deepStrictEqual(fresh.vector, { A: 4 });
      assert.strictEqual(fresh.next, 5);

      // An unreadable segment is reported, not fatal: what it held is gone,
      // what the open files hold survives.
      await fs.rm(path.join(logDir, 'open', '0000000001.json'));
      await fs.writeFile(path.join(logDir, segment), 'not json');
      const damaged = await new OpLog(dir, { rollAfter: 3, logger });
      assert.ok(warnings.some((entry) => entry.event === 'log.segment.unreadable'));
      assert.deepStrictEqual(
        damaged.since(damaged.formatId(0)).map((entry) => entry.seq),
        [4],
      );
    } finally {
      await cleanupTemp(dir);
    }
  });

  await t.test('flush seals the open files on demand', async () => {
    const dir = await createTemp();
    try {
      const log = await new OpLog(dir);
      await log.flush();
      await log.append([op('A', 1)]);
      await log.flush();
      assert.strictEqual(log.tail().length, 0);
      assert.strictEqual((await fs.readdir(path.join(dir, 'log', 'open'))).length, 0);
      assert.strictEqual(log.since(log.formatId(0)).length, 1);
    } finally {
      await cleanupTemp(dir);
    }
  });
});
