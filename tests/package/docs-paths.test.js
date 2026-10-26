'use strict';

// What the agent and contributor guides say about the code holds: every
// `src/…` path they name exists, and every "no requires" / "requires X only"
// a layout line of CLAUDE.md claims is what the file requires.

const path = require('node:path');
const { readFileSync, existsSync, readdirSync, statSync } = require('node:fs');
const { test } = require('node:test');
const assert = require('node:assert');

const ROOT = path.join(__dirname, '..', '..');

const guides = () => {
  const out = ['CLAUDE.md', 'CONTRIBUTING.md'];
  const skills = path.join(ROOT, '.claude', 'skills');
  if (existsSync(skills)) {
    for (const name of readdirSync(skills)) {
      const file = path.join('.claude', 'skills', name, 'SKILL.md');
      if (existsSync(path.join(ROOT, file))) out.push(file);
    }
  }
  return out;
};

test('every src/ path the guides name exists', () => {
  const missing = [];
  for (const guide of guides()) {
    const text = readFileSync(path.join(ROOT, guide), 'utf8');
    for (const match of text.matchAll(/src\/[A-Za-z0-9_./-]+\.(?:js|ts)/g)) {
      if (match[0].includes('<')) continue;
      if (!existsSync(path.join(ROOT, match[0]))) missing.push(`${guide}: ${match[0]}`);
    }
  }
  assert.deepStrictEqual(missing, []);
});

test('what a CLAUDE.md layout line says a file requires, it requires', () => {
  const text = readFileSync(path.join(ROOT, 'CLAUDE.md'), 'utf8');
  const layout = text.slice(text.indexOf('## Layout'), text.indexOf('## Rules that bite'));
  // A layout entry: a line naming a path at its start, and the indented lines that continue it.
  const entries = [];
  let current = null;
  for (const line of layout.split('\n')) {
    if (/^src\/\S+\.js/.test(line)) {
      if (current !== null) entries.push(current);
      current = line;
    } else if (current !== null && /^\s{10,}\S/.test(line)) current += ` ${line.trim()}`;
    else {
      if (current !== null) entries.push(current);
      current = null;
    }
  }
  if (current !== null) entries.push(current);
  const wrong = [];
  for (const entry of entries) {
    const file = entry.match(/^(src\/\S+\.js)/)[1];
    if (!existsSync(path.join(ROOT, file)) || !statSync(path.join(ROOT, file)).isFile()) continue;
    const required = [];
    for (const match of readFileSync(path.join(ROOT, file), 'utf8').matchAll(/require\('(\.[^']+)'\)/g)) {
      required.push(path.basename(match[1], '.js'));
    }
    if (/no requires/.test(entry) && required.length > 0) wrong.push(`${file}: "no requires", requires ${required}`);
    const only = entry.match(/requires ([^—;()]*?) only/);
    if (only !== null) {
      const listed = new Set();
      for (const name of only[1].matchAll(/([a-z0-9-]+)(?:\.js)?/g)) listed.add(name[1]);
      for (const name of required) if (!listed.has(name)) wrong.push(`${file}: "${only[0]}", requires ${name} too`);
    }
  }
  assert.deepStrictEqual(wrong, []);
});

test('every src/ path a comment in src/ or a declaration file names exists', () => {
  const missing = [];
  const check = (full) => {
    for (const match of readFileSync(full, 'utf8').matchAll(/src\/[A-Za-z0-9_./-]+\.js/g)) {
      if (!existsSync(path.join(ROOT, match[0]))) missing.push(`${path.relative(ROOT, full)}: ${match[0]}`);
    }
  };
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (full.endsWith('.js') || full.endsWith('.d.ts')) check(full);
    }
  };
  walk(path.join(ROOT, 'src'));
  for (const name of ['index.d.ts', 'browser.d.ts']) check(path.join(ROOT, name));
  assert.deepStrictEqual(missing, []);
});

// A matrix cell's `source` is what it was decided from: a path of this
// repository there exists. A segment that names another package
// (`@alexify/wrpc@2.0.1 src/…`) is that package's path, not ours.
test('every path the syncom column of a comparison matrix cites exists', () => {
  const missing = [];
  const pattern = /(?<![\w./@-])((?:src|tests|docs|bench|scripts)\/[\w./-]*\w|[\w-]+\.(?:md|json))(?::[\d,-]+)?/g;
  for (const name of ['comparison', 'comparison-rxdb', 'comparison-crdt']) {
    const matrix = JSON.parse(readFileSync(path.join(ROOT, 'docs', `${name}.json`), 'utf8'));
    let syncom = null;
    for (const library of matrix.libraries) if (library.id === 'syncom') syncom = library;
    assert.ok(syncom, `${name}.json has a syncom column`);
    for (const id of Object.keys(syncom.cells)) {
      const source = syncom.cells[id].source;
      if (typeof source !== 'string') continue;
      for (const segment of source.split('; ')) {
        if (segment.startsWith('@')) continue;
        for (const match of segment.matchAll(pattern)) {
          if (!existsSync(path.join(ROOT, match[1]))) missing.push(`${name}.json ${id}: ${match[1]}`);
        }
      }
    }
  }
  assert.deepStrictEqual(missing, []);
});
