# CLAUDE.md

Repo-specific notes for agents working on `@alexify/syncom`. Read
[CONTRIBUTING.md](./CONTRIBUTING.md) too — this file only adds what is easy to
get wrong.

## What this package is

A local-first data engine: records on disk (or OPFS), every write committed to
a hash-linked log, CRDT deltas for merging. **Zero runtime dependencies**, and
that is a load-bearing constraint, not a preference.

## Layout

```
index.js / browser.js     two-line shims over src/index.js / src/index.browser.js
index.d.ts                the Node type surface (hand-written)
browser.d.ts              re-exports index.d.ts, overrides the 3 async crypto fns
src/                      ships as-is — no build step, CommonJS, 'use strict'
tests/                    *.test.js are tests; anything else is a helper
bench/                    one file per subject + support/harness.js
scripts/size.js           bundle-size report with a browser budget
docs/                     VitePress site
```

## Rules that bite

- **CommonJS everywhere in `src/`.** No `import`, no `type: module`, no build.
- **No runtime dependencies.** Helpers go in `src/utils.js`. `scripts/size.js`
  fails at resolve time on any bare import reaching a browser bundle, so a
  stray `require('some-pkg')` in shared code breaks `pnpm size`, not just the
  dependency count.
- **Browser halves are `*.browser.js`** (dot, not dash). Adding one means
  three edits: the file, `package.json#browser`, and `src/index.browser.js`.
  `tests/package/consistency.test.js` catches a missed one.
- **Async asymmetry is real.** `calculateHash`, `encrypt` and `decrypt` are
  synchronous in `src/crypto.js` and promise-returning in
  `src/crypto.browser.js`. Shared code must `await` them; `browser.d.ts`
  exists to declare that difference. Do not "fix" it by making the Node half
  async.
- **A `.d.ts` change and its `tsd` test land together** (`tests/*.test-d.ts`).
- **`tests/package/consistency.test.js` guards the metadata.** If it goes red
  after you add an entry point, update `exports`, `files`, the `browser` map,
  `scripts/size.js` `ENTRIES` and the docs keywords — the test is right.
- **Constructors that return promises.** `Storage`, `Blockchain` and
  `SyncManager` all `return this.#init()` from the constructor, so they are
  used as `await new Blockchain(path)`. The types model this; keep it that way.
- **`merge` adds numbers.** `merge({ hits: 10 }, { hits: 1 })` is `11`. This is
  the counter CRDT and it is deliberate — but it means a `diff` of numeric
  fields is not a plain patch. Do not "correct" it, and do not write docs or
  examples that assume replacement.

## Testing

`node:test` + `node:assert`. Browser halves run under Node with the OPFS mock
(`tests/utils/mock-opfs.js`) and `node:crypto`'s `webcrypto` — see
`tests/index.browser.test.js`. Cross-platform behaviour goes in `tests/suites/`
and is run against both halves.

Coverage thresholds (95/95/90/95) are enforced in CI. They currently pass with
headroom; do not lower them to land a change.

## Documentation

Document what the code does today. `sync.start()` is a no-op and every page
that mentions it says so. When adding docs, verify each example by running it
before writing it down — several examples inherited from the legacy repo were
wrong in exactly that way.

## Formatting

`oxlint` + `oxfmt`, not eslint/prettier. `printWidth` is 120. Run
`pnpm format` before committing; CI runs `format:check`.
