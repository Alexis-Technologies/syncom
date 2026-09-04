# Changelog

All notable changes to **`@alexify/syncom`** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

This package has not been published to npm yet — there is no released version
section until the first publish; everything below lands there on release day.

### Added

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
