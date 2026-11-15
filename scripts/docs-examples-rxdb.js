/**
 * Runs RxDB's side of every "Coming from RxDB" code group (docs/examples/rxdb/*.mjs) against the
 * rxdb of bench/compare — `pnpm bench:compare:install` first. Each file runs from an empty temporary
 * directory, as tests/package/docs-examples.test.js runs syncom's side; RxDB is not a dependency of
 * syncom, so this is a script of its own and not a test of the suite.
 *
 * Run: pnpm docs:examples:rxdb
 */
'use strict';

const path = require('node:path');
const { readdirSync, existsSync, mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const DIR = path.join(ROOT, 'docs', 'examples', 'rxdb');
const HOOKS = path.join(__dirname, 'docs-rxdb-hooks.mjs');

if (!existsSync(path.join(ROOT, 'bench', 'compare', 'node_modules', 'rxdb'))) {
  console.error('rxdb is not installed in bench/compare: run `pnpm bench:compare:install` first');
  process.exit(1);
}

let failed = 0;
const files = readdirSync(DIR)
  .filter((name) => name.endsWith('.mjs'))
  .sort();
for (const name of files) {
  const cwd = mkdtempSync(path.join(tmpdir(), 'syncom-docs-rxdb-'));
  const result = spawnSync(process.execPath, ['--import', HOOKS, path.join(DIR, name)], {
    cwd,
    encoding: 'utf8',
    timeout: 90_000,
  });
  rmSync(cwd, { recursive: true, force: true });
  const ok = result.status === 0;
  if (!ok) failed++;
  console.log(`${ok ? 'ok    ' : 'FAILED'} docs/examples/rxdb/${name}`);
  if (!ok) console.log(`${result.stdout}\n${result.stderr}`.trim().slice(-3000));
}
console.log(`${files.length - failed}/${files.length} RxDB examples ran`);
process.exit(failed === 0 ? 0 : 1);
