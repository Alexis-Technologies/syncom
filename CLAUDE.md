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
contracts.js / .d.ts      the @alexify/syncom/contracts subpath (src/contract.js) — never back in the barrel
idb.js / idb.d.ts         the @alexify/syncom/idb subpath (src/idb.js) — the IndexedDB backend, browser-only
index.d.ts                the Node type surface (hand-written)
browser.d.ts              re-exports index.d.ts, overrides the 3 async crypto fns
src/backend.js            the fsi contract (isFsi/checkFsi), createMemoryFsi, withSync — no requires
src/emitter.js            the Emitter both halves extend — no requires
src/logger.js             createLogger, the duck-typed logger writer — no requires
src/keys.js               loadKeyPair — the on-disk key pair, generator injected by each crypto half — no requires
src/scope.js              GLOBAL_SCOPE, inScope — the one definition of "in scope" — no requires
src/lock.js               exclusive open: Web Locks or lock.json, stale by pid or age — no requires
src/catalog.js            the record catalog: live ids, collections, indexed values; index/catalog.json — no requires
src/query.js              compileQuery (Mango predicate), compareRows, Cursor — reads through storage[SOURCE]
src/shared-log.js         isSharedLog — the reserved broker-log contract (wrpc BrokerLog shape), no consumer yet
src/storage.js            Storage, Record, Collection — every write is an op
src/schema.js             entity definitions, the injected validator (Standard Schema / ajv / compile), ValidationError
src/ops.js                the record-level model: applyOp / mergeEntry / isAlive, packOps
src/vector.js             clocks, version vectors, event ids
src/log.js                OpLog — the persisted operation log over fsi
src/sync.js               SyncManager (dialing side) + unit() (hosting side)
src/link.js               isSyncLink — the link contract check
src/wrpc.js               createWrpcLink — a WrpcClient as a SyncLink (no wrpc import)
src/telemetry.js          the injected-OpenTelemetry writer (duck-typed; @opentelemetry/* only devDeps)
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
  `utils`. Everything else (storage, chain, log, ops, sync, wrpc adapter,
  and the require-free `emitter`, `logger`, `keys`, `scope`) is shared; the
  two `utils` halves only re-export `Emitter`/`createLogger` and add the
  platform's own bits. Adding a split means three edits: the file, `package.json#browser`,
  and `src/index.browser.js`. `tests/package/consistency.test.js` catches a
  missed one. To run shared code against the browser halves under Node, load
  it through `tests/utils/browser-env.js` — requiring `src/index.browser.js`
  alone does NOT redirect the nested requires.
- **WebRTC is wrpc's.** There is no transport code in `src/` and must not
  be: a `PeerLink.remote` is a `WrpcClient`, `createWrpcLink(link.remote)`
  takes it, and `unit()` mounts on a `PeerHost`. The integration test runs
  over `tests/utils/fake-channel.js` (a fake data-channel pair) at the
  raw-channel level; a full `WrpcPeer` needs an RTC adapter and is checked
  by hand. Anything WebRTC-shaped that seems missing belongs in wrpc.
- **wrpc is injected, never required.** Nothing under `src/` may
  `require('@alexify/wrpc')`; `scripts/size.js` fails on any bare import in a
  browser bundle anyway. `src/wrpc.js` duck-types the client it is handed, and
  `unit()` builds plain `{ access, handler }` objects that `defineRouter`
  accepts without wrpc's `procedure()`. The `tracked` shape it emits is
  `Symbol.for('wrpc.tracked')` — part of wrpc's frozen wire protocol.
- **A record id is checked where it enters, nowhere else.** `isRecordId` in
  `src/storage.js` (`[A-Za-z0-9_@-][A-Za-z0-9._@-]{0,127}`) guards `[COMMIT]`
  (every local writer), `insert` (what `getId` minted), the malformed check
  of `#applyRemote` and `mergeSnapshot`; `#load` answers `null` for anything
  else. An id is a file name on three platforms — do not widen the class, and
  do not add a writer that reaches `#writeEntry` without passing one of those.
- **A peer's op is `wellFormed` or it is nothing.** `#applyRemote` checks
  `origin`/`scope` (no `@`, no control characters), `seq`/`ts` (positive safe
  integers), `type`, `v` and the id before reading anything else (`actor`
  and `from` are claims, carried as they are); a stamp beyond `sync.maxSkew`
  ahead of `Date.now()` is refused the
  same way (`SKEW`), never observed into the clock. `malformed` ops are
  counted, not logged, not relayed. Payload shape is `applyOp`'s business.
- **Scopes are enforced by the host.** `unit().push` drops out-of-scope ops
  before `applyRemote` (`refused` event, `syncom.ops.rejected{scope}`);
  `snapshot`/`changes` serve `grant(asked, granted)`. `applyRemote`'s
  `scopes` option only gates `advance` adoption, and adoption needs
  `adoptFrom === op.origin` — the host a feed is read from. Never adopt on the
  push path.
- **`ops.js` walks own keys only.** `Object.keys` + `isKey` (`__proto__` is
  never a field) + `own()` for every lookup into `meta.clock`/`meta.counters`;
  `normalizeMeta` deep-copies a peer's meta into the trusted shape. A
  `for...in` or a bare `obj[key]` over peer-shaped data is a bug.
- **The chain is optional, the log is not.** `open({ chain: false })` leaves
  `#chain` null: `#commit`, `#persistBatch` and `#writeEncrypted` write
  `block: null`, `#verify` is forced off, `validate()` throws `NO_CHAIN`. A
  new place that reads `this.#chain` must take null.
- **`via` is a descriptor, never the link.** `peer.ref` (`{ url, node }`,
  `node` filled by hello) is what `change`, `apply` and the apply hooks get
  on the dialing side; the host's is `state.ref` (`url` null). `#fanOut`
  compares `peer.ref === via`. Never hand the peer object, the link or the
  wrpc client out of `SyncManager`: they carry the token and the socket.
- **Live Records are weak.** `#records` holds `WeakRef`s (a
  `FinalizationRegistry` clears the slot); go through `#live(id)`, never
  `#records.get`. A Record the application still holds pins its cache entry;
  one it dropped is collected with its pin.
- **A purge is a scrub, not a delete.** `purge` wins at any stamp and a
  purged entry takes nothing but another purge or a merge (`applyOp`
  returns early). The payload leaves the log through `OpLog.scrub(id)`,
  which rewrites files in place; `#applyRemote` scrubs every id of the
  batch whose entry is purged, after the batch is durable and before the
  relay. Never log a payload for a purged id through another path.
- **`packOps` is 14 positional slots, both halves together.** `v` (13) and
  `actor` (14) were appended; a reader of fewer slots ignores the rest, a
  reader of more takes an absent slot as null. Append, never reorder — the
  shape is on the wire between every pair of peers (the log itself stores
  keyed `{ seq, op }` JSON; `packOps` is for `push` and `changes` only).
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
  The storage opens its log with `sealApplied: true` and calls
  `log.applied(from, to)` after `#writeEntry`/`#persistBatch`; a roll then
  seals nothing from the oldest batch not yet applied onwards. A new path
  that appends must mark what it applied, or the tail grows forever.
- **A failed page is a break in the stream.** `#receive` runs pages one after
  another per peer (`peer.inbound`), numbered by `peer.feed`; a rejection goes
  to `#pageFailed`, which closes the feed (pages of the old feed are dropped),
  reports `PAGE_FAILED` with the saved cursor, and resubscribes from it —
  `STUCK` after `MAX_PAGE_RETRIES`. Never move `node.cursor` past a page that
  did not land, and never catch inside `#receive` to "keep going".
- **Data crosses the boundary as JSON copies.** `#commit` copies `payload.data`/
  `payload.meta` (`asJson`) before anything keeps a reference; `#read` and
  `Cursor.fetch()` hand out copies. `getCachedData()` and `snapshot()` are the
  raw objects on purpose. Do not return `entry.data` from a public method.
- **Stamps come from `#clock.now()` after the clock has observed everything
  the node holds for the record.** `#commit` in `src/storage.js` does that
  (`latestClock` over the entry's meta), `#mergeBatch` does it over the
  entry's meta AND the joined meta, and `Storage.#init` seeds the clock from
  `log.latestTs`; `applyRemote` observes every peer op. A stamp taken any
  other way can sort below state the node already has, and `applyOp` then
  drops the write silently (`changed` false, `COMMIT` returns null). There
  are exactly three write paths — `#commit` (a local op, through `[COMMIT]`),
  `#applyRemote` (a peer's page), `#mergeBatch` (a snapshot page, through
  `mergeSnapshot`) — all inside `#run`, all ending in `#persistBatch` or
  `#writeEntry`. Do not add a fourth.
- **Reconnect/backoff/resume belong to the link.** `SyncManager` re-runs only
  `hello` + `push` on `reconnect`; a refused restored subscription (428 "say
  hello first" — wrpc gives a reconnect a NEW server-side client) triggers a
  fresh handshake, at most `MAX_REHELLOS` in a row. Do not add a reconnect
  loop or a timer to syncom: a failed push marks the peer `behind` and
  `#recover` pushes from the vector at the next sign of life on the link (a
  page in `#receive`, an op in `#fanOut`) or on `sync()`, backed off by a
  timestamp. Every push goes through `#serializePush` — never call
  `#sendPages` from a new place.
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
- **Telemetry is injected, never required.** `createTelemetry` in
  `src/telemetry.js` duck-types whatever `open({ telemetry })` was given and
  returns a writer; `DISABLED` is a frozen null-object whose `withSpan` still
  runs its callback, so call sites bracket work the same way on or off (but
  guard with `otel.enabled` before allocating attributes or reading the
  clock). syncom never puts trace context into ops — `tp`/`ts` are wrpc's,
  ops are durable — and its spans nest under the active context instead.
  Never mint a metric label from a record id, an origin, a peer url or a
  scope. Every `catch {}` in the writer has a hostile-implementation test in
  `tests/telemetry.test.js`; keep it that way or the branch threshold drops.
  The observable gauges are registered once, in `#open`, through
  `otel.gauges(read)`; `includeIdentity: false` strips `IDENTITY_KEYS` (the
  scope among them) at span start AND end and records a failure's `code`
  rather than the exception. A new `event:` name goes into the table in
  `docs/guide/telemetry.md` — the names are a surface.
- **Encrypted records are local.** `{ encrypted: true }` seals a record for
  this node's key; it produces no op and is excluded from snapshots. Do not
  route an encrypted entry through `applyOp`.
- **A cursor reads through `storage[SOURCE]`, not through `get()`.** The
  seam hands it the catalog and a lensed, hook-free `load(id)` — like
  `snapshot()` and `swap()`. Unique keys are checked after validation and
  the fold, before `#log.append` (local: throw) and after `applyOp` on the
  apply path (remote: `conflict` event, never a skip — both records stay).
- **The catalog is derived state, kept at one seam.** `#writeEntry` (both
  write paths go through it), `#writeEncrypted` and `#removeEncrypted` are
  the only places that `catalog.put`; it indexes the lensed view and never
  fails a write (a throwing lens is logged and the raw data indexed).
  `#flushCatalog` saves it OFF the mutation queue — `Catalog.save` takes the
  rows and the stamp before its first await, one save in flight at a time,
  `close()` awaits it — so a write never waits for the catalog file. Do not
  `await` a save inside `#commit`/`#applyRemote`.
  `list()`/`hasRecord()` read it, and so does `snapshot()`: a tombstone is a
  row flagged `gone` (there, not listed), so a page is a slice of
  `catalog.all()` and never a directory listing. A new way of changing a
  record's file must put too, or the catalog lies until the next rebuild.
- **`open()` is exclusive by default (`lock: 'fail'`).** A test that opens
  the same directory twice must `close()` the first storage or pass
  `lock: false`; `bench/storage.js` does the latter. Never weaken the
  default to make a test pass — two instances minting the same seq is the
  bug the lock exists for. `acquireLock` prefers `fsi.create` (exclusive) and
  falls back to write-then-read-back; `open({ lock: { ... } })` is the object
  form (`normalizeLock`).
- **fsi is injected.** `open({ fsi })` reaches storage, log, chain, keys and
  the registry as `this.#fsi` (or the `fsi` parameter of `loadKeys`); the
  module-level `require('./fsi.js')` is only the default. A new `fsi.` call
  on the module object is a bug — it bypasses the adapter the caller gave.
- **Validation is after `applyOp`, before `#log.append`.** An entity's
  validator (`src/schema.js`, no requires — it ships to the browser) sees
  the record as the op leaves it, under `idField` and without `$type`, and
  for a local `write`/`set` what it returns is folded back INTO the op
  (defaults, aliases, stripped keys), so peers receive the validated record;
  a `set` keeps only its own keys plus the ones the record lacked and is
  never promoted to a `write`. A peer's op is never rewritten: the verdict
  alone decides, and a failing op is skipped exactly like a `beforeApply`
  false (`skipped: true`, vector moves, relayed, `error` event). `$type` is
  immutable on the local path and restored after every fold. Validators are
  `~standard`, a function, or `validator.compile` — do not add a fourth
  duck-type.
- **Hooks run inside the operation; events never do.** `src/hooks.js` (no
  requires — it ships to the browser) is the whole mechanism. Storage hooks
  go through `#hook()` inside the mutation queue, and `#run` refuses a write
  while one is running — a write from a hook would wait for the hook that
  waits for it. Hook calls live in `#commit`, `get`, `#applyRemote`,
  `#connect` and `#bootstrap` only; there is deliberately no hook on the ops
  that leave for a peer (a withheld op is a gap that stops that stream —
  scopes are the per-peer filter). Only the hooks that run inside the
  mutation queue go through `#hook` and its `#inHook` guard; `beforeRead`/
  `afterRead` call `runHook` directly — a write from a read hook queues. Every event leaves through `notify()`:
  never `await this.emit(...)`, never emit `error` any other way (the Emitter
  throws on an unheard `error`, and that throw used to fail a push before the
  vector moved). A remote op a `beforeApply` skipped is still appended, with
  `skipped: true` on its log entry — that flag is what keeps `#replayTail`
  from applying it on reopen; do not strip it.

## Testing

`node:test` + `node:assert`. Browser halves run under Node with the OPFS mock
(`tests/utils/mock-opfs.js`) and `node:crypto`'s `webcrypto` — see
`tests/index.browser.test.js`. Cross-platform behaviour goes in `tests/suites/`
and is run against both halves (`schema`, `catalog`, `query`, `purge`, `hooks`,
`fsi`, `sync-engine`, each with a `*.test.js` and a `*.browser.test.js`
wrapper); `tests/suites/sync-engine.js` runs the
convergence properties over `tests/utils/memory-link.js` (an in-process link
that mimics a wrpc client: JSON across the boundary, a reconnect re-opens the
subscription from its last event id against a fresh server-side client) and
`tests/utils/mesh.js` (N storages from an adjacency list, `settle()`).
`tests/wrpc.integration.test.js` runs two real wrpc `Server`s and a dialer,
the `onRequest` rate-limit recipe of `docs/guide/scaling.md` (keep the two in
step), plus syncom over a fake WebRTC data channel
(`tests/utils/fake-channel.js`) attached to an `RpcServer` and to a
`PeerHost`, and skips when `@alexify/wrpc` (2.x) is not installed. Two things bite there: two nodes'
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
`src/sync.js`, `docs/guide/hooks.md` with the hook and event surface of
`src/storage.js` and `src/sync.js`, `docs/guide/schema.md` with
`src/schema.js` (metaschema is the first-class example there; zod/ajv/JSON
Schema are the alternatives), `docs/guide/query.md` with `src/query.js` and
`src/catalog.js`, `docs/guide/backends.md` with `src/backend.js`, `src/lock.js`
and the two `fsi` halves. The browser-only WebRTC recipes in
`docs/guide/webrtc.md` follow wrpc's documented API and the raw-channel
integration tests; they cannot be run here.

## Skills

`.claude/skills/` holds six of the seven [metaskills](https://github.com/metarhia/metaskills)
v1.0.5 skills that `metaschema` carries: `js-conventions`, `js-data-structures`,
`data-structures`, `js-gof`, `error-handling` and `npm-publish`.

- **`js-conventions` is adapted to this repo:** oxlint/oxfmt, pnpm, 120 columns, `'use strict'`
  in every `src/` file, `node:` prefix and `.js` in relative requires, no runtime dependencies,
  and the error and hot-path rules of this engine. `forEach` and `reduce` are avoided by
  convention here, not by a lint rule.
- **`npm-publish` is adapted to the release checklist in CONTRIBUTING.md:** the CI gates, the
  hand-synced docs nav version, the size table, and the first-release notes (nothing is
  published yet). It never publishes.
- **The other four are verbatim copies.** `metautil-data-structures` is left out on purpose: it
  documents the `metautil` package, and this one takes no runtime dependencies.

Keep the two adapted skills in sync with this file and CONTRIBUTING.md. **This file wins** if
they ever disagree.

## Formatting

`oxlint` + `oxfmt`, not eslint/prettier. `printWidth` is 120. Run
`pnpm format` before committing; CI runs `format:check`.
