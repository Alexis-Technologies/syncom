'use strict';

// INVARIANTS.md names, for every guarantee, the tests that hold it. This
// keeps the two in step: every id names at least one test, and every test
// it names is a plain-string title somewhere under tests/. Rename a test
// and its row together.

const test = require('node:test');
const assert = require('node:assert');
const { readFileSync, readdirSync, statSync } = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');

const files = (dir) => {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (name === 'node_modules') continue;
    if (statSync(full).isDirectory()) out.push(...files(full));
    else if (name.endsWith('.js')) out.push(full);
  }
  return out;
};

// Every plain-string test title: `test('…')`, `t.test('…')`, `t2.test('…')`,
// the call possibly broken over lines. Template titles are not citable.
const titles = () => {
  const found = new Set();
  const pattern = /\b(?:test|t\d?\.test)\(\s*(['"])((?:\\.|(?!\1)[^\\])*)\1/g;
  for (const file of files(path.join(ROOT, 'tests'))) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(pattern)) found.add(match[2].replace(/\\'/g, "'"));
  }
  return found;
};

const rows = () => {
  const text = readFileSync(path.join(ROOT, 'INVARIANTS.md'), 'utf8');
  const out = [];
  for (const line of text.split('\n')) {
    const match = /^\| ([A-Z]+-\d+) \| (.+?) \| (.*) \|$/.exec(line);
    if (!match) continue;
    const named = [...match[3].matchAll(/`([^`]+)`/g)].map((m) => m[1]);
    out.push({ id: match[1], guarantee: match[2], tests: named });
  }
  return out;
};

test('every invariant names at least one test, and every test it names exists', () => {
  const known = titles();
  const table = rows();
  assert.ok(table.length >= 20, `only ${table.length} invariants found`);
  const ids = new Set();
  for (const { id, tests } of table) {
    assert.ok(!ids.has(id), `${id} appears twice`);
    ids.add(id);
    assert.ok(tests.length > 0, `${id} names no test`);
    for (const name of tests) assert.ok(known.has(name), `${id}: no test titled "${name}"`);
  }
});
