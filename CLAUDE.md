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
search.js / search.d.ts   the @alexify/syncom/search subpath (src/search.js) — the trigram text index behind `$text`; the core knows only the TextIndex contract
order.js / order.d.ts     the @alexify/syncom/order subpath (src/order.js) — fractional indexes as strings, for ordering records
undo.js / undo.d.ts       the @alexify/syncom/undo subpath (src/undo.js) — the undo stack over the commit event; requires patch.js, emitter.js only
branch.js / branch.d.ts   the @alexify/syncom/branch subpath (src/branch.js) — fork a storage, merge either way; never requires storage.js
index.d.ts                the Node type surface (hand-written)
browser.d.ts              re-exports index.d.ts, overrides the 3 async crypto fns
THIRD_PARTY_NOTICES.md    the MIT notices of the algorithms adapted (Fugue, Yjs, list-positions…) and the files that carry them
src/backend.js            the fsi contract (isFsi/checkFsi), createMemoryFsi, withSync — no requires
src/emitter.js            the Emitter both halves extend — no requires
src/logger.js             createLogger, the duck-typed logger writer — no requires
src/keys.js               loadKeyPair — the on-disk key pairs (RSA for sealing, Ed25519 for signing), generator injected by each crypto half — no requires
src/scope.js              GLOBAL_SCOPE, inScope, opInScope — the one definition of "in scope" — no requires
src/signing.js            canonical form, signOp, verifyOp — what a signature covers (the header + a salted payload digest) and the verdict on a peer's op
src/shape.js              isPlainObject, asJson, isRecordId, isStreamName, wellFormed — what enters is checked here
src/args.js               spliceArgs, treeArgs, markArgs, setElements, jsonValue, isNodeId — the write API’s argument
                          checks, shared by Storage and realize() in patch.js — no requires
src/rle.js                run-length content: a run's items and gaps, cut, append, merge, the canonical form under MAX_RUN —
                          no requires; sequence.js is the caller and re-exports what the tests read
src/sequence.js           the sequence engine behind the list and text kinds: Fugue runs, the walk, local placement, pending ops,
                          pos/vals/marks registers, cursors, prune and join — requires vector.js and rle.js only
src/tree.js               the tree kind: per node its stamped moves, the fold in stamp order with the cycle check (Kleppmann
                          2021, Loro), MAX_DEPTH levels read, prune and join — requires vector.js and order.js (a place is a
                          fractional index or the move is malformed)
src/order.js              fractional indexes over a 62-letter alphabet (Loro's rule, MIT) — no requires; the core uses it for a tree's places
src/history.js            the past out of the log: a version (event id / stamp / vector) as a cut, the exact start above droppedTs, the fold
src/tags.js               Tags — named versions kept locally: tags.json, a catalog per tag, copy-on-write record files in the newest tag
src/patch.js              patches — the one vocabulary of diff()/applyPatches()/restore(): diffViews by kind, realize() to an op — requires shape.js, myers.js only
src/undo.js               UndoManager — steps of inverse patches from `commit` events, refuse-to-overwrite, pins the log; the core does not use it
src/outbound.js           outbound(log, { exclude, vector, scopes, own }) — the ops a receiver lacks, the first retained seq per own stream; a push and a merge both pick with it
src/branch.js             branch/merge/branchInfo/drop — a fork opened through parent.constructor, merged as ops through applyRemote
src/errors.js             SyncomError (an operational failure, with a code) and typed() — no requires
src/symbols.js            COMMIT / REFRESH / SOURCE — the module-private seams between Storage and what it hands out — no requires
src/options.js            normalizeStorageOptions — open()'s plain options checked and defaulted (lock, cache, chain, skew…)
src/protocol.js           PROTOCOL, DEFAULT_PAGE_SIZE, schemaOf — what both halves of the sync protocol agree on — no requires
src/lock.js               exclusive open: Web Locks or lock.json, stale by pid or age — no requires
src/catalog.js            the record catalog: live ids, collections, indexed values; index/catalog.json — no requires
src/query.js              compileQuery (Mango predicate), compareRows, Cursor — reads through storage[SOURCE]
src/shared-log.js         isSharedLog — the reserved broker-log contract (wrpc BrokerLog shape), no consumer yet
src/storage.js            Storage — the facade: open sequence, the mutation queue, the public API, the `core` it lends
src/fields.js             the API of the field kinds beyond registers — inc/add/remove, splice…treeRemove, spans/cursor/index —
                          over the lent core; Storage keeps a delegate per method
src/versions.js           the versions API — get(id, { at }), history, diff/applyPatches/restore/compact, tag/untag/at — over the
                          lent core; Storage keeps a delegate per method
src/entries.js            EntryStore — record files under data/, the bounded cache, the catalog row each change leaves
src/record.js             Reference, Record, Collection — what the application holds; public API + the symbols only
src/commit.js             the one local write path: prepare → validate → persist → announce (`storage[COMMIT]`)
src/apply.js              a peer's batch: admit → apply one by one → persist → announce (`storage.applyRemote`)
src/bootstrap.js          snapshot pages out, merge pages in, adoptVector — the bootstrap write path
src/schema.js             entity definitions, the injected validator (Standard Schema / ajv / compile), ValidationError
src/ops.js                the record-level model: applyOp / mergeEntry / isAlive, packOps
src/vector.js             clocks, version vectors, event ids
src/log.js                OpLog — the persisted operation log over fsi
src/sync.js               SyncManager — the dialing side; `unit()` delegates to hosting.js
src/hosting.js            createUnit — the hosting side: hello/push/snapshot/changes, limits, grant()
src/link.js               isSyncLink — the link contract check
src/wrpc.js               createWrpcLink — a WrpcClient as a SyncLink (no wrpc import)
src/telemetry.js          the injected-OpenTelemetry writer (duck-typed; @opentelemetry/* only devDeps)
src/                      ships as-is — no build step, CommonJS, 'use strict'
tests/                    *.test.js are tests; anything else is a helper
bench/                    one file per subject + support/harness.js; run-all.js skips compare.js and report.js
bench/compare/            the cross-library comparison: its OWN package.json (the alternatives, never syncom's
                          devDependencies), adapters/ (one per library), worker.js, size.js
bench/report/             model.mjs (what every chart shows) + svg.mjs (README images); bench/report.js writes both
bench/results/            compare.json, size.json, engine.json — the inputs of the charts, committed
docs/comparison.json      the feature matrix; scripts/comparison.js renders it into docs/guide/comparison.md
scripts/size.js           bundle-size report with browser budgets
docs/                     VitePress site
```

## Rules that bite

- **An adapted algorithm brings its notice.** Code or a rule taken from an MIT project is named in
  `THIRD_PARTY_NOTICES.md` (project, commit, the syncom files that carry it) with the upstream notice.
  Nothing is copied from json-joy (AGPL-3.0), Collabs or `fugue/fugue` (Apache-2.0) — those are read
  as specifications only; the clones live in `../open-source/local-first-alternatives/`.
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
  `unit()` (`src/hosting.js`) builds plain `{ access, handler }` objects that
  `defineRouter` accepts without wrpc's `procedure()`. The `tracked` shape it emits is
  `Symbol.for('wrpc.tracked')` — part of wrpc's frozen wire protocol.
- **Every operational error is a `SyncomError` with a `code`.** `src/errors.js`:
  a failure that can happen to correct calling code — given the data, the
  files or the peers — is `new SyncomError(code, message, { cause, ...fields })`,
  and its code is in the `SyncomErrorCode` union of `index.d.ts` and the table
  in `docs/reference/api.md` (one row per code: who raises it, which fields
  ride on it). A wrong argument, option or hook result is a `TypeError`
  without a code, except `typed(code, message)` for a value that is data
  (`INVALID_ID`, `TYPE_IMMUTABLE`) or configuration (`NO_CHAIN`). A host's
  wire refusal (`coded` in `src/hosting.js`) keeps the numeric code wrpc
  carries and names the check in `reason`. `HookError` and `ValidationError`
  extend `SyncomError`. Never `new Error(...)` for something a caller may
  handle, never invent a code without its row in the table and the union.
- **A record id is checked where it enters, nowhere else.** `isRecordId` in
  `src/shape.js` (`[A-Za-z0-9_@-][A-Za-z0-9._@-]{0,127}`) guards `[COMMIT]`
  (every local writer), `insert` (what `getId` minted), `admit` in
  `src/apply.js` (the malformed check) and `mergeOne` in `src/bootstrap.js`;
  `EntryStore.load` answers `null` for anything else. An id is a file name on
  three platforms — do not widen the class, and do not add a writer that
  reaches `EntryStore.write` without passing one of those.
- **A peer's op is `wellFormed` or it is nothing.** `admit` (`src/apply.js`) checks
  `origin`/`scope` (no `@`, no control characters), `seq`/`ts` (positive safe
  integers), `type`, `v` and the id before reading anything else (`actor`
  and `from` are claims, carried as they are); a stamp beyond `sync.maxSkew`
  ahead of `Date.now()` is refused the
  same way (`SKEW`), never observed into the clock. `malformed` ops are
  counted, not logged, not relayed. Payload shape is `applyOp`'s business.
- **Scopes are enforced by the host.** `unit().push` drops out-of-scope ops
  before `applyRemote` (`refused` event, `syncom.ops.rejected{scope}`);
  `snapshot`/`changes` serve `grant(asked, granted)`. The scope an op declares
  is the peer's word: `push` also passes the grant as `bound`, and
  `applyRemote` refuses an op whose RECORD — before the op and after it, as
  this node's `sync.scope` reads it — is outside it (`outOfScope`, not logged,
  not relayed: a gap, like a forged op; relaying it as skipped would hand the
  write to every peer of the declared scope). A local op takes the scope of
  the record as it leaves it (`scopeData` in `src/commit.js`, re-read after
  validation), never of a `set`'s delta alone. `applyRemote`'s `scopes`
  option only gates `advance` adoption, and adoption needs
  `adoptFrom === op.origin` — the host a feed is read from. Never adopt on the
  push path.
- **`ops.js` walks own keys only.** `Object.keys` + `isKey` (`__proto__` is
  never a field) + `own()` for every lookup into `meta.clock`/`meta.counters`;
  `normalizeMeta` deep-copies a peer's meta into the trusted shape. A
  `for...in` or a bare `obj[key]` over peer-shaped data is a bug.
- **The chain is optional, the log is not.** `open({ chain: false })` leaves
  `core.chain` null: `persistLocal`/`seal` in `src/commit.js` and
  `#persistBatch` write `block: null`, `verify` is forced off, `validate()`
  throws `NO_CHAIN`. A new place that reads the chain must take null.
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
  which rewrites files in place; `persist` in `src/apply.js` and `mergeBatch`
  in `src/bootstrap.js` scrub every id of the batch whose entry is purged,
  after the batch is durable and before the relay. Never log a payload for a purged id through another path.
- **`packOps` is 17 positional slots, both halves together.** `v` (13),
  `actor` (14), `sig`, `digest` and `nonce` (15–17) were appended; a reader
  of fewer slots ignores the rest, a reader of more takes an absent slot as
  null. Append, never reorder — the
  shape is on the wire between every pair of peers (the log itself stores
  keyed `{ seq, op }` JSON; `packOps` is for `push` and `changes` only). An
  op type is one character in `TYPE_CODES`/`CODE_TYPES` (`+`/`-` are the set
  ops). Once the package is published, an older reader counts an unknown type
  as malformed and its stream stalls there — a new type, or a slot an older
  reader cannot take as null, is then a `PROTOCOL` bump (`src/protocol.js`).
- **Every write is an op, and a field is a register, a counter, a set, a list, a text OR a tree.**
  `insert`/`set` → `write`, `update`/`swap`/`record.save` → `set`, `inc` →
  `inc`, `add`/`remove` → `add`/`remove`, `splice`/`push`/`updateText` →
  `splice`, `setAt` → `assign`, `move` → `move`, `mark`/`unmark`/`unmarkById`
  → `mark`, `treeMove`/`treeRemove` → `tree`, `delete` → tombstone. Registers
  are last-writer-wins by `(ts, origin)`; counters are per-origin sums; a set
  is `meta.sets[field][elementKey][origin] = [added, removed]`, live while
  `added > removed`, read sorted by element text; a list or a text is
  `meta.seqs[field]`, a block of `src/sequence.js`; a tree is
  `meta.trees[field]`, a block of `src/tree.js` — how a block merges (Fugue,
  the run-length content, the pending ops, the movable list, the marks; the
  move log and its fold) is the header of its module, not repeated here.
  What crosses modules: a `remove` carries the tags this node observed
  (`observedTags`, built in `prepareOp` INSIDE the queue — outside it a
  concurrent apply could add between the two); `applyBase` drops a slot below
  `base` and clamps a surviving component below it, `applySeq` prunes a block
  at once (`prune`, the same on either side of a reset) and a block's `ts` is
  derived from what it holds, so a cut never bumps it — which is what makes
  meta, not only data, order-free. Mixing two kinds on one field throws
  locally (`FIELD_KIND`, `kindClash` in `src/commit.js`, before the stamp);
  from a peer the kinds' PRECEDENCE decides, on the op path (`yieldTo` in
  `src/ops.js`) as in the snapshot merge: a register, then a counter, wins
  over a set, a set over a list, a list over a text, a text over a tree —
  where the winner arrives the loser's state is dropped, where the winner is
  held the loser's op is `OP_REFUSED`. The rule reads kinds alone, never
  stamps, which is what makes it commute; do not add a path that decides a
  clash another way. The wire: `splice` is code `/` with `{ cut, at |
  run/from, content }` (`content` naming the kind even when empty), `assign`
  `=` `{ elem, value }`, `move` `^` `{ elem, cut, at, value }`, `mark` `*`
  `{ start, end, key, value, many? } | { off }`, `tree` `~` `{ node, parent,
  fi }`. An index, a sibling or a range is resolved in `prepareOp` INSIDE the
  queue (`resolveSplice`/`resolveMove`/`resolveMark`/`resolveTree` in
  `src/commit.js`: `OUT_OF_RANGE`, `CYCLE`, `NOT_FOUND`; `resolveTree` folds
  the tree ONCE and hands back `null` for a move to where the node is, and
  `commitLocal` returns before `applyOp` on it). `sync.pendingMax`
  (`PENDING_MAX`), `MAX_RUN` (`src/rle.js`), `MAX_FIELD`, `MAX_FI` and
  `MAX_DEPTH` bound what a peer can make a node hold or read, on the op path
  and in `normalizeMeta` alike — a snapshot buys nothing an op could not. The
  fuzz in `tests/suites/sync-engine.js` compares the blocks and the move logs
  across nodes, not only what they read as. `compact(id)` (`src/versions.js`)
  = `applyPatches(id, diffViews(null, {}, reading, kinds))`: a reset plus one
  op per field, one move per node — convergent through the reset rule.
- **A payload the engine does not admit is never silent.** `applyOp` reports
  `reason: 'malformed'` in `rejected` (`malformed()` in `src/ops.js`): on the
  local path `refuse()` in `src/commit.js` throws a `TypeError` — the
  arguments were checked, so this is a bug — and from a peer it is
  `OP_REFUSED{reason:'malformed'}`, counted in `syncom.ops.rejected`, the op
  still logged and relayed as a no-op (a dirk, never a gap). A `bound`
  refusal carries `detail` (`pending`/`run`/`field`), `count` and `max`.
- **A sequence block is never mutated in place; its index is cached by
  identity.** Every change goes through `cloneSeq`, so a changed block is a
  new object, and `seqIndexOf(entry, field)` in `src/ops.js` keeps
  `buildIndex`'s result on the entry (`entry.seqIndex[field] = { seq, base,
  index }`, carried by `cloneEntry` and into `EntryStore`'s cache, never into
  the file) while `meta.seqs[field]` is the SAME object under the same base.
  Read a sequence field through `seqIndexOf`, never through a bare
  `buildIndex` on a path that runs per op; a keystroke carries the held index
  over (`extendIndex`, on the `extended` hint `applySplice` returns — its
  conditions are at its definition) and `render` keeps the reading on the
  index, so never mutate an index or the array `render` hands back.
  `parsedRun` memoizes a run tuple's parse by the tuple's identity (an
  unchanged run shares its tuple between blocks; a tuple under another key is
  parsed again). `latestClock(meta, true)` is the trusted path for an entry
  this node holds — a peer's raw meta takes the untrusted one, which
  normalizes first.
- **Ops from one origin apply in seq order; seqs run per origin AND scope**
  (`origin@scope` vector keys), and ops born from a snapshot (`merge`,
  `advance`) run in their own `origin@~` stream. `applyRemote` skips
  duplicates and gaps; resume from the last event id fills the gaps.
- **Log first, then data.** `OpLog.append` resolves before the record file is
  written and before the op is announced; a reopen replays the unsealed tail.
  A node's own seq must never repeat — it is recovered from the log's vector.
  The storage opens its log with `sealApplied: true` and every write path
  calls `log.applied(from, to)` after `EntryStore.write`/`#persistBatch`; a roll then
  seals nothing from the oldest batch not yet applied onwards. A new path
  that appends must mark what it applied, or the tail grows forever. Under
  `open({ defer })` a local write stops at the append: `persistLocal` hands
  the entry to `Storage#deferWrite` — `EntryStore.hold` (cache, catalog,
  held), a slot per record with its positions, one timer — and
  `#flushDeferred` lands every slot through `#land` (one block, the files)
  and marks the positions applied; `tag()` and `close()` flush first, and
  `#land` on any other path (a peer's page, a replay) settles a slot of a
  record it wrote, so an older deferred entry is never laid over a newer
  file. Never write a record file from a deferred slot outside `#land`.
  `droppedTs` is the newest stamp among what `#compact` dropped or an open
  could not read (an unreadable segment, an index without the field and a
  floor above 1, no index and a floor above 1 — all `latestTs`): a reader of
  the past is exact only from a reset stamped above it. `pin(keep)` holds
  segments for such a reader and adds up; `retain` is one slot and the
  SyncManager's. The
  append is the commit point: a chain block or record file that fails after
  it is never thrown through — `core.persist` (`Storage#land`) and
  `persistLocal` hold the entries in memory (`EntryStore.hold`, never
  evicted), leave the batch unapplied for the next open to replay, and
  report `UNPERSISTED`. A node that dials keeps its own ops past retention
  until every enabled registered node in their scope holds them
  (`OpLog.retain(keep)`, `node.acked` — the own keys of a peer's vector,
  replaced at hello, raised by push answers); a host behind what the log
  retains is `UNDELIVERABLE`, and a host ahead of the node's own stream at
  hello is `REWOUND` (adopt the host's own keys, then bootstrap from it).
- **A failed page is a break in the stream.** `#receive` runs pages one after
  another per peer (`peer.inbound`), numbered by `peer.feed`; a rejection goes
  to `#pageFailed`, which closes the feed (pages of the old feed are dropped),
  reports `PAGE_FAILED` with the saved cursor, and resubscribes from it —
  `STUCK` after `MAX_PAGE_RETRIES`. Never move `node.cursor` past a page that
  did not land, and never catch inside `#receive` to "keep going".
- **A hosted feed's cursor moves to a real entry, never to `lastEventId`.**
  `changes` in `src/hosting.js` reads through `OpLog.read`, whose `last` is
  the seq of the last entry examined (in scope or not); when a wake brings
  nothing for the peer, the cursor moves there without a page. `lastEventId`
  is `next - 1` and runs ahead of the entries while an append is in flight —
  a feed that jumped there lost the batch in flight (it was tried).
- **Data crosses the boundary as JSON copies.** `src/commit.js` copies
  `payload.data` and `src/bootstrap.js` a record's `data`/`meta` (`asJson`)
  before anything keeps a reference; `#read` and `Cursor.fetch()` hand out
  copies. `getCachedData()` and `snapshot()` are the
  raw objects on purpose. Do not return `entry.data` from a public method.
- **Stamps come from `#clock.now()` after the clock has observed everything
  the node holds for the record.** `prepareOp` in `src/commit.js` does that
  (`latestClock` over the entry's meta), `mergeOne` in `src/bootstrap.js`
  does it over the entry's meta AND the joined meta, and `Storage.#open`
  seeds the clock from `log.latestTs`; `src/apply.js` observes every peer op.
  A stamp taken any other way can sort below state the node already has, and
  `applyOp` then drops the write silently (`changed` false, `COMMIT` returns
  null). There are exactly three write paths — `src/commit.js` (a local op,
  through `[COMMIT]`), `src/apply.js` (a peer's page, through `applyRemote`),
  `src/bootstrap.js` (a snapshot page, through `mergeSnapshot`) — all inside
  `#run`, all over the `core` Storage lends them (`#lend`), all ending in
  `#persistBatch` or `EntryStore.write`. Do not add a fourth, and do not
  reach the storage's state from a path module except through `core`.
- **Reconnect/backoff/resume belong to the link.** `SyncManager` re-runs only
  `hello` + `push` on `reconnect`; a refused restored subscription (428 "say
  hello first" — wrpc gives a reconnect a NEW server-side client) triggers a
  fresh handshake, at most `MAX_REHELLOS` in a row. Do not add a reconnect
  loop or a timer to syncom: a failed push marks the peer `behind` and
  `#recover` pushes from the vector at the next sign of life on the link (a
  page in `#receive`, an op in `#fanOut`) or on `sync()`, backed off by a
  timestamp. Every push goes through `#serializePush` — never call
  `#sendPages` from a new place.
- **Async asymmetry is real.** `calculateHash`, `encrypt`, `decrypt`, `sign`
  and `verify` are synchronous in `src/crypto.js` and promise-returning in
  `src/crypto.browser.js`. Shared code must `await` them; `browser.d.ts`
  exists to declare that difference. Do not "fix" it by making the Node half
  async. The one async function of the Node half is `verifyAsync` — the
  engine's verify, `crypto.verify` with a callback, on libuv's thread pool —
  and it is not on the package root: both barrels leave it out by name, and
  `src/signing.js` is its only caller. In the browser it is `verify` itself.
  The barrels spell every export out — a required module spread whole, the
  rest by name, never a spread of a local — because that is the shape Node's
  cjs-module-lexer reads for an ESM importer (`tests/package/esm.test.js`).
- **Signed ops: the id is the key, the signature is the header plus a salted
  digest.** `nodeId` = the Ed25519 public key (`isKeyId`: 43 base64url chars,
  canonical last char — a non-canonical one is the same key under another
  id); `keys/sign-*.pem` next to the RSA pair, `node.json` names the id
  (a UUID there is rekeyed once with `identity.rekeyed`; another key id is
  `IDENTITY_MISMATCH`, never silent). `src/signing.js` signs
  `[1, origin, seq, ts, type, id, scope, from, v, actor, digest]` with
  `digest = sha256(nonce + canonical(payload))` — three sign sites, `core.sign`
  in `persistLocal` (after `validateLocal` rewrote `op.data`), `mergeBatch`
  (after the seq is assigned) and `adopt`, all before the append. A peer's
  page is verified in `verifyPage` (src/apply.js) BEFORE the sequential
  `admit`, sixty-four at a time through `verifyAsync` (the thread pool in
  Node.js — a synchronous verify there would hold a page to one check at a
  time); it never throws (a throw there would be `PAGE_FAILED`, a
  stream-stopper). `OpLog.scrub` deletes the nonce with
  the payload and keeps `sig`+`digest`, so a scrubbed op's header verifies.
  A refused op is a gap, like a malformed one. `'verify'` is the default
  because ~70 call sites inject unsigned hand-made ops; `'require'` is the
  only mode that resists stripping — say so wherever signatures are
  documented. Never put the key or a signature into a metric label.
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
- **A version is a fold of the retained log, exact only from a reset above
  `droppedTs`.** The model is the header of `src/history.js`; the glue is
  `src/versions.js` (`past`/`applied`/`present`), outside the queue:
  `log.entriesOf(id)` filtered by `appliedHere` (skipped out, held in once
  the node runs the version), folded with `applyOp`. With `droppedTs > 0` the
  fold of everything retained must `deepEqual` the present (`present`) — the
  counter straddle `repair()` also has — or it is `HISTORY_GONE compacted` /
  `exact: false`; a stamp below a retained `merge` is `reason: 'merge'`, a
  cut before a purge `'scrubbed'`. Never answer a version from the record
  file or the catalog, and never fold from an entry below the exact start.
- **A tag is copy-on-write at the EntryStore seam.** The layout, the read
  walk, the untag move-down and the lazy read of an older tag are the header
  of `src/tags.js`. What crosses modules: record files are copied by
  `EntryStore.#changing` (`before(id, file)`) ahead of
  `write`/`writeSealed`/`remove`, into the NEWEST tag only, once per record,
  only for a record the tag's catalog holds live — so the newest tag is read
  at open and after every drop, an older one at its first use, and the sync
  readers `hasAt`/`rowAt`/`catalogOf` come after `ensure(name)` (a Cursor at
  a tag awaits its source's `ready`). `tag()` flushes deferred files first and
  refuses (`UNPERSISTED`) while a record is held — its file is behind the
  cache and a copy from memory would carry no block to verify; a record held
  since the tag reads as its file, still the tag's state. An unreadable
  `tags.json` never fails `open()` (`tags.corrupt.json`, `stats().tags`,
  `take()` refuses `CORRUPT`, the copies wait under `tags/.pending/data/` for
  the next good open); never rebuild `tags.json` from the disk — fsi lists
  files, not directories. Every purge path goes through `core.scrub` (log +
  tags) — never `core.log.scrub` alone. The error field is `tag`, never
  `name` (it would overwrite `Error.name`). A view at a tag (`at(name)`,
  `src/versions.js`) reads through `sourceAt`, a `storage[SOURCE]`-shaped seam
  over the tag's catalog (`searches` false, `subscribe` throws), and pages
  through `snapshotPage` with a core of the tag's catalog, entries and
  position — the same `pageOf`, never a second page writer.
- **A patch is in the write API's terms, and the only way back is new ops.**
  The vocabulary and the per-kind diff are the header of `src/patch.js`;
  `realize(patch)` maps to `[type, payload]` for `commit()`. `applyPatches`
  (`src/versions.js`) rehearses, then runs them in ONE `#run` turn;
  `restore(id, at)` = `applyPatches(diff(id, undefined, at))` — never rewrite
  the log or the file. A `remove` patch with `removals` goes out as given
  (`prepareOp` takes `payload.removals` over `observedTags`), one with `own:
  true` keeps this node's tags alone (`ownTags`): an undo revokes this node's
  adds and leaves a peer's. The `commit` event (`announce` in src/commit.js)
  is LOCAL ops only, built only when `listenerCount('commit') > 0`, with
  `before`/`after` as copies and the kinds of both sides; a peer's op raises
  `change`, never `commit`.
- **Undo is a subpath over `commit`, never inside the engine.** The model —
  steps of inverse patches, refuse-to-overwrite, the exact and the loose
  inversion — is the header of `src/undo.js`. What crosses modules: the
  manager applies through `storage.applyPatches(id, kept, { source: token })`
  and tells its own commits by the token; every `remove` it makes is `own:
  true`; conflicts are read from `log.entriesOf(id)` after the step's
  `lastSeq` (an `inc` or an `add`/`remove` by others commutes with the
  inverse, `conflicting`), so it `log.pin`s from its oldest step. `kindsOf`
  lives in ops.js (it needs the predicates) and `deepEqual` in shape.js, so
  patch.js and the subpath ship without the op model — keep it that way. The
  stack is memory only; a `purge` forgets the record on every step.
- **A branch is a storage; a merge is a push.** `src/branch.js` opens the
  fork through `parent.constructor` (the subpath bundles no engine), never
  copies the directory (a copied identity is `SELF`/`REWOUND`), gives it
  `retention: { ops: 0 }` + `autoStart: false`, joins the parent's (or the
  tag's) snapshot pages and adopts the vector. `merge` = `outbound(source.log,
  { exclude: into.nodeId, vector: into.vector, own: source.nodeId,
  allStreams: true })` → `into.applyRemote(page, { via: { url: null, node },
  adoptFrom: source })` — the one selection `#pushFromLog` uses too
  (`src/outbound.js`; change one, change both: a push asks `first` of the
  sender's own streams, a merge of EVERY stream, and joins as state when one
  is out of reach). No-echo is `exclude` on `origin`/`from` plus `vectorHas`;
  never add a third filter. `drop()` refuses a storage without `branch.json`
  (`sweep` is the shared remover, used by a failed `branch()` too), and
  `branch()` refuses a path that holds files: another storage is never taken
  over.
- **Arguments are checked once, in `src/args.js`.** `spliceArgs`, `treeArgs`,
  `markArgs`, `setElements`, `jsonValue` and `isNodeId` serve the public
  methods of `Storage` AND `realize()` in `src/patch.js` (no requires — the
  undo subpath ships with it; `tree.js` takes `isNodeId` from it), so a patch
  never reaches the engine with a shape a call could not have. `prepareOp`
  refuses a sequence or tree op on a field of another kind (`kindClash`)
  before a stamp is minted or an index read — no placeholder payloads for
  `applyOp` to refuse later — and `applyPatches` rehearses every op over a
  scratch record (`rehearse` in `src/commit.js`) before the first append: a
  restore lands whole or not at all. `copyPayload` copies `data`, `value`,
  `content` AND `removals` — nothing of a caller's is kept by reference.
- **`repair(id)` replays the log, it does not guess.** `Storage.#repair`
  starts at the first whole-record op the log retains for the id (`WHOLE`:
  `write`/`merge`/`delete`, or a `purge` even scrubbed), folds the rest with
  `applyOp`, and writes through `#persistBatch` like a replay — one chain
  block, the catalog put by `EntryStore.write`. No such op is
  `UNRECOVERABLE`; an integrity failure is never repaired implicitly on
  read — it is evidence first.
- **Encrypted records are local.** `{ encrypted: true }` seals a record for
  this node's key; it produces no op and is excluded from snapshots. Do not
  route an encrypted entry through `applyOp`.
- **A cursor reads through `storage[SOURCE]`, not through `get()`.** The
  seam hands it the catalog and a lensed, hook-free `load(id)` — like
  `snapshot()` and `swap()`. `Cursor#matching` is the one place that reads
  records for a query: sixteen at a time, in candidate order, into a `TopK`
  when the cursor is ordered and limited (the rows come back sorted, `fetch`
  must not sort again) or an `Every` otherwise; `Catalog.candidates` narrows
  through `$and`/`$or`, and `ids()`/`indexed()` hand out cached, shared
  arrays and sets — never edit what they return. Indexed and unique values are
  keyed canonically (`keyOf`: object keys sorted at every depth), as the
  predicate compares them. Unique keys are checked after validation and
  the fold, before `#log.append` (local: throw) and after `applyOp` on the
  apply path (remote: `conflict` event, never a skip — both records stay).
- **`$text` is the catalog's.** An entity's `search` fields are joined into
  its catalog row as `row.text` (format 3, a seventh cell) and handed to the
  injected `TextIndex` (`open({ search })`, built per entity in
  `#defineSchema`) inside `#insert`/`#remove` — never in `put`, so postings
  and text never disagree under a watcher — under a try/catch that logs
  `catalog.search`: derived state never fails a write. `compileQuery` takes
  `$text` at the top level only and makes no test of it; `fieldsOf` skips it;
  `Catalog.candidates` seeds `#narrow` with the index's ranked ids (a fresh
  Set) and every `meet` keeps the seed's order, so an unordered cursor hands
  rows out best first. Never apply a limit inside the index (the equality
  intersection comes after, and `count()` needs every match), never persist
  the index — `load()` replays the rows through `#insert` — and never let the
  core normalize text: that is `src/search.js`'s, a subpath with no requires.
- **The catalog is derived state, kept at one seam.** `EntryStore`
  (`src/entries.js`) is the only place that `catalog.put`: `write` (every
  write path goes through it), `writeSealed`, `remove` and `index`; it
  indexes the lensed view and never fails a write (a throwing lens is logged
  and the raw data indexed). `#flushCatalog` (`core.flush`) saves it OFF the
  mutation queue — `Catalog.save` takes the rows and the stamp before its
  first await, one save in flight at a time, `close()` awaits it — so a write
  never waits for the catalog file. Do not `await` a save inside a write path.
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
  waits for it. Hook calls live in `src/commit.js`, `src/bootstrap.js`
  (`core.hook`), `get`, `src/apply.js`, `#connect` and `#bootstrap` only; there is deliberately no hook on the ops
  that leave for a peer (a withheld op is a gap that stops that stream —
  scopes are the per-peer filter). Only the hooks that run inside the
  mutation queue go through `#hook` (`core.hook`) and its `#inHook` guard;
  `beforeRead`/`afterRead` call `runHook` directly — a write from a read hook
  queues. Every event leaves through `notify()`:
  never `await this.emit(...)`, never emit `error` any other way (the Emitter
  throws on an unheard `error`, and that throw used to fail a push before the
  vector moved). A remote op a `beforeApply` skipped is still appended, with
  `skipped: true` on its log entry — that flag is what keeps `#replayTail`
  from applying it on reopen; do not strip it.

## Testing

`node:test` + `node:assert`. Browser halves run under Node with the OPFS mock
(`tests/utils/mock-opfs.js`) and `node:crypto`'s `webcrypto` — see
`tests/index.browser.test.js`. Cross-platform behaviour goes in `tests/suites/`
and is run against both halves (`schema`, `catalog`, `query`, `search`, `purge`,
`hooks`, `fsi`, `sync-engine`, `signatures`, `signing`, each with a `*.test.js`
and a `*.browser.test.js`
wrapper); `tests/suites/sync-engine.js` runs the
convergence properties (a partition, a seeded fuzz over `set`/`update`/`inc`/
`add`/`remove`/`delete` — a new op kind joins as a branch there — and a late
joiner) over `tests/utils/memory-link.js` (an in-process link
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

`INVARIANTS.md` names, for every guarantee (`SYNC-n`, `OPS-n`, `LIST-n`, `LOG-n`,
`VER-n`), the tests that hold it; `tests/package/invariants.test.js` fails when an id
names no test or a named title is gone. Rename a test and its row together; a new
guarantee gets an id, a test and a row. Only plain-string titles are citable. The
hazard walk in `tests/suites/sync-engine.js` (drops, duplicate pages through
`tests/utils/memory-link.js`'s `duplicate` hook, a reopen) is the one that must stay
green whatever else moves.

## Benchmarks and the comparison

- **The alternatives are not devDependencies.** They live in `bench/compare/package.json`, installed with
  `pnpm bench:compare:install` (`--ignore-workspace`, its own lockfile); CI never installs them. An adapter
  loads its library on first use (the cold start counts it) and must pass the worker's checks before
  anything is timed — a check that fails measures nothing. Use each library the way its docs show.
- **Charts and tables are generated.** `pnpm bench:report` rewrites the regions between
  `<!-- bench:<name>:start -->` / `:end -->` in README.md and docs/guide/benchmarks.md and the SVGs in
  docs/public/benchmarks/; edit `bench/results/*.json` or the model, never the regions. The docs components
  (`docs/.vitepress/theme/components/Bench*.vue`) import the same `bench/report/model.mjs`.
- **The matrix is data.** Every cell of `docs/comparison.json` keeps the `source` it was decided from (and a
  `detail` for a footnote left out of the table); `pnpm docs:comparison` renders it. A cell about another
  project is decided from its published source and official docs, not its README; the syncom column from
  this repository. Keep the prose of docs/guide/comparison.md and why.md in step with the counts.

## Documentation

Document what the code does today. When adding docs, verify each example by
running it before writing it down — several examples inherited from the legacy
repo were wrong in exactly that way. A new page needs a sidebar entry in
`docs/.vitepress/config.mts`; `docs/guide/sync.md` and `docs/guide/wrpc.md`
are the two pages that describe the protocol — keep them in step with
`src/sync.js` and `src/hosting.js`, `docs/guide/hooks.md` with the hook and
event surface of `src/commit.js`, `src/apply.js`, `src/bootstrap.js`,
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
