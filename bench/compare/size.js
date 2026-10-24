'use strict';

/**
 * Bundle sizes of the comparison: for every library, an entry that imports
 * what a browser app needs to keep records on the device and sync them —
 * the store, its browser persistence, its sync protocol — and leaves the
 * network client out where the library lets it (syncom's wrpc client, Yjs'
 * y-websocket, a TinyBase WebSocket synchronizer). Bundled with esbuild for
 * the browser (minified, tree-shaken); a WebAssembly module the library
 * loads is counted, gzipped, next to the JavaScript. Measuring a whole
 * package instead would charge a modular library for what an app never
 * imports. Writes bench/results/size.json.
 *
 * `cores` measures the CRDT libraries a second way, for /guide/vs-crdt: the
 * whole package entry of each (`export *`), with no persistence or sync
 * around it — what a page that only merges documents ships.
 *
 * Run: pnpm bench:size (after pnpm bench:compare:install)
 */

const fs = require('node:fs');
const path = require('node:path');
const { gzipSync } = require('node:zlib');
const esbuild = require('esbuild');

const ROOT = path.join(__dirname, '..', '..');
const OUT = path.join(ROOT, 'bench', 'results', 'size.json');
const MODULES = path.join(__dirname, 'node_modules');

const ENTRIES = [
  {
    id: 'syncom',
    name: 'syncom',
    entry: 'open() over OPFS + the wrpc link adapter',
    packages: ['@alexify/syncom'],
    source: `
      export { open } from '@alexify/syncom';
      export { createWrpcLink } from '@alexify/syncom/wrpc';
    `,
    note: 'storage, schema, queries, the op log and the sync protocol are one entry',
  },
  {
    id: 'yjs',
    name: 'Yjs',
    entry: 'yjs + y-indexeddb + y-protocols/sync',
    packages: ['yjs', 'y-indexeddb', 'y-protocols'],
    source: `
      export { Doc, Map, encodeStateVector, encodeStateAsUpdate, applyUpdate } from 'yjs';
      export { IndexeddbPersistence } from 'y-indexeddb';
      export { readSyncMessage, writeSyncStep1 } from 'y-protocols/sync';
    `,
  },
  {
    id: 'automerge',
    name: 'Automerge',
    entry: 'automerge-repo + IndexedDB storage',
    packages: ['@automerge/automerge', '@automerge/automerge-repo', '@automerge/automerge-repo-storage-indexeddb'],
    source: `
      export { Repo } from '@automerge/automerge-repo';
      export { IndexedDBStorageAdapter } from '@automerge/automerge-repo-storage-indexeddb';
    `,
    wasm: ['@automerge/automerge/dist/automerge.wasm'],
  },
  {
    id: 'loro',
    name: 'Loro',
    entry: 'loro-crdt (no persistence of its own)',
    packages: ['loro-crdt'],
    source: `
      export { LoroDoc, LoroMap, LoroCounter } from 'loro-crdt';
    `,
    wasm: ['loro-crdt/browser/loro_wasm_bg.wasm'],
  },
  {
    id: 'tinybase',
    name: 'TinyBase',
    entry: 'MergeableStore + IndexedDB persister + custom synchronizer',
    packages: ['tinybase'],
    source: `
      export { createMergeableStore } from 'tinybase';
      export { createIndexedDbPersister } from 'tinybase/persisters/persister-indexed-db';
      export { createCustomSynchronizer } from 'tinybase/synchronizers';
    `,
  },
  {
    id: 'pouchdb',
    name: 'PouchDB',
    entry: 'pouchdb-browser',
    packages: ['pouchdb-browser'],
    source: `
      export { default } from 'pouchdb-browser';
    `,
    note: 'pouchdb-browser carries its HTTP adapter (the CouchDB client) with it',
  },
  {
    id: 'rxdb',
    name: 'RxDB',
    entry: 'rxdb + Dexie storage + replication',
    packages: ['rxdb', 'dexie', 'rxjs'],
    source: `
      export { createRxDatabase } from 'rxdb';
      export { getRxStorageDexie } from 'rxdb/plugins/storage-dexie';
      export { replicateRxCollection } from 'rxdb/plugins/replication';
    `,
  },
  {
    id: 'fireproof',
    name: 'Fireproof',
    entry: '@fireproof/core',
    packages: ['@fireproof/core'],
    source: `
      export { fireproof } from '@fireproof/core';
    `,
  },
  {
    id: 'gun',
    name: 'GUN',
    entry: 'gun (localStorage; its WebSocket mesh is built in)',
    packages: ['gun'],
    source: `
      export { default } from 'gun';
    `,
  },
  {
    id: 'orbitdb',
    name: 'OrbitDB',
    entry: '@orbitdb/core + helia + libp2p, IndexedDB blockstore',
    packages: ['@orbitdb/core', 'helia', 'libp2p', '@libp2p/gossipsub', 'blockstore-idb'],
    source: `
      export { createOrbitDB } from '@orbitdb/core';
      export { createHelia } from 'helia';
      export { createLibp2p } from 'libp2p';
      export { gossipsub } from '@libp2p/gossipsub';
      export { identify } from '@libp2p/identify';
      export { IDBBlockstore } from 'blockstore-idb';
    `,
    note: "createHelia brings Helia's default libp2p configuration with it",
  },
];

// The whole package of each CRDT library and syncom's whole entry, nothing around them.
const CORES = [
  { id: 'syncom', name: 'syncom', entry: "export * from '@alexify/syncom'", packages: ['@alexify/syncom'] },
  { id: 'yjs', name: 'Yjs', entry: "export * from 'yjs'", packages: ['yjs'] },
  {
    id: 'automerge',
    name: 'Automerge',
    entry: "export * from '@automerge/automerge'",
    packages: ['@automerge/automerge'],
    wasm: ['@automerge/automerge/dist/automerge.wasm'],
  },
  {
    id: 'loro',
    name: 'Loro',
    entry: "export * from 'loro-crdt'",
    packages: ['loro-crdt'],
    wasm: ['loro-crdt/browser/loro_wasm_bg.wasm'],
  },
].map((spec) => ({ ...spec, source: `${spec.entry};` }));

const versionOf = (name) => {
  if (name === '@alexify/syncom') return require(path.join(ROOT, 'package.json')).version;
  return JSON.parse(fs.readFileSync(path.join(MODULES, name, 'package.json'), 'utf8')).version;
};

// Node built-ins a library reaches for behind a runtime check (GUN, the
// libp2p stack) are left out of a browser bundle, as a bundler would be told.
const NODE_BUILTINS = new Set(require('node:module').builtinModules);
const skipBuiltins = {
  name: 'skip-builtins',
  setup(build) {
    build.onResolve({ filter: /.*/ }, (args) => {
      const name = args.path.replace(/^node:/, '');
      return NODE_BUILTINS.has(name) ? { path: args.path, external: true } : null;
    });
  },
};

const measure = async (spec) => {
  const result = await esbuild.build({
    stdin: { contents: spec.source, resolveDir: __dirname, loader: 'js' },
    bundle: true,
    minify: true,
    treeShaking: true,
    format: 'esm',
    platform: 'browser',
    conditions: ['browser'],
    mainFields: ['browser', 'module', 'main'],
    alias: { '@alexify/syncom': ROOT },
    loader: { '.wasm': 'file' },
    outdir: path.join(__dirname, '.size-out'),
    write: false,
    define: { 'process.env.NODE_ENV': '"production"', global: 'globalThis' },
    plugins: [skipBuiltins],
    logLevel: 'silent',
  });
  let min = 0;
  let gzip = 0;
  let wasm = 0;
  const counted = new Set();
  for (const file of result.outputFiles) {
    const bytes = Buffer.from(file.contents);
    min += bytes.length;
    gzip += gzipSync(bytes, { level: 9 }).length;
    if (file.path.endsWith('.wasm')) {
      wasm += bytes.length;
      counted.add(bytes.length);
    }
  }
  // A module the library fetches by URL at run time is not an import esbuild
  // follows; it is counted from the package (once, if esbuild emitted it too).
  for (const file of spec.wasm ?? []) {
    const bytes = fs.readFileSync(path.join(MODULES, file));
    if (counted.has(bytes.length)) continue;
    min += bytes.length;
    wasm += bytes.length;
    gzip += gzipSync(bytes, { level: 9 }).length;
  }
  return {
    id: spec.id,
    name: spec.name,
    entry: spec.entry,
    packages: spec.packages.map((name) => `${name}@${versionOf(name)}`),
    min,
    gzip,
    ...(wasm ? { wasm } : {}),
    ...(spec.note ? { note: spec.note } : {}),
  };
};

const kb = (bytes) => `${(bytes / 1024).toFixed(1)} KB`;

const main = async () => {
  if (!fs.existsSync(MODULES)) throw new Error('run `pnpm bench:compare:install` first');
  const libraries = [];
  for (const spec of ENTRIES) {
    const row = await measure(spec);
    libraries.push(row);
    console.log(`${spec.name.padEnd(12)} ${kb(row.gzip).padStart(10)} min+gzip  ${kb(row.min).padStart(10)} min`);
  }
  const cores = [];
  for (const spec of CORES) {
    const row = await measure(spec);
    cores.push(row);
    console.log(`core ${spec.name.padEnd(7)} ${kb(row.gzip).padStart(10)} min+gzip  ${kb(row.min).padStart(10)} min`);
  }
  const report = { generatedAt: new Date().toISOString(), esbuild: esbuild.version, libraries, cores };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\nWrote ${path.relative(ROOT, OUT)}`);
};

main().catch((error) => {
  console.error(error.errors?.map((item) => item.text).join('\n') ?? error);
  process.exitCode = 1;
});
