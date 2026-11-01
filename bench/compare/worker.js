'use strict';

/**
 * Runs ONE (library, scenario) pair in a fresh process, so no library's JIT
 * feedback, heap or open handles leak into the next one. It seeds a store,
 * checks that the library does what the scenario says (a record reads back
 * as written, an update shows, a counter adds up, a replica holds every
 * record), then measures. Prints one JSON line: `{ median, min, max,
 * samples }`, or `{ unsupported: reason }`.
 *
 * Usage (spawned by bench/compare.js): node bench/compare/worker.js '<json options>'
 */

const fs = require('node:fs/promises');
const { writeFileSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { getAdapter } = require('./adapters/index.js');
const { getScenario, SEED, BULK, LIST, recordOf } = require('./scenarios.js');
const { measureOps, measureRounds } = require('./measure.js');
const { loadTrace } = require('./trace.js');

const FIELDS = ['title', 'done', 'priority', 'owner', 'hits'];
const TEXT_KINDS = new Set(['append', 'prepend', 'random']);
const LIST_KINDS = new Set(['list-push', 'list-insert', 'list-remove', 'list-set', 'list-move']);

// What a line lacks for a kind, known before anything is opened or seeded.
const lacking = (kind, line) => {
  if (line.only !== undefined && !line.only.kinds.includes(kind)) return line.only.why;
  if ((TEXT_KINDS.has(kind) || kind === 'trace') && !line.text) return 'no text that merges by position';
  if (LIST_KINDS.has(kind) && !line.list) return 'no list that merges by position';
  return null;
};

// A seeded generator, so every library types at the same random places.
const lcg = (seed) => {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
};

// The answer goes to the file bench/compare.js names (stdout belongs to the
// libraries' chatter), or to stdout when the worker runs by hand.
const answer = (result) => {
  const text = `${JSON.stringify(result)}\n`;
  if (process.env.SYNCOM_COMPARE_OUT) writeFileSync(process.env.SYNCOM_COMPARE_OUT, text);
  else process.stdout.write(text);
};

const fail = (adapter, scenario, message) => {
  throw new Error(`${adapter.id} on ${scenario.id}: ${message}`);
};

// The record as the scenario sees it: the five fields, whatever metadata a
// library keeps next to them (_id, _rev, Gun's `_`) left out.
const fieldsOf = (value) => {
  if (!value) return null;
  const out = {};
  for (const key of FIELDS) out[key] = value[key];
  return out;
};

const same = (a, b) => JSON.stringify(fieldsOf(a)) === JSON.stringify(fieldsOf(b));

const settle = async (value) => (value && typeof value.then === 'function' ? await value : value);

const seed = async (store, count, offset = 0) => {
  const records = [];
  for (let i = 0; i < count; i++) records.push(recordOf(offset + i));
  if (store.bulk) return store.bulk(records);
  const ids = [];
  for (const record of records) ids.push(await settle(store.insert(record)));
  return ids;
};

const expectRecord = async (adapter, scenario, store, id, expected, what) => {
  const actual = await settle(store.get(id));
  if (!same(actual, expected)) {
    fail(adapter, scenario, `${what}: expected ${JSON.stringify(fieldsOf(expected))}, got ${JSON.stringify(actual)}`);
  }
};

// A list of LIST numbers, checked to do what the scenario says — an element
// pushed, inserted, removed, set, moved reads back where it should — then
// edited one element at a time. Indices are seeded, the same for every library.
const measureList = async (adapter, scenario, line, store, method) => {
  const { kind } = scenario;
  const initial = [];
  for (let i = 0; i < LIST; i++) initial.push(i);
  const list = await line.list(store, initial, kind);
  if (kind === 'list-set' && !list.set) return { unsupported: 'no element of its own to set' };
  if (kind === 'list-move' && !list.move) return { unsupported: 'no move' };
  const expect = async (index, value, what) => {
    const read = await settle(list.read());
    if (read[index] !== value) {
      fail(adapter, scenario, `${what}: index ${index} reads ${read[index]}, expected ${value}`);
    }
    return read;
  };
  const read = await expect(LIST - 1, LIST - 1, 'a seeded list');
  if (read.length !== LIST) fail(adapter, scenario, `a seeded list reads ${read.length} elements, expected ${LIST}`);
  await settle(list.push(-1));
  await expect(LIST, -1, 'a pushed element');
  await settle(list.insert(1, -2));
  await expect(1, -2, 'an inserted element');
  await settle(list.remove(1));
  await expect(1, 1, 'an element after a removal');
  if (list.set) {
    await settle(list.set(2, -3));
    await expect(2, -3, 'a set element');
  }
  if (list.move) {
    const before = await settle(list.read());
    await settle(list.move(0, 3));
    await expect(3, before[0], 'a moved element');
  }
  let length = LIST + 1;
  const random = lcg(LIST);
  const index = (n) => Math.floor(random() * n);
  if (kind === 'list-push') return measureOps((i) => list.push(i), method);
  if (kind === 'list-insert') {
    return measureOps((i) => {
      const wait = list.insert(index(length + 1), i);
      length++;
      return wait;
    }, method);
  }
  if (kind === 'list-remove') {
    return measureOps((i) => {
      const wait = list.remove(index(length));
      return wait && typeof wait.then === 'function' ? wait.then(() => list.push(i)) : list.push(i);
    }, method);
  }
  if (kind === 'list-set') return measureOps((i) => list.set(index(length), i), method);
  return measureOps(() => list.move(index(length), index(length)), method);
};

const measureKind = async (adapter, scenario, line, store, ids, dir, method) => {
  const { kind } = scenario;
  if (kind === 'insert') {
    const id = await settle(store.insert(recordOf(-1)));
    await expectRecord(adapter, scenario, store, id, recordOf(-1), 'an inserted record');
    return measureOps((i) => store.insert(recordOf(SEED + i)), method);
  }
  if (kind === 'update') {
    await settle(store.update(ids[1], { done: true }));
    await expectRecord(adapter, scenario, store, ids[1], { ...recordOf(1), done: true }, 'an updated record');
    await settle(store.update(ids[1], { done: false }));
    await expectRecord(adapter, scenario, store, ids[1], recordOf(1), 'an updated record');
    // Every pass over the records flips the field, so no update is a no-op.
    return measureOps((i) => store.update(ids[i % SEED], { done: Math.floor(i / SEED) % 2 === 0 }), method);
  }
  if (kind === 'get') {
    await expectRecord(adapter, scenario, store, ids[SEED - 1], recordOf(SEED - 1), 'a seeded record');
    return measureOps((i) => store.get(ids[i % SEED]), method);
  }
  if (kind === 'inc') {
    if (!store.inc) return { unsupported: 'no counter that converges' };
    for (let i = 0; i < 3; i++) await settle(store.inc(ids[2], 'hits', 1));
    await expectRecord(adapter, scenario, store, ids[2], { ...recordOf(2), hits: 3 }, 'a counter incremented 3 times');
    return measureOps((i) => store.inc(ids[i % SEED], 'hits', 1), method);
  }
  if (kind === 'bulk') {
    let offset = SEED * 10;
    return measureRounds(
      {
        prepare: () => {
          const records = [];
          for (let i = 0; i < BULK; i++) records.push(recordOf(offset + i));
          return records;
        },
        run: async (records) => {
          records.ids = await store.bulk(records);
          return BULK;
        },
        after: async (records) => {
          if (records.ids.length !== BULK) fail(adapter, scenario, `bulk returned ${records.ids.length} ids`);
          await expectRecord(adapter, scenario, store, records.ids[BULK - 1], records[BULK - 1], 'the last of a batch');
          offset += BULK;
        },
      },
      method,
    );
  }
  if (TEXT_KINDS.has(kind)) {
    if (!line.text) return { unsupported: 'no text that merges by position' };
    const text = await line.text(store);
    await settle(text.insert(0, 'ab'));
    await settle(text.insert(1, 'c'));
    const read = await settle(text.read());
    if (read !== 'acb') fail(adapter, scenario, `a text reads "${read}" after inserting "ab" then "c" at 1`);
    let length = 3;
    const random = lcg(SEED);
    const at =
      kind === 'append' ? () => length : kind === 'prepend' ? () => 0 : () => Math.floor(random() * (length + 1));
    return measureOps(() => {
      const wait = text.insert(at(), 'x');
      length++;
      return wait;
    }, method);
  }
  if (LIST_KINDS.has(kind)) return measureList(adapter, scenario, line, store, method);
  if (kind === 'trace') {
    if (!line.text) return { unsupported: 'no text that merges by position' };
    const { edits, finalText } = await loadTrace();
    // The worker runs with --expose-gc: the heap the trace leaves behind,
    // measured after a collection, goes out with the rate.
    const gc = typeof globalThis.gc === 'function' ? globalThis.gc : null;
    let memory = null;
    const result = await measureRounds(
      {
        prepare: (r) => line.text(store, `trace-${r}`),
        run: async (text) => {
          if (gc) gc();
          const before = process.memoryUsage().heapUsed;
          // Keystrokes go out as an editor sends them: one after another,
          // without waiting for each — a library that answers with a
          // promise is awaited every thousand and at the end.
          let pending = null;
          for (let i = 0; i < edits.length; i++) {
            const edit = edits[i];
            if (edit[1] > 0) pending = text.delete(edit[0], edit[1]);
            if (edit.length > 2) pending = text.insert(edit[0], edit.length === 3 ? edit[2] : edit.slice(2).join(''));
            if ((i & 1023) === 1023 && pending && typeof pending.then === 'function') await pending;
          }
          await settle(pending);
          if (gc) {
            gc();
            memory = process.memoryUsage().heapUsed - before;
          }
          return edits.length;
        },
        after: async (text) => {
          const read = await settle(text.read());
          if (read !== finalText) {
            fail(adapter, scenario, `the trace reads back ${read.length} characters, expected ${finalText.length}`);
          }
        },
      },
      { rounds: method.traceRounds ?? 2, warmupRounds: method.traceWarmupRounds ?? 1 },
    );
    return memory === null ? result : { ...result, memory };
  }
  if (kind === 'sync') {
    if (!line.replicate) return { unsupported: line.noSync ?? 'no in-process sync' };
    return measureRounds(
      {
        prepare: (r) => line.openReplica(path.join(dir, `replica-${r}`), store),
        run: async (replica) => {
          await line.replicate(store, replica);
          return SEED;
        },
        after: async (replica) => {
          for (let i = 0; i < SEED; i++) {
            await expectRecord(adapter, scenario, replica, ids[i], recordOf(i), 'a replicated record');
          }
          await replica.close();
        },
      },
      method,
    );
  }
  throw new Error(`unknown scenario kind "${kind}"`);
};

const main = async () => {
  const options = JSON.parse(process.argv[2]);
  const adapter = getAdapter(options.adapter);
  const scenario = getScenario(options.scenario);
  const line = adapter.lines[scenario.line];
  if (!line) {
    answer({ unsupported: adapter.unsupported?.[scenario.line] ?? 'no such storage' });
    return;
  }
  const lacks = lacking(scenario.kind, line);
  if (lacks) {
    answer({ unsupported: lacks });
    return;
  }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `syncom-compare-${adapter.id}-`));
  let store = null;
  try {
    store = await line.open(path.join(dir, 'store'));
    const ids = await seed(store, SEED);
    if (ids.length !== SEED) fail(adapter, scenario, `seeding returned ${ids.length} ids`);
    await expectRecord(adapter, scenario, store, ids[0], recordOf(0), 'a seeded record');
    const result = await measureKind(adapter, scenario, line, store, ids, dir, options);
    answer(result);
  } finally {
    if (store) await store.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
};

main().then(
  // Some libraries keep timers or sockets alive after close().
  () => process.exit(0),
  (error) => {
    process.stderr.write(`${error?.stack ?? error}\n`);
    process.exit(1);
  },
);
