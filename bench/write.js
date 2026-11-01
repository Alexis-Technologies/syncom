/**
 * The write path, one awaited write at a time, through the storage an
 * application opens — the pure build bench/compare's `syncom` row opens: the
 * core with the text and sync plugins, `defer: 16`, no signatures, no chain.
 * A counter's `inc()` is the pipeline with next to nothing to apply; a
 * field's `update()`; a keystroke at the end, the start and anywhere of a
 * text; a push onto a list of 10 000; the same keystroke pipelined by 1 024
 * and 64 of them as one transaction. In memory (`memory()`) and on disk
 * (`node:fs`, a temporary directory).
 *
 * Flags:
 * - `--detail` also counts, per row, the promises one write makes (an
 *   async_hooks PROMISE count over a thousand writes) and the bytes it leaves
 *   in the memory backend once flushed;
 * - `--profile <row>` (a row's name or a part of it) prints a CPU profile of
 *   that row by src/ file and function (bench/support/profile.js) instead of
 *   timing every row;
 * - `SYNCOM_BENCH_ROOT=<checkout>` measures another checkout's code — the
 *   baseline of an A/B — with this file's workloads.
 *
 * Run with `node bench/write.js` or `pnpm bench write`.
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHook } = require('node:async_hooks');
const { bench } = require('./support/harness.js');
const { profile, print } = require('./support/profile.js');

const ROOT = process.env.SYNCOM_BENCH_ROOT ? path.resolve(process.env.SYNCOM_BENCH_ROOT) : path.join(__dirname, '..');
const { open } = require(path.join(ROOT, 'index.js'));
const { text } = require(path.join(ROOT, 'src', 'text', 'text.js'));
const { sync } = require(path.join(ROOT, 'src', 'sync', 'sync.js'));
const { memory } = require(path.join(ROOT, 'src', 'memory', 'memory.js'));

const LIST = 10_000;
const PIPELINE = 1_024;
const TRANSACTION = 64;

const args = process.argv.slice(2);
const detail = args.includes('--detail');
const profiled = args.includes('--profile') ? (args[args.indexOf('--profile') + 1] ?? '') : null;

// A seeded index: the same places every run.
const rng = (seed) => () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 2 ** 32;
};

const dirs = [];
const storageOn = async (line) => {
  if (line === 'memory') {
    const fsi = memory();
    const storage = await open({ path: '/bench/write', fsi, logger: false, lock: false, plugins: [text, sync] });
    return { storage, fsi };
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'syncom-bench-write-'));
  dirs.push(dir);
  const storage = await open({ path: dir, logger: false, lock: false, plugins: [text, sync] });
  return { storage, fsi: null };
};

// Every workload: `prepare(storage)` (untimed) makes what it writes to and
// hands back `write()`, one write — or `per` of them, for a pipeline and a
// transaction — awaited.
const WORKLOADS = [
  {
    name: 'inc — a counter, awaited',
    prepare: async (storage) => {
      const id = await storage.insert({ title: 'counter' });
      return () => storage.inc(id, 'hits', 1);
    },
  },
  {
    name: 'update — one field, awaited',
    prepare: async (storage) => {
      const id = await storage.insert({ title: 'task', done: false });
      let done = false;
      return () => storage.update(id, { done: (done = !done) });
    },
  },
  {
    name: 'splice — a keystroke at the end of a text, awaited',
    prepare: async (storage) => {
      const id = await storage.insert({ kind: 'text' });
      let length = 0;
      return () => storage.splice(id, 'body', length++, 0, 'x');
    },
  },
  {
    name: 'splice — a keystroke at the start of a text, awaited',
    prepare: async (storage) => {
      const id = await storage.insert({ kind: 'text' });
      return () => storage.splice(id, 'body', 0, 0, 'x');
    },
  },
  {
    name: 'splice — a keystroke anywhere in a text (seeded), awaited',
    prepare: async (storage) => {
      const id = await storage.insert({ kind: 'text' });
      const random = rng(7);
      let length = 0;
      return () => storage.splice(id, 'body', Math.floor(random() * ++length), 0, 'x');
    },
  },
  {
    name: `splice — keystrokes at the end, pipelined by ${PIPELINE.toLocaleString('en-US')}`,
    per: PIPELINE,
    prepare: async (storage) => {
      const id = await storage.insert({ kind: 'text' });
      let length = 0;
      return () => {
        let last = null;
        for (let i = 0; i < PIPELINE; i++) last = storage.splice(id, 'body', length++, 0, 'x');
        return last;
      };
    },
  },
  {
    name: `transact — ${TRANSACTION} keystrokes at the end as one transaction`,
    per: TRANSACTION,
    prepare: async (storage) => {
      const id = await storage.insert({ kind: 'text' });
      let length = 0;
      return () =>
        storage.transact(async (tx) => {
          for (let i = 0; i < TRANSACTION; i++) await tx.splice(id, 'body', length++, 0, 'x');
        });
    },
  },
  {
    name: `push — one element onto a list of ${LIST.toLocaleString('en-US')}, awaited`,
    prepare: async (storage) => {
      const id = await storage.insert({ kind: 'list' });
      const initial = [];
      for (let i = 0; i < LIST; i++) initial.push(i);
      await storage.push(id, 'items', initial);
      let next = LIST;
      return () => storage.push(id, 'items', [next++]);
    },
  },
];

// Which workloads run on disk too: the counter (the pipeline alone) and the
// common keystroke.
const ON_DISK = new Set([WORKLOADS[0].name, WORKLOADS[2].name]);

const bytesOf = (fsi) => {
  let bytes = 0;
  for (const content of Object.values(fsi.dump())) bytes += content.length;
  return bytes;
};

// The promises one write makes, and the bytes it leaves in memory once flushed.
const details = async (workload) => {
  const { storage, fsi } = await storageOn('memory');
  try {
    const write = await workload.prepare(storage);
    const per = workload.per ?? 1;
    const rounds = Math.max(1, Math.round(1_000 / per));
    for (let i = 0; i < rounds; i++) await write();
    await storage.flush();
    let promises = 0;
    const hook = createHook({
      init(_id, type) {
        if (type === 'PROMISE') promises++;
      },
    });
    const before = bytesOf(fsi);
    hook.enable();
    for (let i = 0; i < rounds; i++) await write();
    hook.disable();
    await storage.flush();
    const writes = rounds * per;
    const bytes = (bytesOf(fsi) - before) / writes;
    console.log(
      `${workload.name.padEnd(64)} ${(promises / writes).toFixed(1).padStart(7)} promises ${Math.round(bytes)
        .toString()
        .padStart(6)} bytes per write`,
    );
  } finally {
    await storage.close();
  }
};

const main = async () => {
  console.log(
    `Write path benchmark — Node ${process.version}${ROOT === path.join(__dirname, '..') ? '' : ` — ${ROOT}`}\n`,
  );
  if (profiled !== null) {
    const workload = WORKLOADS.find((candidate) => candidate.name.includes(profiled)) ?? WORKLOADS[2];
    const { storage } = await storageOn('memory');
    const write = await workload.prepare(storage);
    for (let i = 0; i < 2_000; i++) await write();
    const summary = await profile(
      async () => {
        const end = Date.now() + 2_000;
        while (Date.now() < end) await write();
      },
      { root: ROOT },
    );
    print(summary, `${workload.name} (memory)`);
    await storage.close();
    return;
  }
  for (const line of ['memory', 'disk']) {
    for (const workload of WORKLOADS) {
      if (line === 'disk' && !ON_DISK.has(workload.name)) continue;
      const { storage } = await storageOn(line);
      const write = await workload.prepare(storage);
      await bench(`${workload.name}, ${line === 'memory' ? 'memory()' : 'node:fs'}`, write, {
        opsPerIteration: workload.per ?? 1,
        warmup: workload.per ? 4 : 200,
      });
      await storage.close();
    }
  }
  if (detail) {
    console.log('\nPer write, in memory:');
    for (const workload of WORKLOADS) await details(workload);
  }
};

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  });
