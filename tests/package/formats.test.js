'use strict';

// Nothing is published: no stored format has had a reader outside this repository, so every format and version
// constant in src/ is its first — 1 — and a change of shape before the first release bumps none of them and keeps
// no reader, upgrade or fallback for what an earlier build wrote (CLAUDE.md; docs/reference/wire.md,
// "Compatibility"). When the first release is cut this test goes, and the rules of that page take over.

const test = require('node:test');
const assert = require('node:assert');
const { readdirSync, readFileSync } = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const CONSTANT = /^\s*(?:const|let) ([A-Z][A-Z_]*) = (\d+);/gm;
const NAMED = /(?:^|_)(?:VERSION|FORMAT|PROTOCOL)$/;
// A stored shape compared against a number above 1: a reader of another format.
const OLDER = /\.(?:format|version)\s*[!=]==\s*([2-9]\d*)\b/g;
const OPENED = /indexedDB\.open\(\s*\w+\s*,\s*(\w+)\s*\)/g;

const sources = (dir, out = []) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sources(full, out);
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
};

test('nothing is published: every format and version constant in src/ is 1, and no other format is read', () => {
  const found = [];
  const bumped = [];
  const older = [];
  for (const file of sources(path.join(ROOT, 'src'))) {
    const text = readFileSync(file, 'utf8');
    const name = path.relative(ROOT, file);
    for (const [, constant, value] of text.matchAll(CONSTANT)) {
      if (!NAMED.test(constant)) continue;
      found.push(`${name}: ${constant}`);
      if (value !== '1') bumped.push(`${name}: ${constant} = ${value}`);
    }
    for (const [match] of text.matchAll(OLDER)) older.push(`${name}: ${match}`);
  }
  // The scan sees what it is for: the catalog's, the IndexedDB engine's, the protocol's and the header's among them.
  for (const expected of ['src/catalog.js: FORMAT', 'src/idb/engine.js: VERSION', 'src/sync/protocol.js: PROTOCOL']) {
    assert.ok(found.includes(expected), `${expected} is scanned`);
  }
  assert.deepStrictEqual(bumped, [], 'a format above its first version before the first release');
  assert.deepStrictEqual(older, [], 'a reader of another format before the first release');
});

test('an IndexedDB database is opened at version 1: its stores are made at once, none by an upgrade', () => {
  const opened = [];
  for (const file of sources(path.join(ROOT, 'src', 'idb'))) {
    for (const [, version] of readFileSync(file, 'utf8').matchAll(OPENED)) opened.push(version);
  }
  assert.ok(opened.length >= 2, 'the file store and the engine both open one');
  // `VERSION` is held to 1 by the test above.
  for (const version of opened) assert.ok(version === '1' || version === 'VERSION', `opened at ${version}`);
});
