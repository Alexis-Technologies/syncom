/**
 * Runs every benchmark script in this directory, one child process at a
 * time, so `pnpm bench` always covers the full `bench/` folder instead of
 * a single hardcoded entry point. `compare.js` and `report.js` are not
 * subjects: they have their own scripts (`pnpm bench:compare`,
 * `pnpm bench:report`).
 *
 * `pnpm bench --save` also writes every row to bench/results/engine.json,
 * with the machine it ran on — what the charts of docs/guide/benchmarks.md
 * show. `pnpm bench storage log` runs those subjects only.
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { describeMachine } = require('./support/machine.js');

const SKIP = new Set([path.basename(__filename), 'compare.js', 'report.js']);
const OUT = path.join(__dirname, 'results', 'engine.json');

const args = process.argv.slice(2);
const save = args.includes('--save');
const only = args.filter((arg) => !arg.startsWith('--'));

const files = fs
  .readdirSync(__dirname)
  .filter((file) => file.endsWith('.js') && !SKIP.has(file))
  .filter((file) => !only.length || only.includes(path.basename(file, '.js')))
  .sort();

const rows = save ? path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'syncom-bench-')), 'rows.jsonl') : null;
const env = rows ? { ...process.env, SYNCOM_BENCH_OUT: rows } : process.env;

for (const file of files) {
  console.log(`\n=== ${file} ===\n`);
  const result = spawnSync(process.execPath, [path.join(__dirname, file)], { stdio: 'inherit', env });
  if (result.status !== 0) process.exitCode = result.status ?? 1;
}

if (rows && fs.existsSync(rows)) {
  const fresh = fs
    .readFileSync(rows, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  // A partial run (`pnpm bench --save storage`) keeps the other subjects.
  let results = [];
  try {
    results = JSON.parse(fs.readFileSync(OUT, 'utf8')).results;
  } catch {
    // the first run
  }
  const subjects = new Set(fresh.map((row) => row.subject));
  results = [...results.filter((row) => !subjects.has(row.subject)), ...fresh];
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const report = { generatedAt: new Date().toISOString(), machine: describeMachine(), results };
  fs.writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`);
  fs.rmSync(path.dirname(rows), { recursive: true, force: true });
  console.log(`\nWrote ${path.relative(path.join(__dirname, '..'), OUT)}`);
}
