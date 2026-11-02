'use strict';

// Every directory a module of src/ writes under a database's path is in the
// layout (src/layout.js): the kv namespaces named as literals — `kvNamespace(x, 'name')`,
// `kv.put('name', …)`, `db.kv.get('name', …)` — and the directories the files
// engine makes. What is not there, `engine.remove(path)` would leave behind.

const path = require('node:path');
const { readFileSync, readdirSync, statSync } = require('node:fs');
const { test } = require('node:test');
const assert = require('node:assert');
const { DIRS, tagDirs } = require('../../src/layout.js');
const { KV_NAMESPACES } = require('../../src/engine.js');

const ROOT = path.join(__dirname, '..', '..');

const files = (dir, out = []) => {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) files(full, out);
    else if (name.endsWith('.js')) out.push(full);
  }
  return out;
};

test('every kv namespace a module of src/ names as a literal is a directory of the layout', () => {
  const known = new Set(DIRS);
  const missing = [];
  for (const file of files(path.join(ROOT, 'src'))) {
    const text = readFileSync(file, 'utf8');
    const seen = new Set();
    for (const match of text.matchAll(/kvNamespace\(\s*[\w.]+,\s*'([^']*)'/g)) seen.add(match[1]);
    for (const match of text.matchAll(/\bkv\.(?:get|put|has|list|remove|create)\(\s*'([^']*)'/g)) seen.add(match[1]);
    for (const ns of seen) if (!known.has(ns)) missing.push(`${path.relative(ROOT, file)}: '${ns}'`);
  }
  assert.deepStrictEqual(missing, []);
});

test('the layout holds every kv namespace, the files engine’s directories and a tag’s two', () => {
  for (const ns of KV_NAMESPACES) assert.ok(DIRS.includes(ns), ns);
  for (const dir of ['data', 'log', 'log/open', 'log/corrupt', 'tags/.pending/data']) {
    assert.ok(DIRS.includes(dir), dir);
  }
  assert.deepStrictEqual(tagDirs('v1'), ['tags/v1/data', 'tags/v1/index']);
  assert.ok(Object.isFrozen(DIRS));
});
