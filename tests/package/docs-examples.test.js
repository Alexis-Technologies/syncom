'use strict';

// Every example a page of docs/ shows is a file of docs/examples/ (`.mjs`, `.js`, or `.mts`, which Node runs by
// stripping its types; the types themselves are tsd's, in tests/*.test-d.ts), included by the page through
// `<<< @/examples/<file>#<region>`: what the reader sees is what this test runs. Each file runs in a
// process of its own from an empty temporary directory, so a `path` it opens lands there and is gone
// after. A file whose first line is `// docs-examples: browser-only (<reason>)` needs what Node does not
// have (OPFS, a SharedWorker, WebRTC): it is only parsed. docs/examples/rxdb/ is RxDB's side of the
// comparison and runs against the RxDB of bench/compare (`pnpm docs:examples:rxdb`), not here.

const path = require('node:path');
const { readFileSync, readdirSync, statSync, mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const assert = require('node:assert');

const ROOT = path.join(__dirname, '..', '..');
const EXAMPLES = path.join(ROOT, 'docs', 'examples');
const BROWSER_ONLY = /^\/\/ docs-examples: browser-only \(.+\)/;

const files = (dir, out = []) => {
  for (const name of readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name !== 'rxdb') files(full, out);
    } else if (/\.(?:mjs|js|mts)$/.test(name)) out.push(full);
  }
  return out;
};

const run = (file, args) => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'syncom-docs-'));
  try {
    return spawnSync(process.execPath, [...args, file], { cwd, encoding: 'utf8', timeout: 90_000 });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
};

for (const file of files(EXAMPLES)) {
  const name = path.relative(ROOT, file);
  const browserOnly = BROWSER_ONLY.test(readFileSync(file, 'utf8'));
  test(`${name} ${browserOnly ? 'parses' : 'runs'}`, () => {
    const result = run(file, browserOnly ? ['--check'] : []);
    const output = `${result.stdout}\n${result.stderr}`.trim().slice(-4000);
    assert.strictEqual(result.signal, null, `${name} timed out\n${output}`);
    assert.strictEqual(result.status, 0, `${name} failed\n${output}`);
  });
}

test('every page region an example names exists in its file', () => {
  const missing = [];
  const pages = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (name === '.vitepress' || name === 'examples' || name === 'public') continue;
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith('.md') && name !== 'CLAUDE.md') pages.push(full);
    }
  };
  walk(path.join(ROOT, 'docs'));
  for (const page of pages) {
    const text = readFileSync(page, 'utf8');
    for (const match of text.matchAll(/^<<< @\/(examples\/[^\s#{]+)(?:#([\w-]+))?/gm)) {
      const [, rel, region] = match;
      const full = path.join(ROOT, 'docs', rel);
      let source;
      try {
        source = readFileSync(full, 'utf8');
      } catch {
        missing.push(`${path.relative(ROOT, page)}: ${rel} does not exist`);
        continue;
      }
      if (region && !source.includes(`// #region ${region}\n`)) {
        missing.push(`${path.relative(ROOT, page)}: ${rel} has no region ${region}`);
      }
    }
  }
  assert.deepStrictEqual(missing, []);
});
