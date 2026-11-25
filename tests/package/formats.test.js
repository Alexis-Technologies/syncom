'use strict';

// Nothing is published: no stored format has had a reader outside this repository, so every format and version
// constant in src/ is its first — 1 — and a change of shape before the first release bumps none of them and keeps
// no reader, upgrade or fallback for what an earlier build wrote; and no name has had a caller, so a rename keeps
// no alias and nothing is deprecated (CLAUDE.md; docs/reference/wire.md, "Compatibility"). When the first release
// is cut this test goes, and the rules of that page take over.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
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

describe('formats before the first release', () => {
  it('should keep every format and version constant in src/ at 1 and read no other format, as nothing is published', () => {
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

  it('should open an IndexedDB database at version 1: its stores are made at once, none by an upgrade', () => {
    const opened = [];
    for (const file of sources(path.join(ROOT, 'src', 'idb'))) {
      for (const [, version] of readFileSync(file, 'utf8').matchAll(OPENED)) opened.push(version);
    }
    assert.ok(opened.length >= 2, 'the file store and the engine both open one');
    // `VERSION` is held to 1 by the test above.
    for (const version of opened) assert.ok(version === '1' || version === 'VERSION', `opened at ${version}`);
  });

  it('should deprecate nothing, as nothing is published — a rename before the first release keeps no alias', () => {
    const files = sources(path.join(ROOT, 'src'));
    const declarations = (dir, out) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) declarations(full, out);
        else if (entry.name.endsWith('.d.ts')) out.push(full);
      }
      return out;
    };
    declarations(path.join(ROOT, 'src'), files);
    for (const name of ['index.d.ts', 'browser.d.ts', 'index.js', 'browser.js']) files.push(path.join(ROOT, name));
    const deprecated = [];
    for (const file of files) {
      const lines = readFileSync(file, 'utf8').split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes('@deprecated')) deprecated.push(`${path.relative(ROOT, file)}:${i + 1}`);
      }
    }
    assert.deepStrictEqual(deprecated, []);
  });

  // A connector adapter's position is a stored format too: it is kept in the connector's checkpoint text. Each of the
  // four that resume by a stamp reads the one shape it writes; handed any other — a stamp alone, another adapter's
  // position — it has no checkpoint and pulls from the start, exactly as when handed none. No shape an earlier build
  // wrote is read on.
  it('should read in a connector adapter the one checkpoint shape it writes, as nothing is published — any other is no checkpoint', async () => {
    const { mongodb } = require('../../src/connector/mongodb.js');
    const { supabase } = require('../../src/connector/supabase.js');
    const { firestore } = require('../../src/connector/firestore.js');
    const { appwrite } = require('../../src/connector/appwrite.js');
    const { createFakeMongo } = require('../utils/fake-mongo.js');
    const { createFakeSupabase } = require('../utils/fake-supabase.js');
    const { createFakeFirestore, Timestamp } = require('../utils/fake-firestore.js');
    const { createFakeAppwrite } = require('../utils/fake-appwrite.js');
    // Two documents each, stamped one and two seconds in; every position below is five seconds in — past both.
    const start = Date.UTC(2026, 0, 1);
    const iso = (ms) => new Date(start + ms).toISOString();
    const own = {
      mongodb: { at: start + 5000, id: 'z' },
      supabase: { at: iso(5000), id: 'z' },
      appwrite: { updatedAt: iso(5000), id: 'z' },
      firestore: { seconds: start / 1000 + 5, nanoseconds: 0, id: 'z' },
    };
    const mongo = createFakeMongo().db('app').collection('tasks');
    const table = createFakeSupabase();
    const store = createFakeFirestore();
    const documents = createFakeAppwrite();
    for (const [id, ms] of [
      ['a', 1000],
      ['b', 2000],
    ]) {
      await mongo.replaceOne({ _id: id }, { _id: id, _rev: 1, _updated: start + ms, n: ms }, { upsert: true });
      table.write('tasks', { id, n: ms }, { at: iso(ms) });
      store.write(id, { n: ms }, { at: Timestamp.fromMillis(start + ms) });
      documents.write(id, { n: ms }, { at: iso(ms) });
    }
    const adapters = {
      mongodb: mongodb({ collection: mongo, changes: false }),
      supabase: supabase({ client: table, table: 'tasks', stream: false }),
      firestore: firestore({ sdk: store.sdk, database: store.database, collection: store.collection, stream: false }),
      appwrite: appwrite({
        databases: documents.databases,
        Query: documents.Query,
        databaseId: 'db',
        collectionId: 'tasks',
      }),
    };
    for (const name of Object.keys(adapters)) {
      const pull = adapters[name].pull.handler;
      const fresh = await pull(null, 10);
      assert.strictEqual(fresh.documents.length, 2, `${name} pulls both from the start`);
      assert.deepStrictEqual((await pull(own[name], 10)).documents, [], `${name} resumes from the shape it writes`);
      // What an earlier build wrote (a stamp alone, milliseconds for Firestore) and every other adapter's shape.
      const aliens = [start + 5000, iso(5000), { at: start + 5000 }, { seconds: start / 1000 + 5, nanoseconds: 0 }];
      for (const other of Object.keys(own)) if (other !== name) aliens.push(own[other]);
      for (const alien of aliens) {
        assert.deepStrictEqual(await pull(alien, 10), fresh, `${name} reads ${JSON.stringify(alien)} as no checkpoint`);
      }
    }
  });
});
