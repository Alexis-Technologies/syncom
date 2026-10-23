/**
 * `Emitter.emit` — the notification path for every mutation that goes through
 * a live `Record`: `Storage.set`, `Storage.update` and `Storage.swap` all end
 * in `#emitUpdate`, and a record property setter emits on every assignment.
 * Real call sites have exactly one synchronous listener, so that row is the
 * number that matters; the rest exist to show what the generic path costs by
 * comparison.
 *
 * The awaited rows measure dispatch + settle. The fire-and-forget row measures
 * what `void emitter.emit(...)` costs where nobody awaits — the allocation,
 * not the microtask drain — so it is batched inside a single iteration with
 * opsPerIteration, because the harness awaits fn().
 *
 * Run with `node bench/emitter.js` or `pnpm bench`.
 */

'use strict';

const { bench } = require('./support/harness.js');
const { Emitter } = require('../src/utils.js');

const BATCH = 1000;

let sink = 0;
const sync = (value) => {
  sink += value;
};

const main = async () => {
  console.log(`Emitter benchmark — Node ${process.version}\n`);

  {
    const emitter = new Emitter();
    let i = 0;
    await bench('emit awaited — 0 listeners', () => emitter.emit('update', i++));
  }
  {
    const emitter = new Emitter();
    emitter.on('update', sync);
    let i = 0;
    await bench('emit awaited — 1 sync listener', () => emitter.emit('update', i++));
  }
  {
    // What Storage actually emits: (data, delta).
    const emitter = new Emitter();
    emitter.on('update', (data, delta) => void (sink += data.v + delta.v));
    const data = { v: 1 };
    const delta = { v: 1 };
    await bench('emit awaited — 1 listener, (data, delta)', () => emitter.emit('update', data, delta));
  }
  {
    const emitter = new Emitter();
    emitter.on('update', async (value) => {
      sink += value;
    });
    let i = 0;
    await bench('emit awaited — 1 async listener', () => emitter.emit('update', i++));
  }
  {
    const emitter = new Emitter();
    emitter.on('update', sync);
    emitter.on('update', (value) => void (sink -= value));
    let i = 0;
    await bench('emit awaited — 2 sync listeners', () => emitter.emit('update', i++));
  }
  {
    const emitter = new Emitter();
    emitter.on('update', sync);
    let i = 0;
    await bench(
      'emit fire-and-forget — 1 sync listener',
      async () => {
        for (let n = 0; n < BATCH; n++) void emitter.emit('update', i++);
      },
      { opsPerIteration: BATCH },
    );
  }

  if (sink === Number.MIN_SAFE_INTEGER) console.log('unreachable');
};

void main();
