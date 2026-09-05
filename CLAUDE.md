# CLAUDE.md

Repo-specific notes for agents working on `@alexify/syncom`. Read
[CONTRIBUTING.md](./CONTRIBUTING.md) too — this file only adds what is easy to
get wrong.

## What this package is

A local-first data engine: records on disk (or OPFS), every write committed to
a hash-linked log AND appended to an operation log that peers replicate over
an injected transport (wrpc through `@alexify/syncom/wrpc`). **Zero runtime
dependencies**, and that is a load-bearing constraint, not a preference — wrpc
is a devDependency for one skip-guarded integration test and is otherwise an
object the caller hands in.

## Layout

```
index.js / browser.js     two-line shims over src/index.js / src/index.browser.js
wrpc.js / wrpc.d.ts       the @alexify/syncom/wrpc subpath (src/wrpc.js)
index.d.ts                the Node type surface (hand-written)
browser.d.ts              re-exports index.d.ts, overrides the 3 async crypto fns
src/storage.js            Storage, Record, Collection — every write is an op
src/ops.js                the record-level model: applyOp / mergeEntry / isAlive, packOps
src/vector.js             clocks, version vectors, event ids
src/log.js                OpLog — the persisted operation log over fsi
src/sync.js               SyncManager (dialing side) + unit() (hosting side)
src/link.js               isSyncLink — the link contract check
src/wrpc.js               createWrpcLink — a WrpcClient as a SyncLink (no wrpc import)
src/                      ships as-is — no build step, CommonJS, 'use strict'
tests/                    *.test.js are tests; anything else is a helper
bench/                    one file per subject + support/harness.js
scripts/size.js           bundle-size report with browser budgets
docs/                     VitePress site
```

## Rules that bite

- **CommonJS everywhere in `src/`.** No `import`, no `type: module`, no build.
- **No runtime dependencies.** Helpers go in `src/utils.js`. `scripts/size.js`
  fails at resolve time on any bare import reaching a browser bundle, so a
  stray `require('some-pkg')` in shared code breaks `pnpm size`, not just the
  dependency count.
- **Browser halves are `*.browser.js`** (dot, not dash): `fsi`, `crypto`,
  `utils`. Everything else (storage, chain, log, ops, sync, wrpc adapter) is
  shared. Adding a split means three edits: the file, `package.json#browser`,
  and `src/index.browser.js`. `tests/package/consistency.test.js` catches a
  missed one. To run shared code against the browser halves under Node, load
  it through `tests/utils/browser-env.js` — requiring `src/index.browser.js`
  alone does NOT redirect the nested requires.
- **wrpc is injected, never required.** Nothing under `src/` may
  `require('@alexify/wrpc')`; `scripts/size.js` fails on any bare import in a
  browser bundle anyway. `src/wrpc.js` duck-types the client it is handed, and
  `unit()` builds plain `{ access, handler }` objects that `defineRouter`
  accepts without wrpc's `procedure()`. The `tracked` shape it emits is
  `Symbol.for('wrpc.tracked')` — part of wrpc's frozen wire protocol.
- **Every write is an op, and a field is a register OR a counter.** `insert`/
  `set` → `write`, `update`/`swap`/`record.save` → `set`, `inc` → `inc`,
  `delete` → tombstone. Registers are last-writer-wins by `(ts, origin)`;
  counters are per-origin sums. Mixing the two on one field throws locally and
  is refused (with an `error` event) from a peer. Do not add a path that lets
  them meet — it cannot be made to commute.
- **Ops from one origin apply in seq order; seqs run per origin AND scope**
  (`origin@scope` vector keys), and ops born from a snapshot (`merge`,
  `advance`) run in their own `origin@~` stream. `applyRemote` skips
  duplicates and gaps; resume from the last event id fills the gaps.
- **Log first, then data.** `OpLog.append` resolves before the record file is
  written and before the op is announced; a reopen replays the unsealed tail.
  A node's own seq must never repeat — it is recovered from the log's vector.
- **Stamps come from `#clock.now()` after the clock has observed everything
  the node holds for the record.** `[COMMIT]` in `src/storage.js` does that
  (`latestClock` over the entry's meta, and the joined meta for a `merge`) and
  `Storage.#init` seeds the clock from `log.latestTs`; `applyRemote` observes
  every peer op. A stamp taken any other way can sort below state the node
  already has, and `applyOp` then drops the write silently (`changed` false,
  `COMMIT` returns null). Do not add a second write path; go through
  `[COMMIT]`.
- **Reconnect/backoff/resume belong to the link.** `SyncManager` re-runs only
  `hello` + `push` on `reconnect`; a refused restored subscription (428 "say
  hello first" — wrpc gives a reconnect a NEW server-side client) triggers a
  fresh handshake. Do not add a reconnect loop to syncom.
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
  examples that assume replacement. Storage does NOT replicate through
  `merge`; the op model in `src/ops.js` is what converges.
- **Encrypted records are local.** `{ encrypted: true }` seals a record for
  this node's key; it produces no op and is excluded from snapshots. Do not
  route an encrypted entry through `applyOp`.

## Testing

`node:test` + `node:assert`. Browser halves run under Node with the OPFS mock
(`tests/utils/mock-opfs.js`) and `node:crypto`'s `webcrypto` — see
`tests/index.browser.test.js`. Cross-platform behaviour goes in `tests/suites/`
and is run against both halves; `tests/suites/sync-engine.js` runs the
convergence properties over `tests/utils/memory-link.js` (an in-process link
that mimics a wrpc client: JSON across the boundary, a reconnect re-opens the
subscription from its last event id against a fresh server-side client) and
`tests/utils/mesh.js` (N storages from an adjacency list, `settle()`).
`tests/wrpc.integration.test.js` runs two real wrpc `Server`s and a dialer, and
skips when `@alexify/wrpc` is not installed. Two things bite there: two nodes'
clocks are independent, so "later" needs a `tick()` between writes on
different nodes; and `settle()` ignores `@~` vector keys, because a node's
bootstrap stream never reaches the node it bootstrapped from.

Coverage thresholds (95/95/90/95) are enforced in CI. They currently pass with
headroom; do not lower them to land a change.

## Documentation

Document what the code does today. When adding docs, verify each example by
running it before writing it down — several examples inherited from the legacy
repo were wrong in exactly that way. A new page needs a sidebar entry in
`docs/.vitepress/config.mts`; `docs/guide/sync.md` and `docs/guide/wrpc.md`
are the two pages that describe the protocol — keep them in step with
`src/sync.js`.

## Formatting

`oxlint` + `oxfmt`, not eslint/prettier. `printWidth` is 120. Run
`pnpm format` before committing; CI runs `format:check`.
