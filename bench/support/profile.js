'use strict';

/**
 * A CPU profile of one workload, taken in the process that runs it
 * (node:inspector — no file is written) and summed up: the self time of
 * every file and of every function, the files of the checkout shown by their
 * path under it, the rest by their URL (`(native)` for V8's own: the garbage
 * collector, `(program)`). What `node bench/write.js --profile <row>` prints;
 * any bench can hand it a workload.
 *
 * `profile(run, { root, interval, top })` runs `await run()` under the
 * sampler (`interval` µs between samples, 50 by default) and resolves to
 * `{ samples, files, functions }` — each a list of `[name, share]` from the
 * largest share down, `top` long; `print(summary, title)` writes it out.
 */

const path = require('node:path');
const inspector = require('node:inspector/promises');

const tally = (map, key, count) => map.set(key, (map.get(key) ?? 0) + count);

const largest = (map, total, top) => {
  const rows = [];
  for (const [key, count] of map) rows.push([key, count / total]);
  rows.sort((a, b) => b[1] - a[1]);
  return rows.slice(0, top);
};

const profile = async (run, { root = path.join(__dirname, '..', '..'), interval = 50, top = 30 } = {}) => {
  const session = new inspector.Session();
  session.connect();
  let taken = null;
  try {
    await session.post('Profiler.enable');
    await session.post('Profiler.setSamplingInterval', { interval });
    await session.post('Profiler.start');
    try {
      await run();
    } finally {
      ({ profile: taken } = await session.post('Profiler.stop'));
    }
  } finally {
    session.disconnect();
  }
  const counts = new Map();
  for (const id of taken.samples) tally(counts, id, 1);
  const prefix = `file://${root}${path.sep}`;
  const files = new Map();
  const functions = new Map();
  let total = 0;
  for (const node of taken.nodes) {
    const count = counts.get(node.id) ?? 0;
    if (count === 0) continue;
    total += count;
    const { url, functionName, lineNumber } = node.callFrame;
    const file = url === '' ? '(native)' : url.startsWith(prefix) ? url.slice(prefix.length) : url;
    tally(files, file, count);
    tally(functions, `${functionName || '(anonymous)'} ${file}:${lineNumber + 1}`, count);
  }
  return { samples: total, files: largest(files, total, top), functions: largest(functions, total, top) };
};

const print = (summary, title) => {
  const share = (value) => `${(value * 100).toFixed(1).padStart(5)}%`;
  console.log(`\n${title} — ${summary.samples} samples`);
  console.log('  by file (self time)');
  for (const [file, value] of summary.files) console.log(`    ${share(value)}  ${file}`);
  console.log('  by function (self time)');
  for (const [name, value] of summary.functions) console.log(`    ${share(value)}  ${name}`);
};

module.exports = { profile, print };
