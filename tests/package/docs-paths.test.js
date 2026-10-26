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

test('every src/ path a comment in src/ names exists', () => {
  const missing = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (full.endsWith('.js')) {
        for (const match of readFileSync(full, 'utf8').matchAll(/src\/[A-Za-z0-9_./-]+\.js/g)) {
          if (!existsSync(path.join(ROOT, match[0]))) missing.push(`${path.relative(ROOT, full)}: ${match[0]}`);
        }
      }
    }
  };
  walk(path.join(ROOT, 'src'));
  assert.deepStrictEqual(missing, []);
});
