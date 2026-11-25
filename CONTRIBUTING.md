# Contributing

Thanks for looking. This file covers how to work on `@alexify/syncom`, the
house rules that are not obvious from the code, and the release checklist.

## Setup

```bash
pnpm install
pnpm test
```

Requires **Node.js ≥ 24** (`engines`) and **pnpm** (`packageManager` pins the version).
There is no build step: `src/` ships as-is. `pnpm install` also links the alexiskills
skills into `.claude/skills` (the `prepare` script; CLAUDE.md, Skills).

## Commands

```bash
pnpm test              # node --test, recursive over tests/
pnpm test:package      # tests/package/*.test.js alone: exports, invariants, error codes, the guides' paths
pnpm test:coverage     # c8 over src/ — thresholds 95 lines / 95 statements / 90 branches / 95 functions
pnpm test:types        # tsd against the .d.ts files
pnpm lint              # oxlint (an unused disable comment is an error too)
pnpm format            # oxfmt (format:check in CI)
pnpm size              # bundle-size report; a browser budget exceeded fails the run
pnpm bench             # every script in bench/ (--save → bench/results/engine.json)
pnpm bench:compare     # against the alternatives (pnpm bench:compare:install first)
pnpm bench:size        # the browser bundles of syncom and the alternatives (the same install)
pnpm bench:report      # charts and tables of docs/guide/benchmarks.md and the README
pnpm docs:comparison   # the matrix of docs/guide/comparison.md from docs/comparison.json
pnpm docs:dev          # the VitePress site (docs:build / docs:preview too)
```

Run a single file with `node --test tests/storage.test.js`, or filter by name
with `node --test --test-name-pattern 'swap'`. `pnpm run prepublishOnly` runs
every gate a release needs but the docs build.

## House rules

- **CommonJS, `'use strict'`.** No build step, no transpilation. `src/` is what
  gets published — its `.js` and `.d.ts` files, never the `CLAUDE.md` notes beside
  them (`tests/package/pack.test.js`). `package.json` declares `"type": "commonjs"`: Node assumes it,
  Deno does not.
- **Loops, not array callbacks, in `src/`.** No `map`/`filter`/`find`/`some`/
  `every`/`forEach`/`reduce`/`flatMap`/`Array.from` there — `pnpm lint` fails on
  them (`no-restricted-properties` for `src/**`). One walk does what it can, a
  membership test in a loop is a `Set`, a data array is never spread into
  arguments (`push(...items)` throws past ~130 000 elements), and a new array
  is `[]` + `push` (`new Array(n)` stays holey and slower to read).
- **Zero runtime dependencies.** Everything in `package.json` is a
  devDependency, and `scripts/size.js` fails the run if a bare import reaches
  a browser bundle. If you need a helper, write it in `src/utils.js`.
- **Browser halves are named `*.browser.js`** and wired up through
  `package.json#browser` plus `src/index.browser.js`. A new split module needs
  an entry in both.
- **A `.d.ts` change and its `tsd` test land together.** `index.d.ts` is the
  Node surface; `browser.d.ts` re-exports it and overrides only the five
  crypto functions that are async in the browser (`calculateHash`, `encrypt`,
  `decrypt`, `sign`, `verify`). Each subpath has its own `.d.ts` and
  `tests/<name>.test-d.ts`.
- **Anything in `tests/` not named `*.test.js` is a helper** and is skipped by
  `node --test` discovery — that is why `tests/suites/`, `tests/utils/` and
  `tests/package/` work the way they do.
- **Document what the code does, not what it will do.** Run every example
  before writing it down.
- **wrpc is injected, never required.** `@alexify/wrpc` is a devDependency for
  `tests/wrpc.integration.test.js` only, which skips when it is missing; nothing
  under `src/` may `require` it. The adapter in `src/wrpc/wrpc.js` duck-types the
  client it is handed.
- **A field is one kind: a register, a counter, a set, a list, a text or a
  tree.** `set`/`update` write registers, `inc` counters, `add`/`remove` sets,
  `splice`/`push`/`updateText` lists and texts (`setAt`/`move` a list,
  `mark`/`unmark`/`unmarkById` a text), `treeMove`/`treeRemove` trees. A local
  write of another kind is refused before it is stamped; between peers the
  kinds' precedence decides — register, counter, set, list, text, tree — by
  the kinds alone, the same on the op path and in a snapshot merge. Do not add
  a path that decides a clash another way.
- **An adapted algorithm brings its notice.** Code or a rule taken from an MIT
  or BSD project is named in `THIRD_PARTY_NOTICES.md` — the project, the commit,
  the files that carry it — with the upstream notice. Projects under other
  licences (json-joy, Collabs, `fugue/fugue`) are read as specifications only;
  nothing is copied from them.

## Tests

`node:test` with `node:assert/strict`, as `describe` and `it` only: `describe`
names the subject, and every `it` title starts with `should` and says what is
observable (`it('should change nothing when the same op is applied twice')`).
No flat `test()`, no `t.test()`.

- **Setup goes in `before`, never in a describe body.** An `async` describe
  body runs when the file loads, at the same time as every other describe body
  of the file, before any `it`: a database opened there is opened next to every
  other suite's. Open it in `before` (or `beforeEach`) into a `let x = null` of
  the describe, close it in `after`; a teardown an `it` owns is `t.after(...)`
  of its own context.
- **What ran between two subtests stays between them**: the end of the earlier
  `it` or the start of the later one — never the describe body.
- **Errors are asserted precisely**: `assert.throws(fn, { code, name })`,
  `await assert.rejects(promise, { code: 'ALX_ERR_…' })`.
- **`--test-force-exit` stays, on purpose.** Every passing test closes what it
  opens, but a test that fails half-way skips its own teardown and can leave a
  `MessagePort`, a worker or a change stream open; without the flag that file's
  process never exits (one sat for eight hours after its last test). It never
  hides a leak of a passing test: a file that only exits under the flag is a bug.

Behaviour shared between the Node and browser halves lives in `tests/suites/`
and is run twice — see `tests/suites/emitter.js`, `tests/suites/fsi.js` and
`tests/suites/sync-engine.js`. The browser halves are exercised under Node.js
using the OPFS mock in `tests/utils/mock-opfs.js` and `node:crypto`'s
`webcrypto`; `tests/utils/browser-env.js` loads the shared modules the way a
bundler honouring `package.json#browser` would. The sync engine is tested over
`tests/utils/memory-link.js`, an in-process link that behaves like a wrpc
client at the boundary (JSON across, resume from the last event id on
reconnect), and once more over real wrpc in `tests/wrpc.integration.test.js`.

`INVARIANTS.md` names every guarantee — an id `PREFIX-n`, its prefix from the
prefix registry at the top of the file — with the tests that hold it, and
`tests/package/invariants.test.js` fails when an id names no test, a named
title is gone, a prefix is unregistered or a row is out of order: rename a test and its
row together, and give a new guarantee an id, a test and a row. The seeded
hazard walk in `tests/suites/sync-engine.js` — dropped and duplicated pages, a
reopen mid-walk — is the one that must stay green whatever else moves.
`tests/package/telemetry-events.test.js` keeps every logged `event:`, span and
metric in the table of `docs/reference/telemetry.md`.

`tests/package/consistency.test.js` is the machine-checked half of the release
checklist: it fails if `exports`, `files`, the `browser` map, the `.d.ts`
files, the `scripts/size.js` rows or the docs keywords/version drift from
`package.json`. When it goes red, the fix is usually the metadata, not the test.

## CI

The jobs of `.github/workflows/ci.yml`:

1. **lint** — `lint`, `format:check`, `test:package` (exports, invariants,
   error codes, the guides' paths), `size` (the last both smoke-tests the
   script and puts the numbers in the log).
2. **test** — matrix over Node `24.0.0` (the floor of `engines`, written
   exactly), 24 and 26: `test:coverage`, then `test:types`. Every test run has
   a 120 s timeout per test.
3. **docs** — `docs:build`, so a broken page or dead link fails the PR rather
   than the deploy.
4. **smoke-deno**, **smoke-bun** — `tests/smoke/smoke.js` on the other runtimes.
5. **ci-success** — the one job branch protection requires: it fails when a
   job it needs failed, was cancelled or was skipped.

Benchmarks are not run in CI: they measure a machine, not a change.

## Bundle size

`pnpm size` prints one row per `exports` entry and enforces a min+gzip budget
on every browser entry — the main one and each subpath. The budget is a
**ratchet, not a target**: raise it deliberately, in the same change that earns
the bytes, and say why in a comment next to the number. Since the core and
blocks plan (2026-10-25) the main entry is the core alone (budget 52 KB, about
44 measured) and every block a subpath with a budget of its own; `/all` is
held to 113.5 KB, and a composite row checks that the core and every block
bundled together weigh what `/all` weighs — nothing bundled twice. Every
raise names its feature, and a raise of more than a kilobyte is a design
decision (an engine subpath, an injected kind), taken in a plan, not in the
number.

## Release checklist

Releases are a person running these commands by hand, on purpose: no release
workflow, no publish automation.

1. Everything green: `pnpm run prepublishOnly` (`lint`, `format:check`,
   `test:types`, `size`, `test:package`, `test:coverage`) and
   `pnpm run docs:build`.
2. Move `[Unreleased]` in `CHANGELOG.md` to the new version with today's date,
   and add its link at the bottom.
3. Bump `version` in `package.json`, and the matching nav label in
   `docs/.vitepress/config.mts` (the consistency test checks this).
4. Refresh the bundle-size table in `README.md` from `pnpm size`.
5. `pnpm publish --dry-run` — check the file list against `files`.
6. `pnpm pack`, then smoke the tarball from a scratch consumer project (the one
   place `npm` and `npx` are used): `npm install` the tarball there, `require()`
   it from a CJS file, and typecheck it with
   `npx tsc --moduleResolution bundler --module esnext --noEmit`.
7. Commit `chore(release): X.Y.Z`, then tag and push:
   `git tag vX.Y.Z && git push --tags`.
8. `pnpm publish` (gated by `prepublishOnly`).
9. Write the GitHub release notes from the changelog section.
10. Verify the docs deploy:
    `curl -o /dev/null -sw '%{http_code}' https://syncomjs.vercel.app/`.
