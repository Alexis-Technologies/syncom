'use strict';

/**
 * The cross-library comparison: the scenarios of bench/compare/scenarios.js
 * (insert, update, read, a converging counter, a batch, replicating a store;
 * in memory and on disk), implemented the way each library's documentation
 * shows under bench/compare/adapters, plus a cold start on disk. The
 * libraries are installed on their own, in bench/compare (`pnpm
 * bench:compare:install`), so syncom's devDependencies stay as they are.
 * The results land in bench/results/compare.json, which feeds the charts and
 * the tables of the docs and the README (`pnpm bench:report`).
 *
 * Run: pnpm bench:compare [--only yjs,loro] [--scenarios insert,sync-disk]
 *        [--samples 5] [--sample-ms 1000] [--warmup-ms 1000] [--max-ops 5000]
 *        [--rounds 5] [--warmup-rounds 1] [--cold-runs 10] [--no-write]
 *
 * The method, also published with the results in docs/guide/benchmarks.md:
 * - every (library, scenario) pair runs in a FRESH process, in a fresh
 *   temporary directory, so no library's JIT feedback, heap or handles leak
 *   into the next measurement;
 * - before anything is timed the store is seeded and the library must give
 *   the scenario's answers (a record reads back as written, an update shows,
 *   a counter adds up, a replica reads every record); a mismatch aborts;
 * - after a warmup, operations are timed in samples (rounds for a batch or a
 *   replication) and the median is reported with the spread.
 *
 * `--scenarios` takes scenario ids (`sync-disk`), kinds (`sync`) or lines
 * (`memory`).
 */

const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseArgs } = require('node:util');

const { describeMachine } = require('./support/machine.js');

const ROOT = path.join(__dirname, '..');
const COMPARE = path.join(__dirname, 'compare');
const OUT = path.join(__dirname, 'results', 'compare.json');
const WORKER_TIMEOUT = 5 * 60 * 1000;

if (!fs.existsSync(path.join(COMPARE, 'node_modules'))) {
  console.error('The libraries are not installed: run `pnpm bench:compare:install` first.');
  process.exit(1);
}

const { ADAPTERS } = require('./compare/adapters/index.js');
const { SCENARIOS } = require('./compare/scenarios.js');
const { median } = require('./compare/measure.js');

const { values: args } = parseArgs({
  options: {
    only: { type: 'string' },
    scenarios: { type: 'string' },
    samples: { type: 'string', default: '5' },
    'sample-ms': { type: 'string', default: '1000' },
    'warmup-ms': { type: 'string', default: '1000' },
    'max-ops': { type: 'string', default: '5000' },
    rounds: { type: 'string', default: '5' },
    'warmup-rounds': { type: 'string', default: '1' },
    'cold-runs': { type: 'string', default: '10' },
    'no-write': { type: 'boolean', default: false },
  },
});

const list = (value) => (value ? value.split(',').map((item) => item.trim()) : null);

const method = {
  warmupMs: Number(args['warmup-ms']),
  sampleMs: Number(args['sample-ms']),
  samples: Number(args.samples),
  maxOps: Number(args['max-ops']),
  rounds: Number(args.rounds),
  warmupRounds: Number(args['warmup-rounds']),
  coldStartRuns: Number(args['cold-runs']),
};

const versionOf = (name) => {
  const file = path.join(COMPARE, 'node_modules', name, 'package.json');
  return JSON.parse(fs.readFileSync(file, 'utf8')).version;
};

const libraryInfo = (adapter) => ({
  id: adapter.id,
  name: adapter.name,
  package: adapter.package,
  version: adapter.version ? adapter.version() : versionOf(adapter.package),
  url: adapter.url,
  lines: Object.fromEntries(Object.entries(adapter.lines).map(([line, spec]) => [line, spec.variant])),
});

const format = (value) => Math.round(value).toLocaleString('en-US');

// A worker writes its answer to the file named in SYNCOM_COMPARE_OUT. Its
// stdout is ignored: libraries print greetings and warnings there (GUN prints
// a line per empty key, enough to overflow any buffer), and only the tail of
// stderr is kept for the error.
const worker = (script, argv) =>
  new Promise((resolve, reject) => {
    const out = path.join(os.tmpdir(), `syncom-compare-${randomUUID()}.json`);
    const child = spawn(process.execPath, [path.join(COMPARE, script), ...argv], {
      cwd: os.tmpdir(),
      stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...process.env, SYNCOM_COMPARE_OUT: out },
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-1 << 14);
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), WORKER_TIMEOUT);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(fs.readFileSync(out, 'utf8')));
      } catch {
        reject(new Error(`${script} ${argv.join(' ')} failed (${signal ?? `exit ${code}`}):\n${stderr}`));
      } finally {
        fs.rmSync(out, { force: true });
      }
    });
  });

// A pair that fails is tried once more; a second failure is recorded and
// the run goes on, so one library cannot cost the others their numbers.
const attempt = async (script, argv) => {
  try {
    return await worker(script, argv);
  } catch (first) {
    console.log(`  retrying after: ${first.message.split('\n')[0]}`);
    try {
      return await worker(script, argv);
    } catch (error) {
      process.exitCode = 1;
      const reason = error.message.split('\n').find((line, i) => i > 0 && line.trim()) ?? 'failed';
      console.error(error.message);
      return { failed: reason.trim().slice(0, 160) };
    }
  }
};

const label = (adapter, line) => `${adapter.name} · ${adapter.lines[line]?.variant ?? '—'}`.padEnd(52);

const measureScenarios = async (adapters, scenarios, save) => {
  const measured = [];
  for (const scenario of scenarios) {
    console.log(`\n${scenario.title} — ${scenario.description}`);
    const results = {};
    const unsupported = {};
    const failed = {};
    for (const adapter of adapters) {
      const options = { adapter: adapter.id, scenario: scenario.id, ...method };
      const result = await attempt('worker.js', [JSON.stringify(options)]);
      if (result.failed) {
        failed[adapter.id] = result.failed;
        console.log(`  ${label(adapter, scenario.line)} ${'failed'.padStart(14)}  ${result.failed}`);
        continue;
      }
      if (result.unsupported) {
        unsupported[adapter.id] = result.unsupported;
        console.log(`  ${label(adapter, scenario.line)} ${'—'.padStart(14)}  ${result.unsupported}`);
        continue;
      }
      const spread = ((result.max - result.min) / result.median) * 100;
      results[adapter.id] = { median: result.median, min: result.min, max: result.max };
      console.log(
        `  ${label(adapter, scenario.line)} ${format(result.median).padStart(14)} ${scenario.unit}  ±${spread.toFixed(1)}%`,
      );
    }
    const { id, kind, kindTitle, line, lineTitle, title, description, unit } = scenario;
    measured.push({ id, kind, kindTitle, line, lineTitle, title, description, unit, results, unsupported, failed });
    save({ scenarios: measured, coldStart: {} });
  }
  return measured;
};

const measureColdStart = async (adapters, save) => {
  const coldStart = {};
  if (method.coldStartRuns <= 0) return coldStart;
  console.log(`\nCold start — load, open a store of 1,000 records on disk, read one; ${method.coldStartRuns} runs`);
  for (const adapter of adapters) {
    if (!adapter.lines.disk) continue;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `syncom-cold-${adapter.id}-`));
    try {
      const prepared = await attempt('coldstart-worker.js', ['prepare', adapter.id, dir]);
      if (prepared.failed) continue;
      const runs = [];
      for (let i = 0; i < method.coldStartRuns; i++) {
        const sample = await attempt('coldstart-worker.js', ['measure', adapter.id, dir, prepared.id]);
        if (!sample.failed) runs.push(sample);
      }
      if (!runs.length) continue;
      const phases = {};
      for (const phase of ['open', 'firstRead', 'total']) phases[phase] = median(runs.map((sample) => sample[phase]));
      coldStart[adapter.id] = phases;
      save({ scenarios: [], coldStart });
      console.log(`  ${label(adapter, 'disk')} ${phases.total.toFixed(1).padStart(8)} ms`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  return coldStart;
};

// Merges this run into the file, so a partial run (--only, --scenarios)
// keeps the other rows.
const writeResults = (report) => {
  let existing = null;
  try {
    existing = JSON.parse(fs.readFileSync(OUT, 'utf8'));
  } catch {
    // the first run
  }
  if (existing) {
    const libraries = new Map(existing.libraries.map((library) => [library.id, library]));
    for (const library of report.libraries) libraries.set(library.id, library);
    report.libraries = ADAPTERS.map((adapter) => libraries.get(adapter.id)).filter(Boolean);
    report.scenarios = SCENARIOS.map(({ id }) => {
      const fresh = report.scenarios.find((scenario) => scenario.id === id);
      const old = existing.scenarios.find((scenario) => scenario.id === id);
      if (!fresh) return old;
      // A library measured now replaces its old failure, and the reverse.
      const failed = { ...old?.failed };
      for (const id of Object.keys(fresh.results)) delete failed[id];
      return {
        ...fresh,
        results: { ...old?.results, ...fresh.results },
        unsupported: { ...old?.unsupported, ...fresh.unsupported },
        failed: { ...failed, ...fresh.failed },
      };
    }).filter(Boolean);
    report.coldStart = { ...existing.coldStart, ...report.coldStart };
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`);
};

const main = async () => {
  const only = list(args.only);
  const wanted = list(args.scenarios);
  const adapters = ADAPTERS.filter((adapter) => !only || only.includes(adapter.id));
  const scenarios = SCENARIOS.filter(
    (scenario) =>
      !wanted || wanted.includes(scenario.id) || wanted.includes(scenario.kind) || wanted.includes(scenario.line),
  );
  const machine = describeMachine();
  console.log(`Cross-library comparison · ${machine.cpu} · Node ${machine.node}`);
  console.log(
    `${method.samples} × ${method.sampleMs} ms samples (at most ${method.maxOps} ops) after ${method.warmupMs} ms ` +
      `warmup; ${method.rounds} rounds after ${method.warmupRounds}; median reported`,
  );
  // Results are merged into the file after every scenario, so a run that is
  // stopped keeps what it measured.
  const save = (partial) => {
    if (args['no-write']) return;
    writeResults({
      generatedAt: new Date().toISOString(),
      machine,
      method,
      libraries: adapters.map(libraryInfo),
      ...partial,
    });
  };
  await measureScenarios(adapters, scenarios, save);
  if (!wanted) await measureColdStart(adapters, save);
  if (!args['no-write']) console.log(`\nWrote ${path.relative(ROOT, OUT)}`);
};

main().catch((error) => {
  console.error(error.message ?? error);
  process.exitCode = 1;
});
