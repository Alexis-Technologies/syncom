# Changelog

All notable changes to **`@alexify/syncom`** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

This package has not been published to npm yet — there is no released version
section until the first publish; everything below lands there on release day.

### Added

- **OpenTelemetry, injected.** `open({ telemetry: { api } })` (the
  `@opentelemetry/api` module) or `{ tracer, meter }` — the same object wrpc's
  `telemetry` option takes, and no dependency on either. Spans:
  `syncom.commit`, `syncom.apply`, `syncom.replay`, `syncom.push`,
  `syncom.bootstrap`, `syncom.log.roll`. Metrics: `syncom.commits`,
  `syncom.write.duration`, `syncom.ops.received`, `syncom.ops.rejected`,
  `syncom.replication.lag`, `syncom.push.ops`, `syncom.bootstraps`,
  `syncom.log.segments`, `syncom.log.append.duration`. syncom carries no
  trace context of its own: its spans nest under whatever is active, so with
  wrpc telemetry on both ends a write on one node and its application on the
  next are one trace. `includeIdentity: false` keeps record ids and peer
  urls off spans; they are never metric labels. `storage.telemetry` exposes
  the writer; `OpLog` takes the option directly. Browser budget raised
  14 → 17 KB for it.
- **Replication.** Every write is now an operation — `write` (`insert`/`set`),
  `set` (`update`/`swap`/`record.save`), `inc`, `delete` — appended to a
  persisted log (`src/log.js`) and applied through a record-level model
  (`src/ops.js`) that converges in any order: last-writer-wins registers,
  per-origin counters, tombstones with revival. `SyncManager` dials the
  registered nodes through an injected `sync.connect(node)` factory, pushes
  what a peer lacks, subscribes to what it learns, relays across a mesh,
  resumes from the last event id and bootstraps from a snapshot when it
  cannot; `storage.sync.unit()` is the router unit a host mounts.
- `@alexify/syncom/wrpc` — `createWrpcLink(client)` adapts a `WrpcClient`
  (injected, never a dependency) to the link contract; `isSyncLink`,
  `SYNC_INTROSPECTION`.
- `Storage`: `inc()`, `list()`, `close()`, `applyRemote()`, `snapshot()`,
  `mergeSnapshot()`, `adoptVector()`, `nodeId`, `vector`, `log`, the `change`
  and `error` events; `Record.inc()`; live records follow remote changes and
  keep unsaved edits on top. Options `logger`, `encrypted`, `sync`.
- `SyncManager`: `stop()`, `sync()`, `peers()`, `enableNode()`, `unit()`, the
  `peer`/`sync`/`bootstrap`/`error` events; scopes (`addNode({ scopes })`,
  `sync.scope`) for partial replication.
- Encryption at rest is a hybrid envelope (AES-256-GCM under an RSA-OAEP
  SHA-256 wrapped key), identical in both halves, with no payload ceiling;
  `open({ encrypted: true })` and `insert/set(…, { encrypted })`.
- `fsi.list(dir)`; `OpLog`, `applyOp`, `mergeEntry`, `isAlive` exports.
- `src/utils.js` and `src/utils.browser.js` — the `Emitter`, `generateUUID`,
  `between`, `fileExists` and `directoryExists` helpers the source needs,
  vendored in so the package keeps its zero-runtime-dependency promise.
- `browser.d.ts` — the browser half of the type surface, declaring
  `calculateHash`, `encrypt` and `decrypt` as promise-returning (Web Crypto is
  async where `node:crypto` is not) and re-exporting everything else from
  `index.d.ts`.
- `scripts/size.js` — bundle-size report per `exports` entry, with a
  min+gzip budget on the browser entry that fails the run when exceeded, and a
  resolve-time check that rejects any bare import reaching a browser bundle.
- `bench/` — `crdt`, `hash`, `chain`, `storage` and `emitter` benchmarks over a
  shared harness, plus `run-all.js` so `pnpm bench` covers the whole folder.
- `tests/package/consistency.test.js` — asserts that `exports`, `files`, the
  `browser` map, the `.d.ts` files, the `scripts/size.js` rows and the docs
  keywords/version all agree with `package.json`.
- `tests/utils.test.js`, `tests/utils.browser.test.js`,
  `tests/index.browser.test.js` and `tests/{index,browser}.test-d.ts`.
- A VitePress documentation site under `docs/`, and `.github/workflows/ci.yml`
  running lint + format + size, the test matrix, and the docs build.
- `CHANGELOG.md`, `SECURITY.md`, `CONTRIBUTING.md`, `CLAUDE.md`, `vercel.json`.

### Fixed

- A peer's op refused by the register/counter rule no longer fails the whole
  push when nobody listens for `error`: the emit is guarded, the vector
  advances, and the peer stops offering the same page on every hello.
- `OpLog` now receives the storage `logger`, so an unreadable segment or open
  file is reported rather than silently skipped.

### Fixed

- `Storage.saveData()` did not await `encrypt`/`decrypt`, so encryption at
  rest in the browser stored a serialized promise (`{}`) instead of ciphertext.
- `apply()` ignored the data of a `write` record and only understood `delete`
  by `key`; a full write now replaces the state and Storage's own
  `{ type: 'delete', id }` shape empties it.
- `Blockchain.validate({ from })` threw on an unknown hash instead of
  answering `false`.
- `loadKeys()` threw `ENOENT` when `public.pem` existed without `private.pem`;
  the pair is regenerated.
- `SyncManager` persisted nodes under `<host>.json`, so two peers on one host,
  or a url without a port, overwrote each other.
- `Storage.validate()` threw `Cannot use 'in' operator` when called with no
  arguments, and silently returned `false` for `validate({})`. It discriminated
  on `'last' in idOrOptions`; it now keys off whether the first argument is a
  record id (a string), which is what actually separates the two call shapes.
- `Emitter.emit` dropped every argument after the first, so the `update` event
  a `Record` emits delivered `data` but never `delta` — despite `index.d.ts`
  typing the listener as `(data, delta) => void`.
- `browser.js` was a hand-inlined 810-line duplicate of `src/`, importing a
  `./metautil.js` that did not exist and calling an `fsi` binding that was
  never defined. It is now a two-line shim over `src/index.browser.js`.
- `index.js` did not re-export `SyncManager`, which `index.d.ts` declared.
- `package.json#browser` mapped `./src/runtime/node.js` to
  `./src/runtime/browser.js`; neither path existed.
- The `test` script globbed `tests/*.test.js` while every test file was named
  `tests/<name>.js`, so it matched nothing. Five tests additionally required a
  `../lib/` directory that does not exist in this layout.
- `examples/main.js` required a `globalstorage.js` that does not exist.

### Changed (breaking)

- `SyncManager` is constructed as `new SyncManager(storage, options)`; nodes
  no longer carry `type: 'uplink' | 'downlink'` — every registered node is
  dialed, and any node can host. `src/sync.browser.js` is gone: one
  `src/sync.js` over `fsi` serves both halves, and the browser registry is
  persisted in OPFS.
- The in-memory `Storage.#updates` array and `addUpdate()` are gone; the
  operation log replaces them. `set()` on an existing record is a whole-record
  write; `update()` on a counter field, and `inc()` on a register field, throw.
- `delete()` leaves a tombstone on disk; `list()`, `get()` and `has()` hide it.
- The browser bundle budget was raised from 5 KB to 14 KB min+gzip for the
  replication engine.
- **Node.js ≥ 22 is required** (was `>=18`).
- Browser modules follow the `*.browser.js` pattern:
  `src/{crypto,fsi,sync}-browser.js` → `src/{crypto,fsi,sync}.browser.js`.
- The default storage directory is `syncom` (was `gs`).
- Type names `GsRecord` / `GsCollection` → `SyncomRecord` / `SyncomCollection`.
- `exports` gained a `browser` condition resolving to `browser.js` /
  `browser.d.ts`, and a `./package.json` entry.
- The `bench:compare` and `size:compare` scripts were removed; they pointed at
  files that were never written.

### Removed

- `emulation/` — a legacy prototype duplicating `Storage` and `SyncManager`.
- The root `example.js` — it required two modules that do not exist.
  `examples/` covers the same ground.
