'use strict';

/**
 * The sampling the comparison workers share. Two shapes of measurement:
 *
 * - `measureOps(op, method)` — one small operation called again and again
 *   (insert, update, get, inc). Calls run in chunks, grown during the warmup
 *   until a chunk takes about a millisecond, so reading the clock never
 *   dominates a call of a few hundred nanoseconds; a sample stops after
 *   `sampleMs` or `maxOps` calls, whichever comes first, so a fast library
 *   does not grow its store a hundred times larger than a slow one's.
 *   A result that is a promise is awaited before the next call — one write
 *   in flight at a time, as an application that awaits its writes has.
 * - `measureRounds(round, method)` — one round is a whole job (insert a
 *   batch, replicate a store) that reports how many records it moved; the
 *   rate of a round is records per second.
 *
 * Both report the median of their samples, with the spread.
 */

const { performance } = require('node:perf_hooks');

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

const MAX_CHUNK = 1 << 12;

const summary = (rates) => ({
  median: median(rates),
  min: Math.min(...rates),
  max: Math.max(...rates),
  samples: rates,
});

// A thenable result is awaited; a plain one is not, so a synchronous library
// pays no microtask per call.
const runChunk = async (op, from, count) => {
  for (let i = from; i < from + count; i++) {
    const result = op(i);
    if (result && typeof result.then === 'function') await result;
  }
};

const measureOps = async (op, { warmupMs, sampleMs, samples, maxOps }) => {
  let next = 0;
  let chunk = 1;
  const warmupEnd = performance.now() + warmupMs;
  while (performance.now() < warmupEnd) {
    const start = performance.now();
    await runChunk(op, next, chunk);
    next += chunk;
    if (performance.now() - start < 1 && chunk < MAX_CHUNK) chunk *= 2;
  }
  chunk = Math.min(chunk, maxOps);
  const rates = [];
  for (let s = 0; s < samples; s++) {
    let count = 0;
    let elapsed = 0;
    const start = performance.now();
    do {
      await runChunk(op, next, chunk);
      next += chunk;
      count += chunk;
      elapsed = performance.now() - start;
    } while (elapsed < sampleMs && count + chunk <= maxOps);
    rates.push((count / elapsed) * 1000);
  }
  return summary(rates);
};

// `prepare(r)` (untimed) builds what round `r` needs — an empty replica, a
// batch of records — `run(prepared, r)` is timed and returns how many
// records it moved, `after(prepared, r)` (untimed) checks the round's work
// and releases it. Every round is checked, the warmup ones included.
const measureRounds = async ({ prepare, run, after }, { rounds, warmupRounds }) => {
  const rates = [];
  for (let r = 0; r < warmupRounds + rounds; r++) {
    const prepared = await prepare(r);
    const start = performance.now();
    const records = await run(prepared, r);
    const elapsed = performance.now() - start;
    await after(prepared, r);
    if (r >= warmupRounds) rates.push((records / elapsed) * 1000);
  }
  return summary(rates);
};

module.exports = { measureOps, measureRounds, median };
