'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs/promises');
const path = require('node:path');
const { OpLog } = require('../src/log.js');
const { createTemp, cleanupTemp } = require('./utils/temp.js');
const { openGroups, withoutAppend } = require('./utils/groups.js');
const nodeFsi = require('../src/fsi.js');

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

  await t.test(
    "a file whose checksum does not match is unreadable: an altered segment is lost and counted, an altered open file kept aside as evidence; retention 'all' keeps every segment",
    async () => {
      const dir = await createTemp();
      try {
        const warnings = [];
        const logger = { warn: (entry) => warnings.push(entry), error: (entry) => warnings.push(entry) };
        const log = await new OpLog(dir, { rollAfter: 2, logger });
        for (let seq = 1; seq <= 5; seq++) await log.append([op('A', seq)]);
        await log.close();
        const logDir = path.join(dir, 'log');
        const [segment] = (await fs.readdir(logDir)).filter((name) => name.startsWith('seg-')).sort();
        const sealed = JSON.parse(await fs.readFile(path.join(logDir, segment), 'utf8'));
        assert.match(sealed.hash, /^[0-9a-f]{8}$/, 'every file carries its checksum');
        // Altered on disk: the hash no longer matches, the segment is lost;
        // an open batch with a wrong hash is dropped.
        sealed.entries[0].op.data.n = 99;
        await fs.writeFile(path.join(logDir, segment), JSON.stringify(sealed));
        const batch = { entries: [{ seq: 6, op: op('A', 6) }], hash: '00000000' };
        await fs.writeFile(path.join(logDir, 'open', '0000000006.json'), JSON.stringify(batch));
        const reopened = await new OpLog(dir, { rollAfter: 2, logger });
        assert.deepStrictEqual(
          warnings.map((entry) => [entry.event, entry.reason]),
          [
            ['log.segment.unreadable', 'checksum'],
            ['log.open.unreadable', 'checksum'],
          ],
        );
        assert.strictEqual(reopened.corrupt, 2);
        assert.deepStrictEqual(
          reopened.since(reopened.formatId(0)).map((entry) => entry.seq),
          [3, 4, 5],
          'the altered files are gone whole, the rest stays',
        );
        // The altered open batch was answered once: kept under corrupt/, out of open/.
        assert.deepStrictEqual(await fs.readdir(path.join(logDir, 'corrupt')), ['0000000006.json']);
        assert.ok(!(await fs.readdir(path.join(logDir, 'open'))).includes('0000000006.json'));
        assert.deepStrictEqual(
          JSON.parse(await fs.readFile(path.join(logDir, 'corrupt', '0000000006.json'), 'utf8')),
          batch,
        );
        assert.strictEqual(reopened.droppedTs, 5, 'an unreadable segment: the newest stamp held, as for a torn one');
        await reopened.close();
        // A file without a hash is not whole: unreadable like an altered one.
        const [last] = (await fs.readdir(logDir))
          .filter((name) => name.startsWith('seg-'))
          .sort()
          .slice(-1);
        const text = JSON.parse(await fs.readFile(path.join(logDir, last), 'utf8'));
        delete text.hash;
        await fs.writeFile(path.join(logDir, last), JSON.stringify(text));
        const hashless = await new OpLog(dir, { rollAfter: 2, logger });
        assert.deepStrictEqual(
          hashless.since(hashless.formatId(0)).map((entry) => entry.seq),
          [3, 4],
          'seq 5 was in the hashless segment',
        );
        assert.strictEqual(hashless.corrupt, 2, 'the altered segment and the hashless one');
        await hashless.close();
      } finally {
        await cleanupTemp(dir);
      }
      // retention 'all': nothing is ever dropped.
      const keep = await createTemp();
      try {
        const log = await new OpLog(keep, { rollAfter: 2, retention: 'all' });
        for (let seq = 1; seq <= 40; seq++) await log.append([op('A', seq)]);
        assert.strictEqual(log.retainedOps, Infinity);
        assert.strictEqual(log.floor, 1);
        assert.strictEqual(log.since(log.formatId(0)).length, 40);
        await log.close();
      } finally {
        await cleanupTemp(keep);
      }
    },
  );

  await t.test(
    'a scrub rewrites the files that hold what it takes: an id scrubbed before costs nothing more',
    async () => {
      const dir = await createTemp();
      try {
        const written = [];
        const fsi = {
          ...nodeFsi,
          write: (at, name, content, options) => {
            written.push(name);
            return nodeFsi.write(at, name, content, options);
          },
        };
        const log = await new OpLog(dir, { rollAfter: 2, fsi });
        for (let seq = 1; seq <= 6; seq++) await log.append([op('A', seq, { id: seq % 2 === 0 ? 'x' : `r${seq}` })]);
        assert.strictEqual(await log.scrub('x'), 3);
        written.length = 0;
        // One more op of x, open still: the second scrub takes it alone.
        await log.append([op('A', 7, { id: 'x' })]);
        written.length = 0;
        assert.strictEqual(await log.scrub('x'), 1);
        assert.ok(written.length > 0, 'the file of the new op is rewritten');
        for (const name of written) {
          assert.ok(!name.startsWith('seg-'), `${name}: a segment scrubbed before is left alone`);
        }
        written.length = 0;
        assert.strictEqual(await log.scrub('x'), 0);
        assert.deepStrictEqual(written, [], 'nothing fresh: nothing written');
        await log.close();
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    },
  );

  await t.test('a log file that is there but cannot be read fails the open, and is kept', async () => {
    const dir = await createTemp();
    try {
      const log = await new OpLog(dir, { rollAfter: 100 });
      for (let seq = 1; seq <= 3; seq++) await log.append([op('A', seq)]);
      await log.close();
      const real = require('../src/fsi.js');
      const failing = {
        ...real,
        read: async (at, name) => {
          // Every file but the index: the close sealed the ops into a segment.
          if (name !== 'index.json') throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' });
          return real.read(at, name);
        },
      };
      await assert.rejects(
        () => new OpLog(dir, { rollAfter: 100, fsi: failing }),
        (error) => {
          assert.strictEqual(error.code, 'CORRUPT');
          assert.strictEqual(error.cause.code, 'EIO');
          return true;
        },
      );
      // Nothing was taken for torn: the next open reads every op.
      const reopened = await new OpLog(dir, { rollAfter: 100 });
      assert.deepStrictEqual(
        reopened.since(reopened.formatId(0)).map((entry) => entry.seq),
        [1, 2, 3],
      );
      // Groups still open (a journal, not sealed): their read failing fails the open too.
      for (let seq = 4; seq <= 5; seq++) await reopened.append([op('A', seq)]);
      await assert.rejects(() => new OpLog(dir, { rollAfter: 100, fsi: failing }), { code: 'CORRUPT' });
      await reopened.close();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  await t.test('survives a torn open file, a lost index and a duplicated roll', async () => {
    const dir = await createTemp();
    try {
      const warnings = [];
      const logger = {
        warn: (entry) => warnings.push(entry),
        error: (entry) => warnings.push(entry),
        info: (entry) => warnings.push(entry),
      };
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
      assert.ok(
        warnings.some((entry) => entry.event === 'log.open.torn'),
        'a write never finished: torn, not lost',
      );
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
    // An index with a field missing is no index of this log's: a new
    // incarnation, and with something compacted what went is unknown, so
    // everything retained is vouched for by nothing.
    const stale = JSON.parse(await fs.readFile(path.join(dir, 'log', 'index.json'), 'utf8'));
    delete stale.droppedTs;
    await fs.writeFile(path.join(dir, 'log', 'index.json'), JSON.stringify(stale));
    const old = await new OpLog(dir, { rollAfter: 1, retention: { ops: 2 }, logger: false });
    assert.notStrictEqual(old.epoch, stale.epoch, 'a new incarnation');
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
      for (const journaled of [true, false]) await groupCommit(journaled);
    },
  );
  // Both ways a group reaches the disk: a line of a journal, or a file of its own.
  async function groupCommit(journaled) {
    {
      const dir = await createTemp();
      const fsi = journaled ? nodeFsi : withoutAppend(nodeFsi);
      try {
        const log = await new OpLog(dir, { rollAfter: 100, sealApplied: true, fsi });
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
        if (journaled) {
          assert.strictEqual(names.length, 1, 'one journal');
          assert.match(names[0], /^0000000001-[0-9a-z]+\.jsonl$/, 'named by its first seq');
          assert.strictEqual(await openGroups(fsi, path.join(dir, 'log', 'open')), 1, 'one line for the group');
        } else assert.deepStrictEqual(names, ['0000000001.json'], 'one file for the group');
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
        // The journal holds the unsealed group 5 too: it stays until that one is sealed.
        const still = await fs.readdir(path.join(dir, 'log', 'open'));
        assert.strictEqual(still.length, 1, journaled ? 'the journal stays for group 5' : 'the file of group 5');
        const reopened = await new OpLog(dir, { rollAfter: 100, sealApplied: true, fsi });
        assert.deepStrictEqual(
          reopened.since(undefined).map((entry) => entry.seq),
          [1, 2, 3, 4, 5],
        );
        assert.deepStrictEqual(reopened.vector, { A: 3, B: 2 });
        // Sealed whole, the journal goes.
        reopened.applied(5);
        await reopened.flush();
        assert.deepStrictEqual(await fs.readdir(path.join(dir, 'log', 'open')), [], 'every group sealed: no open file');
      } finally {
        await cleanupTemp(dir);
      }
    }
  }

  await t.test(
    'a write that fails rejects its group and the one behind it; the seqs are handed out again',
    async () => {
      for (const journaled of [true, false]) await failedWrite(journaled);
    },
  );
  async function failedWrite(journaled) {
    {
      const dir = await createTemp();
      try {
        const fsi = journaled ? nodeFsi : withoutAppend(nodeFsi);
        let failing = false;
        const fail = (call) => (failing ? Promise.reject(new Error('disk full')) : call());
        const flaky = { ...fsi, write: (...args) => fail(() => fsi.write(...args)) };
        if (journaled) flaky.append = (...args) => fail(() => fsi.append(...args));
        const log = await new OpLog(dir, { rollAfter: 100, fsi: flaky });
        await log.append([op('A', 1)]);
        failing = true;
        const second = log.append([op('A', 2)]);
        const third = log.append([op('A', 3), op('B', 1)]);
        assert.deepStrictEqual(log.vector, { A: 3, B: 1 });
        await assert.rejects(second, /disk full/);
        await assert.rejects(third, /disk full/, 'the group gathered behind the failed one goes with it');
        assert.strictEqual(log.length, 1, 'nothing of them published');
        assert.strictEqual(log.next, 2, 'the seqs are taken back');
        assert.deepStrictEqual(log.vector, { A: 1 }, 'and so is the vector: a stream the groups opened is gone');
        assert.strictEqual(log.health.appendFailures, 1, 'one failed write, counted');
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
    }
  }
});

test('a journal: a line per group, a torn last line left out, a failed line shadowed by the group that took its seqs', async (t) => {
  const lines = async (dir) => {
    const open = path.join(dir, 'log', 'open');
    const names = (await fs.readdir(open)).filter((name) => name.endsWith('.jsonl')).sort();
    return names.map((name) => path.join(open, name));
  };

  await t.test('a torn last line is left out; a line inside that does not read is counted lost', async () => {
    const dir = await createTemp();
    const warnings = [];
    const logger = {
      warn: (entry) => warnings.push(entry.event),
      info: (entry) => warnings.push(entry.event),
      error: (entry) => warnings.push(entry.event),
      debug() {},
    };
    try {
      const log = await new OpLog(dir, { rollAfter: 100, sealApplied: true });
      await log.append([op('A', 1)]);
      await log.append([op('A', 2)]);
      await log.append([op('A', 3)]);
      const [journal] = await lines(dir);
      // A crash in the middle of the next append: half a line at the end.
      await fs.appendFile(journal, '{"entries":[{"seq":4,"op":');
      const torn = await new OpLog(dir, { rollAfter: 100, sealApplied: true, logger });
      assert.deepStrictEqual(
        torn.since(undefined).map((entry) => entry.seq),
        [1, 2, 3],
      );
      assert.deepStrictEqual(warnings, ['log.open.torn']);
      assert.strictEqual(torn.droppedTs, 0, 'nothing acknowledged was lost');
      // The next append goes to a journal of its own, never after the torn line.
      await torn.append([op('A', 4)]);
      assert.strictEqual((await lines(dir)).length, 2);
      // A line inside a journal altered on the disk: the rest still read, the loss is told.
      const text = await fs.readFile(journal, 'utf8');
      const [first, second, ...rest] = text.split('\n');
      await fs.writeFile(journal, [first, second.replace('"A"', '"Z"'), ...rest].join('\n'));
      warnings.length = 0;
      const altered = await new OpLog(dir, { rollAfter: 100, sealApplied: true, logger });
      assert.deepStrictEqual(
        altered.since(undefined).map((entry) => entry.seq),
        [1, 3, 4],
      );
      assert.deepStrictEqual(warnings.sort(), ['log.open.torn', 'log.open.unreadable']);
      assert.strictEqual(altered.corrupt, 1, 'the checksum told it');
      assert.ok(altered.droppedTs > 0, 'what was lost is past what an exact read of the past can vouch for');
    } finally {
      await cleanupTemp(dir);
    }
  });

  await t.test(
    'a group whose append failed after its line landed is shadowed by the group that took its seqs',
    async () => {
      const dir = await createTemp();
      try {
        let lying = false;
        // An append that writes its line, then reports a failure: the line is whole on the disk.
        const fsi = {
          ...nodeFsi,
          append: async (...args) => {
            await nodeFsi.append(...args);
            if (lying) throw new Error('disk said no');
          },
        };
        const log = await new OpLog(dir, { rollAfter: 100, sealApplied: true, fsi });
        await log.append([op('A', 1)]);
        lying = true;
        await assert.rejects(log.append([op('A', 2, { id: 'stale' })]), /disk said no/);
        lying = false;
        const [{ seq }] = await log.append([op('B', 1, { id: 'fresh' })]);
        assert.strictEqual(seq, 2, 'the seq was handed out again');
        assert.strictEqual((await lines(dir)).length, 2, 'into a journal of its own');
        const reopened = await new OpLog(dir, { rollAfter: 100, sealApplied: true });
        assert.deepStrictEqual(
          reopened.since(undefined).map((entry) => [entry.seq, entry.op.origin, entry.op.id]),
          [
            [1, 'A', 'r1'],
            [2, 'B', 'fresh'],
          ],
          'the newer journal is read first: the failed line is a duplicate',
        );
      } finally {
        await cleanupTemp(dir);
      }
    },
  );

  await t.test('a scrub rewrites a journal a line per group; a roll begins a new one', async () => {
    const dir = await createTemp();
    try {
      const log = await new OpLog(dir, { rollAfter: 3, sealApplied: true });
      await log.append([op('A', 1, { id: 'secret', data: { pin: 1234 } })]);
      await log.append([op('A', 2, { id: 'other', data: { n: 1 } })]);
      assert.strictEqual(await log.scrub('secret'), 1);
      const [journal] = await lines(dir);
      const text = await fs.readFile(journal, 'utf8');
      assert.ok(!text.includes('1234'), 'the payload left the journal');
      assert.strictEqual(text.split('\n').filter(Boolean).length, 2, 'a line per group still');
      log.applied(1, 2);
      await log.append([op('A', 3, { id: 'other' })]);
      // The third group rolled: 1 and 2 sealed, 3 waits for its record.
      assert.strictEqual(log.segments, 1);
      await log.append([op('A', 4, { id: 'other' })]);
      const names = await lines(dir);
      assert.strictEqual(names.length, 2, 'the journal of group 3, and a new one begun after the roll');
    } finally {
      await cleanupTemp(dir);
    }
  });
});

test('a roll that fails after the append never holds up the group: the appends land, the next roll seals', async () => {
  const { memory } = require('../src/memory/memory.js');
  const base = memory();
  let failing = true;
  const fsi = {
    ...base,
    write: async (dir, name, text) => {
      if (failing && name.startsWith('seg-')) throw Object.assign(new Error('no space left'), { code: 'ENOSPC' });
      return base.write(dir, name, text);
    },
  };
  const events = [];
  const logger = { warn: (event) => events.push(event), error: (event) => events.push(event), info() {}, debug() {} };
  const log = await new OpLog('store', { fsi, rollAfter: 2, logger });
  const within = (promise) =>
    Promise.race([
      promise,
      new Promise((resolve, reject) => setTimeout(() => reject(new Error('still pending')), 2000).unref()),
    ]);
  // The second group triggers a roll; its segment cannot be written.
  await within(log.append([op('A', 1)]));
  await within(log.append([op('A', 2)]));
  await within(log.append([op('A', 3)]));
  assert.strictEqual(log.segments, 0, 'nothing sealed while the disk refuses');
  assert.ok(
    events.some((event) => event.event === 'log.roll.failed'),
    'the failed roll is said out loud',
  );
  assert.deepStrictEqual(
    log.since(undefined).map((entry) => entry.seq),
    [1, 2, 3],
  );
  // The disk is back: the next append's roll seals what waited.
  failing = false;
  await within(log.append([op('A', 4)]));
  assert.strictEqual(log.segments, 1);
  const reopened = await new OpLog('store', { fsi, rollAfter: 2 });
  assert.deepStrictEqual(
    reopened.since(undefined).map((entry) => entry.seq),
    [1, 2, 3, 4],
  );
});

test('a scrub cut short as it rewrites a journal loses no group and leaves no payload: the copy goes under a new name', async () => {
  const { memory } = require('../src/memory/memory.js');
  const base = memory();
  let tearNext = false;
  const fsi = {
    ...base,
    write: async (dir, name, text) => {
      if (tearNext && name.endsWith('.jsonl')) {
        tearNext = false;
        // The process dies half way through the file.
        await base.write(dir, name, text.slice(0, Math.floor(text.length / 2)));
        throw new Error('killed');
      }
      return base.write(dir, name, text);
    },
  };
  const onDisk = async () => {
    let text = '';
    for (const name of await fsi.list('store/log/open')) text += await fsi.read('store/log/open', name);
    return text;
  };
  const log = await new OpLog('store', { fsi, rollAfter: 100 });
  for (let seq = 1; seq <= 6; seq++) {
    await log.append([op('me', seq, seq === 2 ? { id: 'secret', data: { pin: 987654 } } : {})]);
  }
  assert.deepStrictEqual(log.vector, { me: 6 });
  tearNext = true;
  await assert.rejects(log.scrub('secret'), /killed/);
  assert.ok((await onDisk()).includes('987654'), 'the old journal still has it');
  const reopened = await new OpLog('store', { fsi, rollAfter: 100 });
  assert.strictEqual(reopened.next, 7, 'no seq of this node handed out twice');
  assert.deepStrictEqual(reopened.vector, { me: 6 });
  assert.deepStrictEqual(
    reopened.since(undefined).map((entry) => entry.seq),
    [1, 2, 3, 4, 5, 6],
  );
  assert.ok(!(await onDisk()).includes('987654'), 'the copy the scrub left behind went at the open');
  const again = await new OpLog('store', { fsi, rollAfter: 100 });
  assert.deepStrictEqual(
    again.since(undefined).map((entry) => entry.seq),
    [1, 2, 3, 4, 5, 6],
  );
  assert.strictEqual(again.since(undefined)[1].op.data, undefined, 'the payload stays scrubbed');
});

test('a journal line is a group whole or not at all: a failed group the group after it shadowed in part does not come back', async () => {
  const { memory } = require('../src/memory/memory.js');
  const base = memory();
  let failNext = false;
  const fsi = {
    ...base,
    append: async (dir, name, text) => {
      await base.append(dir, name, text);
      if (failNext) {
        failNext = false;
        // The bytes landed, the call failed (a lower layer refused it).
        throw new Error('layer down');
      }
    },
  };
  const log = await new OpLog('store', { fsi, rollAfter: 100 });
  await log.append([op('me', 1)]);
  failNext = true;
  await assert.rejects(log.append([op('me', 2), op('me', 3), op('me', 4)]), /layer down/);
  // The seqs go back: the next group is 2 alone.
  const [entry] = await log.append([op('me', 2, { id: 'after' })]);
  assert.strictEqual(entry.seq, 2);
  const reopened = await new OpLog('store', { fsi, rollAfter: 100 });
  assert.deepStrictEqual(
    reopened.since(undefined).map((e) => e.seq),
    [1, 2],
  );
  assert.strictEqual(reopened.since(undefined)[1].op.id, 'after');
  assert.strictEqual(reopened.next, 3, 'the failed group’s tail is not adopted');
  assert.deepStrictEqual(reopened.vector, { me: 2 });
});

test('groups applied out of order: a roll seals up to the oldest group not applied, whatever the holes after it', async () => {
  const { memory } = require('../src/memory/memory.js');
  const log = await new OpLog('store', { fsi: memory(), rollAfter: 1000, sealApplied: true });
  for (let seq = 1; seq <= 6; seq++) await log.append([op('A', seq)]);
  log.applied(2);
  log.applied(4, 5);
  await log.flush();
  assert.strictEqual(log.segments, 0, 'group 1 holds the roll');
  log.applied(1);
  await log.flush();
  assert.deepStrictEqual(
    log.tail().map((entry) => entry.seq),
    [3, 4, 5, 6],
    '1 and 2 sealed; 3 holds the rest',
  );
  log.applied(3);
  log.applied(6);
  await log.flush();
  assert.deepStrictEqual(log.tail(), []);
  // A seq marked twice, or outside every group, changes nothing.
  log.applied(3);
  log.applied(100);
  await log.append([op('A', 7)]);
  await log.flush();
  assert.deepStrictEqual(
    log.tail().map((entry) => entry.seq),
    [7],
  );
});

test('the index is written where compaction dropped something; the segments are what the directory lists', async () => {
  const { memory } = require('../src/memory/memory.js');
  const fsi = memory();
  let writes = 0;
  const write = fsi.write.bind(fsi);
  fsi.write = (dir, name, text, options) => {
    if (name === 'index.json') writes++;
    return write(dir, name, text, options);
  };
  const log = await new OpLog('/l', { fsi, rollAfter: 2, retention: 'all', logger: false });
  const opened = writes;
  for (let seq = 1; seq <= 12; seq++) await log.append([op('A', seq)]);
  await log.flush();
  assert.ok(log.segments >= 4, `rolled (${log.segments} segments)`);
  assert.strictEqual(writes, opened, 'a roll that dropped nothing writes no index');
  await log.close();
  const index = JSON.parse(await fsi.read('/l/log', 'index.json'));
  assert.strictEqual(index.segments, undefined, 'the index names no segment');
  // A reopen reads the segments from the listing, and the vector and heads from them.
  const again = await new OpLog('/l', { fsi, rollAfter: 2, retention: 'all', logger: false });
  assert.strictEqual(again.segments, log.segments);
  assert.deepStrictEqual(
    again.since(again.formatId(0)).map((entry) => entry.seq),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
  );
  assert.deepStrictEqual(again.vector, { A: 12 });
  assert.strictEqual(again.droppedTs, 0);
  await again.close();
  // A segment gone from the middle: a gap the next one's start shows.
  const names = (await fsi.list('/l/log')).filter((name) => name.startsWith('seg-')).sort();
  await fsi.remove('/l/log', names[1]);
  const events = [];
  const logger = { error: (event) => events.push(event), warn() {}, info() {}, debug() {} };
  const gapped = await new OpLog('/l', { fsi, rollAfter: 2, retention: 'all', logger });
  assert.strictEqual(events.filter((event) => event.event === 'log.segment.missing').length, 1);
  assert.strictEqual(gapped.droppedTs, gapped.latestTs, 'what it held is vouched for by nothing');
  await gapped.close();
});

test('a segment wholly below the floor is a compaction cut short: removed at open, never read back', async () => {
  const { memory } = require('../src/memory/memory.js');
  const fsi = memory();
  const log = await new OpLog('/l', { fsi, rollAfter: 1, retention: { ops: 2 }, logger: false });
  for (let seq = 1; seq <= 6; seq++) await log.append([op('A', seq)]);
  await log.close();
  const floor = log.floor;
  assert.ok(floor > 1);
  // The file of seqs before the floor comes back (a removal the crash cut short).
  const { checksum } = require('../src/hash.js');
  const entries = JSON.stringify([{ seq: 1, op: op('A', 1) }]);
  await fsi.write('/l/log', 'seg-0000000001.json', `{"entries":${entries},"hash":"${checksum(entries)}"}`);
  const reopened = await new OpLog('/l', { fsi, rollAfter: 1, retention: { ops: 2 }, logger: false });
  assert.strictEqual(reopened.floor, floor);
  assert.ok(!(await fsi.list('/l/log')).includes('seg-0000000001.json'));
  assert.ok(reopened.since(reopened.formatId(floor - 1)).every((entry) => entry.seq >= floor));
  assert.strictEqual(reopened.since(reopened.formatId(0)), null, 'below the floor: a bootstrap, as before');
  assert.strictEqual(reopened.droppedTs, log.droppedTs, 'nothing lost');
  await reopened.close();
});
