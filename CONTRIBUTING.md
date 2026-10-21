# Contributing

Thanks for looking. This file covers how to work on `@alexify/syncom`, the
house rules that are not obvious from the code, and the release checklist.

## Setup

```bash
pnpm install
pnpm test
```

Requires **Node.js ≥ 22** and **pnpm** (`packageManager` pins the version).
There is no build step: `src/` ships as-is.

## Commands

```bash
pnpm test              # node --test, recursive over tests/
pnpm test:coverage     # c8 over src/ — thresholds 95 lines / 95 statements / 90 branches / 95 functions
pnpm test:types        # tsd against the .d.ts files
pnpm lint              # oxlint
pnpm format            # oxfmt (format:check in CI)
pnpm size              # bundle-size report; the browser budget fails the run
pnpm bench             # every script in bench/ (--save → bench/results/engine.json)
pnpm bench:compare     # against the alternatives (pnpm bench:compare:install first)
pnpm bench:report      # charts and tables of docs/guide/benchmarks.md and the README
pnpm docs:comparison   # the matrix of docs/guide/comparison.md from docs/comparison.json
pnpm docs:dev          # the VitePress site (docs:build / docs:preview too)
```

Run a single file with `node --test tests/storage.test.js`, or filter by name
with `node --test --test-name-pattern 'swap'`.

## House rules

- **CommonJS, `'use strict'`.** No build step, no transpilation. `src/` is what
  gets published.
- **Zero runtime dependencies.** Everything in `package.json` is a
  devDependency, and `scripts/size.js` fails the run if a bare import reaches
  a browser bundle. If you need a helper, write it in `src/utils.js`.
- **Browser halves are named `*.browser.js`** and wired up through
  `package.json#browser` plus `src/index.browser.js`. A new split module needs
  an entry in both.
- **A `.d.ts` change and its `tsd` test land together.** `index.d.ts` is the
  Node surface; `browser.d.ts` re-exports it and overrides only the three
  crypto functions that are async in the browser.
- **Anything in `tests/` not named `*.test.js` is a helper** and is skipped by
  `node --test` discovery — that is why `tests/suites/`, `tests/utils/` and
  `tests/package/` work the way they do.
- **Document what the code does, not what it will do.** Run every example
  before writing it down.
- **wrpc is injected, never required.** `@alexify/wrpc` is a devDependency for
  `tests/wrpc.integration.test.js` only, which skips when it is missing; nothing
  under `src/` may `require` it. The adapter in `src/wrpc.js` duck-types the
  client it is handed.
- **A field is a register or a counter.** `set`/`update` write registers,
  `inc` writes counters, and the two never meet on one field — do not add a
  path that lets them.

## Tests

`node:test` with `node:assert`. One top-level `test(name, async (t) => ...)`
per subject, nested `await t.test(...)` per case, teardown registered with
`t.after(...)` immediately after setup.

Behaviour shared between the Node and browser halves lives in `tests/suites/`
and is run twice — see `tests/suites/emitter.js`, `tests/suites/fsi.js` and
`tests/suites/sync-engine.js`. The browser halves are exercised under Node.js
using the OPFS mock in `tests/utils/mock-opfs.js` and `node:crypto`'s
`webcrypto`; `tests/utils/browser-env.js` loads the shared modules the way a
bundler honouring `package.json#browser` would. The sync engine is tested over
`tests/utils/memory-link.js`, an in-process link that behaves like a wrpc
client at the boundary (JSON across, resume from the last event id on
reconnect), and once more over real wrpc in `tests/wrpc.integration.test.js`.

`tests/package/consistency.test.js` is the machine-checked half of the release
checklist: it fails if `exports`, `files`, the `browser` map, the `.d.ts`
files, the `scripts/size.js` rows or the docs keywords/version drift from
`package.json`. When it goes red, the fix is usually the metadata, not the test.

## CI

Three jobs (`.github/workflows/ci.yml`):

1. **lint** — `lint`, `format:check`, `size` (the last both smoke-tests the
   script and puts the numbers in the log).
2. **test** — matrix over Node 22 and 24: `test:coverage`, then `test:types`.
3. **docs** — `docs:build`, so a broken page or dead link fails the PR rather
   than the deploy.

Benchmarks are not run in CI: they measure a machine, not a change.

## Bundle size

`pnpm size` prints one row per `exports` entry and enforces a min+gzip budget
on the browser entry. The budget is a **ratchet, not a target**: raise it
deliberately, in the same change that earns the bytes, and say why in a comment
next to the number.

## Release checklist

Releases are a person running these commands by hand, on purpose: no release
workflow, no publish automation.

1. Everything green: `pnpm lint && pnpm format:check && pnpm test:coverage &&
   pnpm test:types && pnpm size && pnpm run docs:build`.
2. Move `[Unreleased]` in `CHANGELOG.md` to the new version with today's date.
3. Bump `version` in `package.json`, and the matching nav label in
   `docs/.vitepress/config.mts` (the consistency test checks this).
4. Refresh the bundle-size table in `README.md` from `pnpm size`.
5. `npm publish --dry-run` — check the file list against `files`.
6. `npm pack`, then smoke the tarball: `require()` it from a scratch CJS file,
   and typecheck it with
   `npx tsc --moduleResolution bundler --module esnext --noEmit`.
7. Tag and push: `git tag v<version> && git push --tags`.
8. `npm publish`.
9. Write the GitHub release notes from the changelog section.
10. Verify the docs deploy:
    `curl -o /dev/null -sw '%{http_code}' https://syncomjs.vercel.app/`.
