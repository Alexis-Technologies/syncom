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
      // read(): the same entries, plus where the cursor may move — the last
      // entry examined, in scope or not, a real position.
      assert.deepStrictEqual(log.read(undefined, { scopes: ['other'] }).last, 3, 'B@s was looked at');
      assert.strictEqual(log.read(undefined, { scopes: ['other'] }).entries.length, 2);
      assert.deepStrictEqual(log.read(log.formatId(3)), { entries: [], last: null }, 'nothing to examine');
      assert.strictEqual(log.read(undefined, { limit: 1 }).last, 1, 'a limit stops at the entry it took');
      assert.strictEqual(log.read(log.formatId(2), { scopes: ['other'] }).last, 3, 'an empty page still moves');
      assert.strictEqual(log.read('garbage'), null);
      // entriesOf(): a record's own entries, oldest first.
      assert.deepStrictEqual(
        log.entriesOf('r1').map((entry) => entry.seq),
        [1, 3],
        'r1 was written at seq 1 and again at 3',
      );
      assert.deepStrictEqual(log.entriesOf('nope'), []);

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
      // A clean close seals the open files: a reopen has nothing to replay.
      assert.strictEqual(reopened.tail().length, 0);
      assert.ok((await fs.readdir(path.join(dir, 'log'))).some((name) => name.startsWith('seg-')));
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
      assert.strictEqual(log.retainedOps, 4);
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
      assert.strictEqual(log.retainedOps, Infinity, 'no count bounds a log retained by age only');
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

  await t.test('a skipped op is logged, served and flagged through a reopen', async () => {
    const dir = await createTemp();
    try {
      let log = await new OpLog(dir);
      const skip = op('A', 2);
      const entries = await log.append([op('A', 1), skip, op('A', 3)], { skipped: new Set([skip]) });
      assert.deepStrictEqual(
        entries.map((entry) => entry.skipped),
        [undefined, true, undefined],
      );
      assert.deepStrictEqual(log.vector, { A: 3 }, 'a skipped op moves the vector like any other');
      assert.strictEqual(log.since(undefined).length, 3, 'and is served to resuming peers');
      await log.close();
      log = await new OpLog(dir);
      assert.deepStrictEqual(
        log.since(log.formatId(0)).map((entry) => entry.skipped),
        [undefined, true, undefined],
        'the flag survives a reopen (in the segment the close sealed), for a replay to honour',
      );
    } finally {
      await cleanupTemp(dir);
    }
  });

  await t.test('held entries are flagged, listed, kept through a reopen, and counted when compacted away', async () => {
    const dir = await createTemp();
    try {
      const log = await new OpLog(dir, { rollAfter: 2, retention: { ops: 4 } });
      const ops = [op('A', 1, { v: 2 }), op('A', 2)];
      const entries = await log.append(ops, { skipped: new Set([ops[0]]), held: new Map([[ops[0], 2]]) });
      assert.deepStrictEqual(entries, [
        { seq: 1, op: ops[0], skipped: true, held: 2 },
        { seq: 2, op: ops[1] },
      ]);
      assert.deepStrictEqual(log.held(), [entries[0]]);
      assert.strictEqual(log.droppedHeld, 0);
      await log.close();

      const reopened = await new OpLog(dir, { rollAfter: 2, retention: { ops: 4 } });
      assert.deepStrictEqual(reopened.held(), [{ seq: 1, op: ops[0], skipped: true, held: 2 }]);
      // Append past retention: the segment holding it is dropped, and that is counted.
      for (let seq = 3; seq <= 14; seq++) await reopened.append([op('A', seq)]);
      assert.deepStrictEqual(reopened.held(), []);
      assert.strictEqual(reopened.droppedHeld, 1);
      await reopened.close();

      const again = await new OpLog(dir, { rollAfter: 2, retention: { ops: 4 } });
      assert.strictEqual(again.droppedHeld, 1, 'persisted with the index');
      await again.resetDroppedHeld();
      assert.strictEqual(again.droppedHeld, 0);
      await again.resetDroppedHeld();
      await again.close();
      const index = JSON.parse(await fs.readFile(path.join(dir, 'log', 'index.json'), 'utf8'));
      assert.strictEqual(index.droppedHeld, 0);
    } finally {
      await cleanupTemp(dir);
    }
  });

  await t.test('scrub strips an id’s payload from memory, the segments and the open files', async () => {
    const dir = await createTemp();
    try {
      const log = await new OpLog(dir, { rollAfter: 2 });
      await log.append([op('A', 1, { id: 'secret', data: { ssn: 'SECRET-1' } }), op('A', 2)]);
      await log.append([op('A', 3, { id: 'secret', type: 'add', key: 'tags', value: ['SECRET-3'] })]);
      await log.append([op('A', 4, { id: 'other', data: { ssn: 'OTHER' } })]);
      const signed = { sig: 'S'.repeat(86), digest: 'd'.repeat(64), nonce: 'SECRET-NONCE-0000' };
      await log.append([op('A', 5, { id: 'secret', data: { ssn: 'SECRET-2' }, ...signed })]);
      assert.strictEqual(await log.scrub('secret'), 3);
      assert.strictEqual(await log.scrub('secret'), 0, 'idempotent');
      assert.strictEqual(await log.scrub('nope'), 0);
      const entries = log.since(undefined);
      assert.deepStrictEqual(
        entries.map((entry) => [
          entry.seq,
          entry.scrubbed === true,
          'data' in entry.op,
          'key' in entry.op,
          'value' in entry.op,
        ]),
        [
          [1, true, false, false, false],
          [2, false, true, false, false],
          [3, true, false, false, false],
          [4, false, true, false, false],
          [5, true, false, false, false],
        ],
      );
      assert.deepStrictEqual(log.vector, { A: 5 }, 'positions and the vector are untouched');
      const scrubbedSigned = entries[4].op;
      assert.strictEqual(scrubbedSigned.sig, signed.sig, 'the signature stays');
      assert.strictEqual(scrubbedSigned.digest, signed.digest, 'and the digest');
      assert.strictEqual('nonce' in scrubbedSigned, false, 'the nonce goes with the payload');
      const files = await fs.readdir(path.join(dir, 'log'), { recursive: true });
      for (const file of files) {
        const text = await fs.readFile(path.join(dir, 'log', file), 'utf8').catch(() => '');
        assert.ok(!text.includes('SECRET'), `${file} still holds the payload`);
      }
      assert.ok((await fs.readFile(path.join(dir, 'log', 'seg-0000000004.json'), 'utf8')).includes('OTHER'));
      await log.close();
      const reopened = await new OpLog(dir, { rollAfter: 2 });
      assert.deepStrictEqual(reopened.vector, { A: 5 });
      assert.strictEqual(reopened.since(undefined)[0].scrubbed, true);
      assert.strictEqual(reopened.since(undefined)[0].op.origin, 'A');
      await reopened.close();
    } finally {
      await cleanupTemp(dir);
    }
  });

  await t.test(
    'sealApplied: a roll never seals past the oldest batch not yet applied; close seals the rest',
    async () => {
      const dir = await createTemp();
      try {
        const log = await new OpLog(dir, { rollAfter: 1, sealApplied: true });
        await log.append([op('A', 1)]);
        await log.append([op('A', 2)]); // rolls — nothing is applied yet
        assert.strictEqual(log.tail().length, 2);
        log.applied(1);
        await log.append([op('A', 3)]); // rolls — seals 1; 2 is unapplied, 3 just landed
        assert.deepStrictEqual(
          log.tail().map((entry) => entry.seq),
          [2, 3],
        );
        log.applied(3); // 3 landed while 2 still has not: 2 holds the line
        await log.append([op('A', 4)]);
        assert.deepStrictEqual(
          log.tail().map((entry) => entry.seq),
          [2, 3, 4],
        );
        await log.close();
        assert.deepStrictEqual(
          log.tail().map((entry) => entry.seq),
          [2, 3, 4],
          'a clean close seals nothing past it either',
        );
        const reopened = await new OpLog(dir, { rollAfter: 1, sealApplied: true });
        assert.deepStrictEqual(
          reopened.tail().map((entry) => entry.seq),
          [2, 3, 4],
          'the open files are pending again until the owner says otherwise',
        );
        reopened.applied(2, 4);
        await reopened.close();
        assert.strictEqual(reopened.tail().length, 0);
        assert.strictEqual((await fs.readdir(path.join(dir, 'log', 'open'))).length, 0);
        assert.strictEqual(reopened.since(reopened.formatId(0)).length, 4);
      } finally {
        await cleanupTemp(dir);
      }
    },
  );

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

test('droppedTs is the newest stamp compaction dropped; a pin holds a segment past retention', async () => {
  const dir = await createTemp();
  try {
    const log = await new OpLog(dir, { rollAfter: 1, retention: { ops: 2 } });
    assert.strictEqual(log.droppedTs, 0, 'nothing dropped yet');
    // Stamps out of seq order: the newest DROPPED stamp is kept, not the last.
    await log.append([op('A', 1, { ts: 5 })]);
    await log.append([op('A', 2, { ts: 1 })]);
    await log.append([op('A', 3, { ts: 2 })]);
    await log.append([op('A', 4, { ts: 3 })]);
    assert.strictEqual(log.floor, 3, 'compacted to the last two');
    const dropped = log.droppedTs;
    assert.strictEqual(dropped, 5);
    assert.strictEqual(log.latestTs, 5);
    const index = JSON.parse(await fs.readFile(path.join(dir, 'log', 'index.json'), 'utf8'));
    assert.strictEqual(index.droppedTs, 5, 'persisted with the index');
    // A pin keeps the segment that holds a kept entry, and everything after
    // it; the floor still moves up to it.
    const unpin = log.pin((entry) => entry.seq === 4);
    for (let seq = 5; seq <= 9; seq++) await log.append([op('A', seq, { ts: seq })]);
    assert.strictEqual(log.floor, 4, 'the pinned segment stays');
    assert.strictEqual(log.entriesOf('r4').length, 1);
    assert.strictEqual(log.droppedTs, dropped, 'seq 3 (ts 2) went, below the newest dropped');
    assert.ok(log.length >= 6);
    // Two pins and a retain add up: the lowest kept entry wins.
    const unpinLater = log.pin((entry) => entry.seq === 8);
    log.retain((entry) => entry.seq === 6);
    unpin();
    await log.append([op('A', 10, { ts: 10 })]);
    assert.ok(log.floor <= 6, `retain still holds 6 (floor ${log.floor})`);
    log.retain(null);
    await log.append([op('A', 11, { ts: 11 })]);
    assert.ok(log.floor <= 8 && log.floor > 6, `the pin on 8 holds (floor ${log.floor})`);
    unpinLater();
    await log.append([op('A', 12, { ts: 12 })]);
    assert.ok(log.floor > 8, `released (floor ${log.floor})`);
    assert.strictEqual(log.droppedTs, 10, 'the newest stamp among what went');
    assert.throws(() => log.pin(null), TypeError);
    assert.throws(() => log.pin('x'), TypeError);
    await log.close();
    // Reopen: droppedTs rides in the index.
    const reopened = await new OpLog(dir, { rollAfter: 1, retention: { ops: 2 } });
    assert.strictEqual(reopened.droppedTs, 10);
    await reopened.close();
    // An index from before droppedTs existed, with something compacted:
    // what went is unknown, so everything retained is vouched for by nothing.
    const stale = JSON.parse(await fs.readFile(path.join(dir, 'log', 'index.json'), 'utf8'));
    delete stale.droppedTs;
    await fs.writeFile(path.join(dir, 'log', 'index.json'), JSON.stringify(stale));
    const old = await new OpLog(dir, { rollAfter: 1, retention: { ops: 2 } });
    assert.strictEqual(old.droppedTs, old.latestTs);
    await old.close();
    // A segment that cannot be read is as good as dropped.
    const fresh = await createTemp();
    try {
      const whole = await new OpLog(fresh, { rollAfter: 1 });
      await whole.append([op('A', 1, { ts: 100 })]);
      await whole.append([op('A', 2, { ts: 200 })]);
      await whole.close();
      assert.strictEqual(whole.droppedTs, 0);
      const names = (await fs.readdir(path.join(fresh, 'log'))).filter((name) => name.startsWith('seg-')).sort();
      await fs.writeFile(path.join(fresh, 'log', names[0]), '{ torn');
      const torn = await new OpLog(fresh, { rollAfter: 1, logger: false });
      assert.strictEqual(torn.droppedTs, 200, 'up to the newest stamp known');
      await torn.close();
      // No index at all with retained entries that start above 1: the same.
      await fs.rm(path.join(fresh, 'log', 'index.json'));
      await fs.rm(path.join(fresh, 'log', names[0]));
      const orphan = await new OpLog(fresh, { rollAfter: 1, logger: false });
      assert.ok(orphan.floor > 1);
      assert.strictEqual(orphan.droppedTs, orphan.latestTs);
      await orphan.close();
    } finally {
      await cleanupTemp(fresh);
    }
  } finally {
    await cleanupTemp(dir);
  }
});

test('a new epoch is said out loud when a log was there', async () => {
  const dir = await createTemp();
  try {
    const entries = [];
    const logger = {
      warn: (entry) => entries.push(['warn', entry]),
      debug: (entry) => entries.push(['debug', entry]),
      info() {},
      error() {},
    };
    const fresh = await new OpLog(dir, { logger });
    await fresh.append([op('A', 1)]);
    await fresh.close();
    assert.deepStrictEqual(
      entries.filter(([, e]) => e.event === 'log.epoch.new').map(([level, e]) => [level, e.reason, e.entries]),
      [['debug', 'no index', 0]],
      'a brand-new log whispers',
    );
    await fs.rm(path.join(dir, 'log', 'index.json'));
    await new OpLog(dir, { logger });
    const loud = entries.filter(([, e]) => e.event === 'log.epoch.new').at(-1);
    assert.deepStrictEqual([loud[0], loud[1].reason, loud[1].entries], ['warn', 'no index', 1]);
    await fs.writeFile(path.join(dir, 'log', 'index.json'), '{broken');
    await new OpLog(dir, { logger });
    assert.strictEqual(entries.filter(([, e]) => e.event === 'log.epoch.new').at(-1)[1].reason, 'unreadable index');
  } finally {
    await cleanupTemp(dir);
  }
});

test('latestTs rides in the index: a reopen with everything sealed still knows the newest stamp', async () => {
  const dir = await createTemp();
  try {
    const ahead = Date.now() + 3_600_000;
    const log = await new OpLog(dir, { rollAfter: 1 });
    await log.append([{ origin: 'A', seq: 1, ts: ahead, type: 'write', id: 'r', data: {} }]);
    await log.close();
    const index = JSON.parse(await fs.readFile(path.join(dir, 'log', 'index.json'), 'utf8'));
    assert.strictEqual(index.latestTs, ahead);
    const reopened = await new OpLog(dir, { rollAfter: 1 });
    assert.strictEqual(reopened.latestTs, ahead);
  } finally {
    await cleanupTemp(dir);
  }
});

test('a group commit: appends issued together land as one file, in order; a failed write takes its seqs back', async (t) => {
  await t.test(
    'appends that come while a file is written go as one file after it, published in seq order',
    async () => {
      const dir = await createTemp();
      try {
        const log = await new OpLog(dir, { rollAfter: 100, sealApplied: true });
        // Three appends in one tick: seqs reserved at once, the vector ahead
        // of the disk, one group — one file.
        const first = log.append([op('A', 1)]);
        const second = log.append([op('A', 2), op('B', 1)]);
        const third = log.append([op('A', 3)]);
        assert.deepStrictEqual(
          first.entries.map((entry) => entry.seq),
          [1],
        );
        assert.deepStrictEqual(
          second.entries.map((entry) => entry.seq),
          [2, 3],
        );
        assert.deepStrictEqual(
          third.entries.map((entry) => entry.seq),
          [4],
        );
        assert.deepStrictEqual(log.vector, { A: 3, B: 1 }, 'reserved: the vector moved before the disk');
        assert.strictEqual(log.next, 5);
        assert.strictEqual(log.length, 0, 'nothing published before the file is down');
        const [a, b, c] = await Promise.all([first, second, third]);
        assert.deepStrictEqual(
          [...a, ...b, ...c].map((entry) => entry.seq),
          [1, 2, 3, 4],
        );
        assert.strictEqual(log.length, 4);
        const names = (await fs.readdir(path.join(dir, 'log', 'open'))).sort();
        assert.deepStrictEqual(names, ['0000000001.json'], 'one file for the group');
        // A fourth, alone, is its own file; the groups read back in order.
        await log.append([op('B', 2)]);
        assert.deepStrictEqual(
          log.since(undefined).map((entry) => entry.seq),
          [1, 2, 3, 4, 5],
        );
        // Applied one seq at a time, a group's file is sealed once every seq
        // of it is; the roll stops short of what is not.
        log.applied(1, 3);
        await log.flush();
        assert.strictEqual(log.segments, 0, 'seq 4 of the first file holds the line');
        log.applied(4);
        await log.flush();
        assert.strictEqual(log.segments, 1);
        assert.deepStrictEqual(
          log.tail().map((entry) => entry.seq),
          [5],
        );
        const reopened = await new OpLog(dir, { rollAfter: 100, sealApplied: true });
        assert.deepStrictEqual(
          reopened.since(undefined).map((entry) => entry.seq),
          [1, 2, 3, 4, 5],
        );
        assert.deepStrictEqual(reopened.vector, { A: 3, B: 2 });
      } finally {
        await cleanupTemp(dir);
      }
    },
  );

  await t.test(
    'a write that fails rejects its group and the one behind it; the seqs are handed out again',
    async () => {
      const dir = await createTemp();
      try {
        const fsi = require('../src/fsi.js');
        let failing = false;
        const flaky = {
          ...fsi,
          write: (...args) => (failing ? Promise.reject(new Error('disk full')) : fsi.write(...args)),
        };
        const log = await new OpLog(dir, { rollAfter: 100, fsi: flaky });
        await log.append([op('A', 1)]);
        failing = true;
        const second = log.append([op('A', 2)]);
        const third = log.append([op('A', 3)]);
        assert.deepStrictEqual(log.vector, { A: 3 });
        await assert.rejects(second, /disk full/);
        await assert.rejects(third, /disk full/, 'the group gathered behind the failed one goes with it');
        assert.strictEqual(log.length, 1, 'nothing of them published');
        assert.strictEqual(log.next, 2, 'the seqs are taken back');
        assert.deepStrictEqual(log.vector, { A: 1 }, 'and so is the vector');
        failing = false;
        const [{ seq }] = await log.append([op('A', 2)]);
        assert.strictEqual(seq, 2, 'the next append gets the first of them again');
        assert.deepStrictEqual(
          log.since(undefined).map((entry) => entry.seq),
          [1, 2],
        );
      } finally {
        await cleanupTemp(dir);
      }
    },
  );
});
