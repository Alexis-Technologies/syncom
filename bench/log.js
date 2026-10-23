/**
 * `OpLog` — the operation log every write and every replicated op goes
 * through. `append` is one small file write per batch; `since` is an
 * in-memory slice by seq. A roll seals the open files into a segment and is
 * the one operation that touches many files at once.
 *
 * Writes go to a temp directory that is removed on exit.
 *
 * Run with `node bench/log.js` or `pnpm bench`.
 */

'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { bench } = require('./support/harness.js');
const { OpLog } = require('../src/log.js');

const op = (seq) => ({ origin: 'bench', seq, ts: seq, type: 'set', id: `r${seq % 100}`, data: { v: seq } });

const main = async () => {
  console.log(`OpLog benchmark — Node ${process.version}\n`);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'syncom-bench-log-'));

  try {
    // Default roll cadence, unbounded retention: a realistic log that seals
    // as it grows, so the reopen row reads segments, not thousands of files.
    const log = await new OpLog(root, { retention: { ops: 1_000_000 } });
    let seq = 0;

    await bench('append — one op', () => log.append([op(++seq)]), { warmup: 20 });
    await bench(
      'append — batch of 100',
      () => {
        const batch = [];
        for (let i = 0; i < 100; i++) batch.push(op(++seq));
        return log.append(batch);
      },
      { warmup: 5, measureMs: 300, opsPerIteration: 100 },
    );

    const cursor = log.formatId(Math.max(1, log.next - 500));
    await bench('since — last 500 entries', () => log.since(cursor));
    await bench('since — everything (no cursor)', () => log.since(undefined), { measureMs: 500 });
    await bench('since — 20 from the middle, scoped', () =>
      log.since(log.formatId(1000), { scopes: ['x'], limit: 20 }));

    const rolling = await new OpLog(path.join(root, 'rolling'), { rollAfter: 8, retention: { ops: 10_000 } });
    let n = 0;
    await bench('append with a roll every 8 batches', () => rolling.append([op(++n)]), { warmup: 16, measureMs: 500 });

    await log.flush();
    await bench(
      'reopen — index + segments + tail',
      async () => {
        const reopened = await new OpLog(root, { retention: { ops: 1_000_000 } });
        return reopened.length;
      },
      { warmup: 1, measureMs: 500 },
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
