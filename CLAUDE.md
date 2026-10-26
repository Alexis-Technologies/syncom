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
index.js / browser.js     two-line shims over src/index.js / src/index.browser.js — the ROOT holds these two and their .d.ts, nothing else
src/<name>/<name>.js      every subpath is a folder under src/ with its entry and its .d.ts beside it; package.json#exports points there
src/all/all.js            @alexify/syncom/all — the core with every shipped plugin registered (text, tree, signing, chain, encryption): the
                          API as it was before the blocks
src/signing/signing.js    @alexify/syncom/signing — the identity plugin (nodeId = the Ed25519 key, sign/verify) over src/signing/{ed25519,
                          ed25519.browser, sign}.js; the key functions off the root
src/chain/chain.js        @alexify/syncom/chain — the chain plugin and Blockchain; SHA-256 through src/digest.js
src/encryption/encryption.js  @alexify/syncom/encryption — the sealing plugin (encrypted: true) over src/encryption/{rsa,rsa.browser}.js,
                          and atRest(fsi, …), the AES-256-GCM backend wrapper
src/text/text.js          @alexify/syncom/text — the list and text kinds as a plugin, over src/text/{sequence,rle,myers}.js
src/tree/tree.js          @alexify/syncom/tree — the tree kind as a plugin, over src/tree/moves.js and src/order/order.js
src/plugin.js             createPlugins — the registry one open() builds: kind modules (ranks, block codes, op types, apply/join/prune/render/
                          resolve/diff/realize/migrate/compact/methods) and API modules; PLUGIN_MISSING; PENDING_MAX — requires shape.js, errors.js
src/wrpc/wrpc.js          the @alexify/syncom/wrpc subpath
src/contracts/contracts.js the @alexify/syncom/contracts subpath — never back in the barrel
src/idb/idb.js            the @alexify/syncom/idb subpath — the IndexedDB backend, browser-only
src/search/search.js      the @alexify/syncom/search subpath — the trigram text index behind `$text`; the core knows only the TextIndex contract
src/order/order.js        the @alexify/syncom/order subpath — fractional indexes as strings, for ordering records
src/undo/undo.js          the @alexify/syncom/undo subpath — the undo stack over the commit event; requires patch.js, emitter.js, symbols.js, paths.js only
src/editor/editor.js      the @alexify/syncom/editor subpath — the editor-agnostic binding (shadow, one delta in
                          flight, STALE and the rebase), delta compose/transform, diffSpans/diffBlocks, spans↔blocks,
                          selections as tokens, presence cursors; requires text/myers.js and vector.js only
src/prosemirror/prosemirror.js  the @alexify/syncom/prosemirror subpath — ProseMirror (injected `{ model, state, transform, view? }`)
                          over the editor binding: the document as one text with a marker per block-level node, the replace
                          step, cursors as decorations, undo commands over /undo; requires editor/editor.js only
src/codemirror/codemirror.js  the @alexify/syncom/codemirror subpath — CodeMirror 6 (injected `{ state, view? }`) over the editor
                          binding: a ChangeSet as a delta and back, line breaks fitted, cursors as decorations, undo commands;
                          requires editor/editor.js only
src/store/store.js        the @alexify/syncom/store subpath — toStore/fromEvents: one store object for Svelte's contract and
                          React's useSyncExternalStore over a cursor, a Record, get(), a presence or an emitter — no requires
src/inspect/inspect.js    the @alexify/syncom/inspect subpath — a record's anatomy (through the [SOURCE] seam's raw `entry`) and anonymize; requires compose, shape, symbols, hash only
src/presence/presence.js  the @alexify/syncom/presence subpath — ephemeral state per node, signed through storage[SIGNER]; requires emitter, shape, symbols, errors, scope only
src/branch/branch.js      the @alexify/syncom/branch subpath — fork a storage, merge either way; never requires storage.js
index.d.ts                the Node type surface (hand-written)
browser.d.ts              re-exports index.d.ts (the files layer differs; the crypto halves' types are the subpaths' *.browser.d.ts)
THIRD_PARTY_NOTICES.md    the MIT notices of the algorithms adapted (Fugue, Yjs, list-positions…) and the files that carry them
src/backend.js            the fsi contract (isFsi/checkFsi; sync, create and append optional), withSync — no requires
src/memory/memory.js      @alexify/syncom/memory — memory(), the backend in memory (a Map; size, dump, the exclusive create, append) — no requires
src/layered/layered.js    @alexify/syncom/layered — layered([top, …, bottom], { write, fill, queue }): one fsi over several, a multi-level
                          cache; 'back' drains its queue before any lower layer is consulted; create is exclusive across layers
src/emitter.js            the Emitter both halves extend — no requires
src/logger.js             createLogger, the duck-typed logger writer — no requires
src/keys.js               loadKeyPair — the on-disk key pairs (RSA for sealing, Ed25519 for signing), generator injected by each crypto half — no requires
src/digest.js             sha256 — SHA-256 of a value's JSON through Web Crypto, async on both platforms: the chain's and the schema hash's — no requires
src/pem.js                base64/PEM helpers over btoa/atob for the browser crypto halves — no requires
src/scope.js              GLOBAL_SCOPE, inScope, opInScope — the one definition of "in scope" — no requires
src/blame.js              lastEditorOf, editorsOf — who wrote what, from a record's meta (registers' clocks, counters' sums, sets' slots, the plugins' `editors` hook); never the log
src/hash.js               xxHash32 in pure JS — the checksum every log file carries (`{ entries, hash }`); a checksum, never a signature — no requires
src/signing/sign.js       canonical form, signOp, verifyOp — what a signature covers (the header + a salted payload digest) and the verdict on a peer's op
src/shape.js              isPlainObject, asJson, isRecordId, isStreamName, wellFormed — what enters is checked here
src/paths.js              field paths: isPath, ancestorsOf, under, valueAt, MAX_PATHS — no requires
src/compose.js            compose (the paths nested for a reader), decompose (a reading back to the fields) — requires paths.js
src/args.js               spliceArgs, treeArgs, markArgs, setElements, jsonValue, isNodeId — the write API’s argument
                          checks, shared by Storage and realize() in patch.js — no requires
src/text/rle.js           run-length content: a run's pieces and gaps, cut, append, merge, the canonical form under MAX_RUN —
                          no requires; sequence.js is the caller and re-exports what the tests read
src/text/btree.js         the rope: a persistent B+-tree over a block's segments and fences with two measures (slots, visible),
                          path copying, hints tagged by lineage, a text cache per node — no requires
src/text/pmap.js          a persistent hash map (HAMT): the run records of a block, one changed per keystroke — no requires
src/text/plist.js         a persistent sorted list in chunks: a placed run's segments, the children at its offsets — no requires
src/text/sequence.js      the sequence engine behind the list and text kinds (indexOf: the block hydrated once onto entry.cache):
                          run records, the walk that places a subtree, local placement, pending ops, pos/vals/marks registers,
                          cursors, prune and join — requires vector.js, plugin.js, rle.js, btree.js, pmap.js, plist.js
src/tree/moves.js         the tree engine: per node its stamped moves, the fold in stamp order with the cycle check (Kleppmann
                          2021, Loro) walking MAX_WALK ancestors at most, MAX_DEPTH levels read, MAX_MOVES a field, prune and
                          join — requires vector.js and order.js (a place is a fractional index or the move is malformed)
src/order/order.js        fractional indexes over a 62-letter alphabet (Loro's rule, MIT) — no requires; the tree plugin uses it for a node's place
src/versions/history.js  the past out of the log: a version (event id / stamp / vector) as a cut, the exact start above droppedTs, the fold
src/versions/tags.js     Tags — named versions kept locally: tags.json, a catalog per tag, copy-on-write record files in the newest tag
src/patch.js              patches — the one vocabulary of diff()/applyPatches()/restore(): diffViews by kind, realize() to an op — requires shape.js, myers.js only
src/undo.js               UndoManager — steps of inverse patches from `commit` events, refuse-to-overwrite, pins the log; the core does not use it
                          (requires patch.js, emitter.js, symbols.js, paths.js)
src/outbound.js           outbound(log, { exclude, vector, scopes, own }) — the ops a receiver lacks, the first retained seq per own stream; a push and a merge both pick with it
src/branch.js             branch/merge/branchInfo/drop — a fork opened through parent.constructor, merged as ops through applyRemote
src/symbols.js            COMMIT / REFRESH / SOURCE — the module-private seams between Storage and what it hands out — no requires
src/options.js            normalizeStorageOptions — open()'s plain options checked and defaulted (lock, cache, chain, skew…)
src/protocol.js           PROTOCOL, DEFAULT_PAGE_SIZE, schemaOf — what both halves of the sync protocol agree on — no requires
src/lock.js               exclusive open: Web Locks or lock.json, stale by pid or age — no requires
src/catalog.js            the record catalog: live ids, collections, indexed values; index/catalog.json — no requires
src/query/query.js        @alexify/syncom/query — the query plugin: setup hands the core a cursor factory (`query` hook); select()/count()
                          on a Collection go through storage[CURSOR], PLUGIN_MISSING without it
src/query/cursor.js       compileQuery (Mango predicate), compareRows, Cursor — reads through storage[SOURCE]
src/shared-log.js         isSharedLog — the reserved broker-log contract (wrpc BrokerLog shape), no consumer yet
src/storage.js            Storage — the facade: open sequence, the mutation queue, the public API, the `core` it lends
src/fields.js             the API of the core's kinds beyond registers — inc/add/remove — over the lent core; a plugin's methods come with it —
                          over the lent core; Storage keeps a delegate per method
src/versions/versions.js @alexify/syncom/versions — the versions plugin: setup hands the core its Tags (`versions` hook), `methods`
                          are the facade's stubs (getAt, diff, restore, tag, untag, tags, at, history)
src/versions/api.js      the versions API — get(id, { at }), history, diff/restore, tag/untag/at — over the lent core
src/patches.js           reading, applyPatches, compact — the present and its patches, the core's (the undo subpath stands on
                          applyPatches); appliedHere lives in log.js
                          lent core; Storage keeps a delegate per method
src/entries.js            EntryStore — record files under data/, the bounded cache, the catalog row each change leaves
src/record.js             Reference, Record, Collection — what the application holds; public API + the symbols only
src/commit.js             the one local write path: prepare → validate → issue (in the queue) → land → announce (outside it, in log order) (`storage[COMMIT]`)
src/apply.js              a peer's batch: admit → apply one by one → persist → announce (`storage.applyRemote`)
src/bootstrap.js          snapshot pages out, merge pages in, adoptVector — the bootstrap write path
src/schema/schema.js      @alexify/syncom/schema — the schema plugin: setup(ctx) hands the core the definitions and the lens (`schema` hook)
src/schema/define.js      entity definitions, the injected validator (Standard Schema / ajv / compile) — normalizeSchema; requires errors.js only
src/schema/lens.js        createLens — how an older record reads under this version (migrations, then the validator)
src/entity.js             project / unproject / foldSet — the record as its validator sees it, the validated value as the op carries it;
                          the core's, shared by commit.js and the lens; requires shape.js only
src/errors.js             SyncomError, ValidationError, typed() — no requires
src/ops.js                the record-level model: applyOp / mergeEntry / isAlive, packOps
src/vector.js             clocks, version vectors, event ids
src/log.js                OpLog — the persisted operation log over fsi: seqs reserved at append, groups written one file each
src/sync/sync.js          @alexify/syncom/sync — the sync plugin: `open(ctx)` after the replay hands the core its SyncManager
src/sync/manager.js       SyncManager — the dialing side; `unit()` delegates to hosting.js
src/sync/hosting.js       createUnit — the hosting side: hello/push/snapshot/changes, limits, grant()
src/link.js               isSyncLink — the link contract check
src/wrpc.js               createWrpcLink — a WrpcClient as a SyncLink (no wrpc import)
src/telemetry.js          the telemetry writer contract: DISABLED, writerOf, traced — what every write path records through; no requires
src/telemetry/telemetry.js  @alexify/syncom/telemetry — the OpenTelemetry adapter (createTelemetry: { api } | { tracer, meter } → writer,
                          duck-typed; @opentelemetry/* only devDeps) and the plugin whose setup hands the core the writer
src/                      ships as-is — no build step, CommonJS, 'use strict'
tests/                    *.test.js are tests; anything else is a helper
bench/                    one file per subject + support/harness.js; run-all.js skips compare.js and report.js
bench/compare/            the cross-library comparison: its OWN package.json (the alternatives, never syncom's
                          devDependencies), adapters/ (one per library), worker.js, size.js
bench/report/             model.mjs (what every chart shows) + svg.mjs (README images); bench/report.js writes both
bench/results/            compare.json, size.json, engine.json — the inputs of the charts, committed
docs/comparison*.json     the feature matrices; scripts/comparison.js renders comparison.json into docs/guide/comparison.md,
                          comparison-rxdb.json into vs-rxdb.md, comparison-crdt.json into vs-crdt.md
scripts/size.js           bundle-size report with browser budgets
docs/                     VitePress site
```

## Rules that bite

- **A kind is a plugin, registered per storage.** `open({ plugins })` builds one registry
  (`src/plugin.js`) — nothing is global to the process. The core keeps registers, counters and sets
  and one slot `meta.blocks[field] = { k, ts, … }` for every other kind; `k` names the plugin's block
  code, `ts` the newest stamp it holds, and a block is never mutated in place. The op types and their
  codes stay the protocol's (`OP_TYPES`, `TYPE_CODES`): a node without the plugin admits, logs and
  relays the op and refuses it as `reason: 'kind'` (`OP_REFUSED`, a dirk, never a gap), drops a
  snapshot block of that kind with `sync.record.kind`, refuses a local call or patch with
  `PLUGIN_MISSING` (typed, like `NO_CHAIN`) naming the subpath, refuses a reopen of a directory that
  ran with a kind it lacks, and never bootstraps from a host whose `hello.kinds` lack one of its own
  (`KINDS_MISMATCH`). Precedence is the registry's ranks (register 0, counter 1, set 2, a plugin's ≥ 3,
  unique), read alone. A plugin's methods are stubs on the facade (`Storage#api`); `applyOp`,
  `mergeEntry`, `normalizeMeta`, `latestClock(meta, false, limits)`, `diffViews` and `realize` take
  the registry through `limits.plugins` / `plugins`, and `/all` pre-binds them. Tests that need the
  kinds open through `src/all/all.js` (`tests/sync.engine.lean.test.js` proves the explicit route).
  The other blocks are api plugins over the seam of the next rule: `signing`, `chain`, `encryption`,
  `schema`, `telemetry`, `query`, `versions` (`setup(ctx)`, before the log), `sync` (`open(ctx)`,
  after the replay); `memory` and `layered` are backends, not plugins. Every suite of a block runs
  twice — over `/all` and over the lean core with the plugins given by hand
  (`tests/*.lean.test.js`) — and `scripts/size.js` checks that the core and every block bundled
  together weigh what `/all` weighs (nothing bundled twice).
- **An adapted algorithm brings its notice.** Code or a rule taken from an MIT project is named in
  `THIRD_PARTY_NOTICES.md` (project, commit, the syncom files that carry it) with the upstream notice.
  Nothing is copied from json-joy (AGPL-3.0), Collabs or `fugue/fugue` (Apache-2.0) — those are read
  as specifications only; the clones live in `../../open-source/local-first-alternatives/`.
- **CommonJS everywhere in `src/`.** No `import`, no `type: module`, no build.
- **No runtime dependencies.** Helpers go in `src/utils.js`. `scripts/size.js`
  fails at resolve time on any bare import reaching a browser bundle, so a
  stray `require('some-pkg')` in shared code breaks `pnpm size`, not just the
  dependency count.
- **The security blocks are api plugins over one seam.** A plugin that is not a kind has
  `setup(ctx)` — `{ fsi, path, logger, options, settings, storage }`, run in `#open` before the
  log opens, in registration order — and hands back hooks the core takes: `identity` (`{ id,
  sign, verify, signMessage }`, the signing plugin), `seal` (`{ encrypt, decrypt }`, the
  encryption plugin), `chain` (a Blockchain, the chain plugin) — and `open(ctx)` — `{ storage,
  options, settings, logger }`, run after the replay — hands back `sync` (the SyncManager, the
  sync plugin: `storage.sync` is PLUGIN_MISSING without it). The core reads them as
  `core.identity`/`core.sign`/`core.verify`, `core.seal`, `core.chain`, and `core.hash` is
  `sha256` from `src/digest.js` (Web Crypto, async on both platforms — the core has no crypto
  half). Without a hook: the node id is what `getId` mints (checked by `isStreamName`), ops are
  neither signed nor verified (`verifyPage` answers OK for every op), `block: null`, and an
  encrypted write is `PLUGIN_MISSING`. What the options ask for and no plugin provides is
  refused in `#open` with `missing()` — `signatures: 'require'`, `chain: true`, `encrypted` —
  never silently downgraded. A new api plugin adds a hook name here and a line in
  `docs/reference/api.md` Plugins; it never reaches the storage's state except through `ctx`
  and the hooks.
- **Browser halves are `*.browser.js`** (dot, not dash): `fsi` and `utils` in the core,
  `signing/ed25519` and `encryption/rsa` in their subpaths. Everything else (storage, log, ops,
  sync, chain, wrpc adapter, and the require-free `emitter`, `logger`, `keys`, `scope`,
  `digest`, `pem`) is shared; the two `utils` halves only re-export `Emitter`/`createLogger`
  and add the platform's own bits. Adding a split means three edits: the file, `package.json#browser`,
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
  `unit()` (`src/sync/hosting.js`) builds plain `{ access, handler }` objects that
  `defineRouter` accepts without wrpc's `procedure()`. The `tracked` shape it emits is
  `Symbol.for('wrpc.tracked')` — part of wrpc's frozen wire protocol.
- **Every operational error is a `SyncomError` with a `code`.** `src/errors.js`:
  a failure that can happen to correct calling code — given the data, the
  files or the peers — is `new SyncomError(code, message, { cause, ...fields })`,
  and its code is in the `SyncomErrorCode` union of `index.d.ts` and the table
  in `docs/reference/api.md` (one row per code: who raises it, which fields
  ride on it). A wrong argument, option or hook result is a `TypeError`
  without a code, except `typed(code, message)` for a value that is data
  (`INVALID_ID`, `TYPE_IMMUTABLE`, `INVALID_VERSION`, `PRESENCE_SIZE`) or
  configuration (`NO_CHAIN`, `PLUGIN_MISSING`) — the `TypedErrorCode` union,
  never in `SyncomErrorCode`; `tests/package/consistency.test.js` reads every
  code off `src/` and checks both unions and the `api.md` table. A host's
  wire refusal (`coded` in `src/sync/hosting.js`) keeps the numeric code wrpc
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
  and `from` are claims, carried as they are), and how deep every field
  nests (`MAX_WIRE_DEPTH`, `nestsWithin` — iterative: the readers after it
  recurse; `verifyPage` runs after `wellFormed` and never throws, a throwing
  check is that op's FORGED); a stamp beyond `sync.maxSkew` ahead of
  `Date.now()` — the op's `ts` or any stamp a `merge`'s meta holds
  (`latestClock`) — is refused the same way (`SKEW`), never observed into
  the clock, and a stamp a record already holds past it is not observed by a
  write either (`core.observe`, `clock.skew.ignored`). `malformed` ops are
  counted, not logged, not relayed. A local write deeper than
  `MAX_JSON_DEPTH` is a TypeError (`copyPayload` in src/commit.js); the 16
  levels between the bounds are what an op and a meta wrap around a value —
  keep them apart. Payload shape is `applyOp`'s business.
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
  `normalizeMeta` deep-copies a peer's meta into the trusted shape (under the
  node's `pendingMax`), and `mergeEntry` joins a side alone with an empty
  entry rather than copy it, so data its meta does not back never comes
  along. A `for...in` or a bare `obj[key]` over peer-shaped data is a bug.
- **The chain is optional, the log is not.** Without the `chain` plugin, or under
  `open({ chain: false })` with it, `core.chain` is null: `persistLocal`/`seal` in
  `src/commit.js` and `#persistBatch` write `block: null`, `verify` is forced off,
  `validate()` throws `NO_CHAIN` (the message says which of the two). A new place that reads
  the chain must take null.
- **`via` is a descriptor, never the link.** `peer.ref` (`{ url, node }`,
  `node` filled by hello) is what `change`, `apply` and the apply hooks get
  on the dialing side; the host's is `state.ref` (`url` null). `#fanOut`
  compares `peer.ref === via`. Never hand the peer object, the link or the
  wrpc client out of `SyncManager`: they carry the token and the socket.
- **Live Records are weak.** `#records` holds `WeakRef`s (a
  `FinalizationRegistry` clears the slot); go through `#live(id)`, never
  `#records.get`. A Record the application still holds pins its cache entry;
  one it dropped is collected with its pin. A write path hands `core.refresh`
  the entry: with a lens or a read hook in play the Record is refreshed as
  `get()` reads, after the write and outside the queue (`#emitUpdate`, in
  order) — never await a read hook inside the queue.
- **A purge is a scrub, not a delete.** `purge` wins at any stamp and a
  purged entry takes nothing but another purge or a merge (`applyOp`
  returns early). The payload leaves the log through `OpLog.scrub(id)`,
  which rewrites files in place; `persist` in `src/apply.js` and `mergeBatch`
  in `src/bootstrap.js` scrub every id of the batch whose entry is purged,
  after the batch is durable and before the relay. Never log a payload for a purged id through another path.
- **`packOps` is 18 positional slots, both halves together.** `v` (13),
  `actor` (14), `sig`, `digest` and `nonce` (15–17), `msg` (18, a
  transaction's message, ≤ `MAX_MESSAGE` in `src/shape.js`, in the signed
  header) were appended; a reader
  of fewer slots ignores the rest, a reader of more takes an absent slot as
  null. Append, never reorder — the
  shape is on the wire between every pair of peers (the log itself stores
  keyed `{ seq, op }` JSON; `packOps` is for `push` and `changes` only). An
  op type is one character in `TYPE_CODES`/`CODE_TYPES` (`+`/`-` are the set
  ops). Once the package is published, an older reader counts an unknown type
  as malformed and its stream stalls there — a new type, or a slot an older
  reader cannot take as null, is then a `PROTOCOL` bump (`src/protocol.js`).
- **A field may be a path; the op model keeps every path apart.** `profile/city`
  is a field of its own in every map of the meta (src/paths.js `isPath`:
  segments by `/`, at most MAX_PATH_DEPTH 16 and MAX_PATH 512, never
  `__proto__`; a record holds MAX_PATHS 4096 of them — `pathsFull` refuses a
  new one as `bound`/`paths`, `normalizeMeta` keeps the first in sorted
  order). `floorOf(meta, field)` reaches up the path: a register's clock or
  an unset at a prefix is the floor of everything under it (`pruneUnder` on
  a register write and on an unset of the prefix). A counter, a set or a
  block holds its prefix alone: `roomFor` (`holderAbove`) refuses an op
  under it with `rejected.prefix` — locally `kindClash` does, before the
  stamp, as `FIELD_KIND { prefix }` — and `dropUnder` takes the subtree
  where one lands (the mergeEntry tail does the same) — unless the kind
  NESTS (`mod.nests[kind]`: a list's elements, a tree's nodes carry fields;
  `members`/`holds`/`pick`/`nest` are the plugin's seam for src/compose.js;
  a text does not): under it the next segment is a member, no field, and
  `kindClash` refuses a member that is not there as `NOT_FOUND { field,
  elem }` while a peer's lands unreachable — not composed, not in a diff
  (`readAt`), dropped by `compact`). The reader's view
  is `compose(entry, plugins)` (`Storage#view`, cached as `entry.composed`; the lens
  runs over it; `#scope`, a hook's `current` and the commit event's
  read it; `foldSet` folds a validator's output back by path; a diff, a
  compaction and an undo take a reading back to the fields (`decompose`;
  the `commit` event's `before`/`after` are flat already); `snapshot()`,
  `getCachedData()`, the ops and the log keep the paths apart.
- **Every write is an op, and a field is a register, a counter, a set, a list, a text OR a tree.**
  `insert`/`set` → `write`, `update`/`swap`/`record.save` → `set`, `unset` →
  `unset` (code `u`, `value` the field names: each field's own reset
  watermark `meta.gone[field]` — what the field held below it is pruned
  like under `base`, `pruneField`; an op on the field stamped below it is
  moot, one above it makes the field again as whatever kind it is;
  `floorOf(meta, field)` in src/vector.js is the floor every op path and
  every plugin reads, never `meta.base` alone), `inc` →
  `inc`, `add`/`remove` → `add`/`remove`, `splice`/`push`/`updateText` →
  `splice`, `setAt` → `assign`, `move` → `move`, `mark`/`unmark`/`unmarkById`
  → `mark`, `treeMove`/`treeRemove` → `tree`, `delete` → tombstone. Registers
  are last-writer-wins by `(ts, origin)`; counters are per-stream sums — a
  slot per vector key, `origin` or `origin@scope` (`opKey`: seqs run per
  stream, so a seq is only ever compared within its stream; a bare-origin
  slot is the global stream's) — each within ±`MAX_COUNT` and added up in
  slot-key order; a set
  is `meta.sets[field][elementKey][origin] = [added, removed]`, live while
  `added > removed`, read sorted by element text; a list or a text is
  `meta.blocks[field]` with `k: 'l'`/`'t'`, a block of `src/text/sequence.js`; a tree is
  `meta.blocks[field]` with `k: 'tree'`, a block of `src/tree/moves.js` — how a block merges (Fugue,
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
  `=` `{ elem, value, k? }` (`k: 't'` on a text's embed slot), `move` `^` `{ elem, cut, at, value }`, `mark` `*`
  `{ start, end, key, value, many? } | { off }`, `tree` `~` `{ node, parent,
  fi }`. An index, a sibling or a range is resolved in `prepareOp` INSIDE the
  queue (`resolveSplice`/`resolveMove`/`resolveMark`/`resolveTree` in
  `src/commit.js`: `OUT_OF_RANGE`, `CYCLE`, `NOT_FOUND`, and `SURROGATE` for an
  index of a text between the halves of a pair — `wholeCharacters` in
  src/text/text.js, over the rendered text; `spliceArgs` refuses content with
  a lone half; src/text/myers.js diffs by code points where a surrogate is
  about, so `updateText` never makes one; `resolveTree` folds
  the tree ONCE and hands back `null` for a move to where the node is, and
  `commitLocal` returns before `applyOp` on it). `sync.pendingMax`
  (`PENDING_MAX`), `MAX_RUN` (`src/text/rle.js`), `MAX_FIELD`, `MAX_FI`, `MAX_DEPTH`,
  `MAX_MOVES` (a tree field's moves; a join keeps the oldest) and `MAX_COUNT` bound
  what a peer can make a node hold or read — and `MAX_WALK` what a fold walks: a
  move under a parent deeper than it is moot, like a cycle — on the op path
  and in `normalizeMeta` alike — a snapshot buys nothing an op could not. The
  fuzz in `tests/suites/sync-engine.js` compares the blocks and the move logs
  across nodes, not only what they read as. `compact(id)` (`src/patches.js`)
  = `applyPatches(id, diffViews(null, {}, reading, kinds))` laid in runs of
  `MAX_RUN`, then a text's marks as `mark` patches (`marksIn` in
  src/text/sequence.js): a reset plus one op per field, one move per node —
  convergent through the reset rule.
- **An embed is a character with a value.** A text's embed slot is U+FFFC in
  the content (`EMBED` in `src/args.js`) and its marker `{ type, parents,
  attrs, isEmbed }` an entry of the block's `vals` (as a list element's
  value): a `splice` payload carries `vals: [[offset, marker]]` for the
  slots its content holds and `applySplice` lands them with the slots; an
  `assign` lands on a text's slot too, carrying `k: 't'` (`kindOfOp` reads
  the op alone — a kind read from the held block would not commute — so a
  text's assign ranks as a text and an unmarked one as a list). `spliceArgs`
  refuses U+FFFC in plain content unless `{ embeds: true }` — only
  `insertEmbed`/`splitBlock` and a patch with `vals` pass it — and
  `updateText` refuses a hunk that inserts one. The engine knows no marker:
  `S.valueAt` hands back what the slot holds, `markerOf` in
  src/text/text.js normalizes it (another shape reads as none), `spans()`
  types every span (`text`/`embed`/`block`). A diff needs what the reading
  leaves out: `diffViews(..., { context: { from, to } })` hands the plugin
  the entries (versions, compact) or the `embeds` a `commit` event carries
  (undo; built by the plugin's `values(entry, field)` in `announce`) — a
  splice patch gets `vals`, a changed marker a `setAt` patch (b-side index,
  after the splices). Never diff a text without the context where a slot may
  be: the inverse would lay a bare slot.
- **`applyOp` reports what the reading shows.** `changes` (src/ops.js) are
  in the write API's terms and the reading's indices: the path that applied
  the op pushes its own — `put`, `inc`, `add`/`remove` (the elements that
  came in and went out), a plugin's `change` from `apply` (a splice's cuts
  in the indices before, last first, and its insert in the indices after,
  both read from the rope by `S.spanOf` in O(log n); a tree's moves from the
  folds before and after, the node with its parent and the sibling before
  it; a mark over its anchors' range less what a newer mark of its key holds, `S.newerRanges` — a
  peer's older mark changes no character a newer one decides) — and marks the field `covered`;
  `changesOf` completes the rest from
  `delta` as a `reset` with a copy of the value, or an `unset`; `delete` and
  `purge` are one change each. Never diff two readings on the op path. Every
  announce hands them on: `change(op, via, { changes })`, `commit.changes`
  and `commit.txn`, and ONE `transaction` event per turn (a commit, a
  transaction, a peer's page, a joined snapshot) with the changes tagged by
  id — built only while something listens.
- **`observe` is a registry over the `transaction` event, not listeners.**
  `Storage#observers` (per id, `{ path, listener }`) is fed by ONE
  `transaction` listener attached at the first `observe()` (the event is
  built only with a listener, so observers cost nothing before); `touches`
  decides a path's share (the field, under it, a prefix of it, the whole
  record); a listener is contained like an event listener. `toDelta` in
  src/text/text.js composes changes with a small Quill `compose` (retain /
  insert / delete, attributes; an embed slot as `{ insert: { embed } }`, and
  an `embed` attribute over a slot the turn inserted replaces its marker —
  never an attribute on the insert, which a reader takes for a mark);
  `applyDelta` is ONE transaction through `core.transact` (lent for the
  plugins' methods: a transaction from outside the queue) — never a commit
  per op.
- **A payload the engine does not admit is never silent.** `applyOp` reports
  `reason: 'malformed'` in `rejected` (`malformed()` in `src/ops.js`): on the
  local path `refuse()` in `src/commit.js` throws a `TypeError` — the
  arguments were checked, so this is a bug — and from a peer it is
  `OP_REFUSED{reason:'malformed'}`, counted in `syncom.ops.rejected`, the op
  still logged and relayed as a no-op (a dirk, never a gap). A `bound`
  refusal carries `detail` (`pending`/`run`/`field`/`counter`), `count` and `max`.
- **A block IS the index, and it is never mutated in place.** A block of
  `src/text/sequence.js` is a plain object — `k`, `ts`, the maps, and `runs`
  as a getter that serializes the rope in walk order once per version — whose
  engine state is in a module-private WeakMap: the rope (`src/text/btree.js`),
  the run records (`src/text/pmap.js`; a placed record's segments and the
  children at its offsets in `src/text/plist.js`), what waits, the counts the
  bounds read. Nothing else is on the object (`lengthOf`, `totalOf`, `render`
  are the engine's). Every op goes through `draft`/`finish`: a new block, the
  structures path-copied, the block before reading as it did; `indexOf(entry,
  field)` hydrates plain JSON once onto `entry.cache` and hands an engine
  block back as it is. Hints — an item's leaf, a node's parent — are right
  for the HEAD of a lineage only: an edit, a position or a neighbour asked of
  an older block forks it into a lineage of its own (`ensureHead`,
  `stats().rebuilds`) and the tree re-hints itself once (`T.stats().rehints`);
  a top-down reading never reads a hint. A text's reading is the rope's
  cache per node (`T.text`): after one op it costs the path the op copied,
  never the text. A run is placed whole with what hangs under it
  (`walkSubtree`, `placeRun`; a run under a parent not here yet is attached
  to it, `attachChild`, and walked when the parent lands); a stretch of a run
  with no child at it is emitted piece by piece (`emitPieces`), never slot by
  slot. `prune` is O(1) through `oldest`/`oldestAnchor` and rebuilds from
  JSON only under a base it has not seen. `latestClock(meta, true)` is the
  trusted path for an entry this node holds — a peer's raw meta takes the
  untrusted one, which normalizes first.
- **Nothing on an op's path reads the whole text or walks the whole cache.** A change report,
  a check or a resolve reads the rope: `S.spansOf`/`S.spanOf` for a run's stretches, `S.styleAt`
  for the marks at one index, `S.heldAt` for a unit — never `S.render(...)` sliced or `S.spans`
  (a fresh reading is a V8 rope, and a slice or a `charCodeAt` flattens it), and the rope's
  leaves concatenate their bodies, never `join` (src/text/btree.js `textOf`). `EntryStore.remember`
  looks at `EVICT_SCAN` of the oldest entries at most, and the deferred window lands by count as
  well as by time (`DEFER_RECORDS`, `DEFER_POSITIONS`): an await loop over `memory()` never lets
  a timer fire. Each of these was once O(n) per op and took a typing rate from tens of thousands
  to a few thousand; `bench/compare` (fresh process, thousands of awaited ops) is what shows it —
  a short microbenchmark inside one deferred window does not.
- **Ops from one origin apply in seq order; seqs run per origin AND scope**
  (`origin@scope` vector keys), and ops born from a snapshot (`merge`,
  `advance`) run in their own `origin@~` stream. `applyRemote` skips
  duplicates and gaps; resume from the last event id fills the gaps.
- **Log first, then data — and the queue is free at the append.** `OpLog.append`
  reserves the seqs and moves the vector AT ONCE (synchronously; the next op
  of a stream is numbered after it before it is on disk) and returns a ticket
  (`ticket.entries` from the start) that resolves once the GROUP is on disk:
  every append that comes while a group is being written joins the next one,
  written as one LINE of a journal where the backend has `append` (below) or
  as one `open/<firstSeq>.json` where it has not; a failed group write takes its seqs
  and the vector back (`#fail`, `onFail(error, from)` to the storage) and
  rejects its tickets and the group behind it. `src/commit.js` splits at the
  append: `issue` (in the queue: sign — on the thread pool when `core.pipelined()`,
  the group's file waiting for `ready` — append, `core.inflight(id, entry,
  position)`) and `land` (outside the queue, through `core.landing`, in log
  order: `await ticket`, then the block and the file or the deferred slot,
  `core.settled`, then `announce`). The write paths read a record through
  `core.current(id)` — the newest in-flight entry, else the cache — never
  `entries.load` directly; a read (`get`, a cursor) sees a write once it is
  durable (`EntryStore.hold`/`write` at the landing). `core.persist` (a page,
  a merge) goes through the same `#landing` chain, so files are written in
  log order; unique keys are checked against the in-flight entries too
  (`#conflicts`); `applyPatches`/`updateText` await their landings before
  returning — and before rethrowing. `commit()` returns `{ op, done }`;
  `storage[COMMIT]` awaits `done`. `close()`, `flush()` and `tag()` drain the
  landings first; `stats().inflight` counts them. The log resolves a group
  only after the roll its file triggered (`#roll` is O(1) when nothing can
  be sealed: `#unappliedFrom`, the oldest open group not applied whole).
  A reopen replays the unsealed tail.
  A node's own seq must never repeat — it is recovered from the log's vector.
  The storage opens its log with `sealApplied: true` and every write path
  calls `log.applied(from, to)` after `EntryStore.write`/`#persistBatch`; a roll then
  seals nothing from the oldest batch not yet applied onwards. A new path
  that appends must mark what it applied, or the tail grows forever. Under
  `open({ defer })` — 16 ms BY DEFAULT (`DEFAULT_DEFER` in src/options.js;
  the tests that read files open with `defer: 0`) — a local write stops at
  the append: `land` hands the entry to `Storage#deferWrite` — `EntryStore.hold`
  (cache, catalog, held), a slot per record with its positions, one timer —
  and `#flushDeferred` is a STEP of the landing chain (`#landDeferred`: the
  slots taken when the step runs, after every landing before it, so the
  cache never goes back to an older entry and `#persistBatch` never runs
  twice at once) that lands every slot through `#land` (one block, the files)
  and marks the positions applied — `#settleDeferred(id, toSeq)` settles a
  slot only when the landing covered its positions. While a deferred landing
  is queued or running (`#flushing`) a write arms no timer — the landing arms
  the next window when it is done, `max(defer, #flushCost)` long — or the
  flushes of a large record run back to back, a keystroke or two each, with
  the writer waiting behind them (it was measured: 139 ops/s at 13 000 runs).
  `flush()`, `tag()` and `close()` flush first, and
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
  it is never thrown through — `core.persist` (`Storage#land`) and `land` in
  src/commit.js hold the entries in memory (`EntryStore.hold`, never
  evicted), leave the batch unapplied for the next open to replay, and
  report `UNPERSISTED`. A node that dials keeps its own ops past retention
  until every enabled registered node in their scope holds them
  (`OpLog.retain(keep)`, `node.acked` — the own keys of a peer's vector,
  replaced at hello, raised by push answers); a host behind what the log
  retains is `UNDELIVERABLE`, and a host ahead of the node's own stream at
  hello is `REWOUND`. A node's own streams move by its own writes alone: a
  feed's `advance` and `adoptVector` leave their keys out (and any seq that is
  no positive safe integer); `#rewind` in src/sync/manager.js moves them past
  the host's (`storage[REWIND]`, up to `MAX_SAFE_INTEGER − 2^32`, then
  bootstrap) only on PROOF — the hello answer's `proof`, the host's newest op
  of the stream, this node's own at the claimed seq and verified under its
  key (`storage[SIGNER]`) — or under `sync.rewind: 'adopt'`; unproven, the
  stream stays, `REWOUND` says `adopted: {}` and `peer.rewound` keeps it from
  that host until the next hello. Never adopt a host's word on own keys.
- **A version is folded, a fork at one is paged.** `atVersion` in
  src/versions/api.js folds every id the log retains entries for (`log.ids()`)
  and every catalog id through `versionEntry`, and computes the vector at the
  version per stream from the retained entries (a stream with nothing retained
  was dropped whole below the floor — inside the version; one retained only
  past the version is `HISTORY_GONE compacted`); its `snapshot` is `pageOf`
  over a synthetic catalog — never a second page writer. `branch()` takes
  `from: { at }` through it. Blame (src/blame.js, the plugins' `editors`
  hook, the text plugin's `editorOf`) reads the metadata alone: an `origin`
  is a node id, never resolved to a person here.
- **A log file is whole or it is nothing.** `fileOf`/`readFile` in src/log.js
  are the ONLY writer and reader of a log file's text: `{ entries, hash }`,
  the hash xxHash32 (src/hash.js) of the entries' JSON; a mismatch is
  `log.segment.unreadable`/`log.open.unreadable` with `reason: 'checksum'`,
  counted in `corrupt`, never read in part. A file without a hash is an
  older format and taken as it is. `retention: 'all'` is `{ ops: Infinity }`
  (`retainedOps` Infinity) — normalized in the OpLog constructor, nowhere else.
  Where the fsi has `append` the open groups are a JOURNAL, a log file per
  line: `open/<pad(first)>-<session><counter>.jsonl` — a name no failed
  group's line is in, begun again at every roll (`#seal`) and after a failed
  append (`#flushGroup`), removed once none of its groups is open. `#open`
  holds the groups `{ first, last, file }`, never the files. `#loadOpen`
  reads the names NEWEST FIRST and `#adopt` keeps the first copy of a seq —
  that is what shadows the line of a group whose append failed after it
  landed (its seqs went to a newer journal); a torn LAST line is left out
  (`log.open.torn`), a line inside that does not read is `#lost`; a later
  open never appends to an older journal. `#scrub` rewrites a journal whole,
  a line per group it holds. A wrapper that cannot append a file in place
  (`atRest`: one ciphertext per file) must not pass `append` through.
- **A failed page is a break in the stream.** `#receive` runs pages one after
  another per peer (`peer.inbound`), numbered by `peer.feed`; a rejection goes
  to `#pageFailed`, which closes the feed (pages of the old feed are dropped),
  reports `PAGE_FAILED` with the saved cursor, and resubscribes from it —
  `STUCK` after `MAX_PAGE_RETRIES`. Never move `node.cursor` past a page that
  did not land, and never catch inside `#receive` to "keep going".
- **A hosted feed's cursor moves to a real entry, never to `lastEventId`.**
  `changes` in `src/sync/hosting.js` reads through `OpLog.read`, whose `last` is
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
  reach the storage's state from a path module except through `core`. A
  transaction (`transact` in src/commit.js, what `storage.transact()`,
  `applyPatches`/`restore`/`compact` run) is the first path over a core
  whose `current` and `seqOf` see the ops made before — `prepare` per op,
  ONE `log.append` of them all, one `core.land` (a chain block, the files),
  the announces after; a throw from `fn` leaves nothing appended. A plugin
  method takes the transaction's core as its `core`, so it needs no
  transaction-aware code: it must only go through `core.commit`/`commitNow`
  and `core.current`, never `core.log` or `core.entries` for a write.
- **Reconnect/backoff/resume belong to the link.** `SyncManager` re-runs only
  `hello` + `push` on `reconnect`; a refused restored subscription (428 "say
  hello first" — wrpc gives a reconnect a NEW server-side client) triggers a
  fresh handshake, at most `MAX_REHELLOS` in a row. Do not add a reconnect
  loop or a timer to syncom: a failed push marks the peer `behind` and
  `#recover` pushes from the vector at the next sign of life on the link (a
  page in `#receive`, an op in `#fanOut`) or on `sync()`, backed off by a
  timestamp. Every push goes through `#serializePush` — never call
  `#sendPages` from a new place.
- **Async asymmetry is real.** `calculateHash`, `sign` and `verify` are synchronous in
  `src/signing/ed25519.js` and promise-returning in `src/signing/ed25519.browser.js`; so are
  `encrypt` and `decrypt` in `src/encryption/rsa.js` against `rsa.browser.js`. Shared code must
  `await` them; each subpath's `*.browser.d.ts` (the `browser` types condition of its export)
  exists to declare that difference. Do not "fix" it by making the Node half async. The one
  async function of the Node half is `verifyAsync` — the engine's verify, `crypto.verify` with
  a callback, on libuv's thread pool — and it is not on the subpath's surface: `signing.js`
  leaves it out by name, and `src/signing/sign.js` is its only caller. In the browser it is
  `verify` itself. The core's own hash, `sha256` in `src/digest.js`, is async on both.
  The barrels spell every export out — a required module spread whole, the
  rest by name, never a spread of a local — because that is the shape Node's
  cjs-module-lexer reads for an ESM importer (`tests/package/esm.test.js`).
- **Signed ops: the id is the key, the signature is the header plus a salted
  digest.** With the `signing` plugin `nodeId` = the Ed25519 public key (`isKeyId`: 43
  base64url chars, canonical last char — a non-canonical one is the same key under another
  id); `keys/sign-*.pem` next to the RSA pair, `node.json` names the id (a non-key id there —
  a UUID from before signing, or a directory opened without the plugin — is rekeyed once with
  `identity.rekeyed`; another key id is `IDENTITY_MISMATCH`, never silent). Without the plugin
  the id is what `node.json` names or `getId` mints, and a key id stays the id. `src/signing/sign.js` signs
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
  documented — and so is the plugin on every node, since a node without it
  signs nothing. Never put the key or a signature into a metric label.
- **A `.d.ts` change and its `tsd` test land together** (`tests/*.test-d.ts`).
- **An editor binding sends one delta at a time, with `expect`.** `applyDelta(id, key,
  delta, { expect })` compares the field's text inside the queue and refuses `STALE` before
  any op; `src/editor/editor.js` keeps a shadow of the field, rebases a refused delta over
  the peer's (`transform`, the peer's insert first at a tie — the storage's order) and
  sends it again, and rebases a peer's delta over what the editor holds beyond the shadow
  before handing it over. A binding or adapter that resolves an editor's indices against
  the storage without `expect` races a peer's edit; a nested `transact` (a plugin method
  inside a transaction) runs within the enclosing one. `expect` compares text alone: a peer's
  change made of the characters it replaced passes it, and the delta lands by index over the new
  ones — so a binding that rebased its delta in flight (`rebased`) reads its own event against
  the rebased delta and reloads where they differ. A send that failed holds every later send until
  its reload (`reloading`), and `load()` drops `pending` before `setContents`: what was typed
  over the old contents is never sent over the new.
- **An editor adapter injects its editor and fits the field to its schema.** `/prosemirror`
  (and `/codemirror`) take the editor's modules as an argument and require nothing of them
  — the packages are devDependencies for skip-guarded tests and optional peerDependencies for
  their types. A ProseMirror document is a marker per block-level node in document order
  (`docToSpans`/`spansToDoc`); what the schema cannot hold is left out when it is read back.
  The adapter NEVER answers a peer's change with an edit: what the document differs from the
  field by (`unfit`) is held and goes out composed with the editor's next edit (`compose(unfit,
  local)`) — two editors that each fitted a merge sent the same structure twice, unfit again,
  and answered each other without end. Until then the adapter's `base` is the binding's view
  and every index crosses `unfit` (`toDoc`/`toField`: the selection, the cursors,
  `indexOf`/`posOf`) — a delta in the document's indices lands askew. `/codemirror` does
  the same for line breaks: `lineBreaks(text)` is the fit and its way back (an insert before
  a delete, so an index beside a break stays beside it — a Myers diff pairs it with another
  `\n`), and a peer's delta over a held fit lands as the field's text read again
  (`state.toText`, then the diff), never transformed over the fit: both would insert the `\n`. A send
  that fails other than STALE reloads the editor after a growing pause and the binding stops
  after `MAX_FAILURES` in a row: never retry in a microtask loop (it starved the event loop
  for hours once).
- **Record types are phantom.** `Schema<Shapes>` (`shapes?`) and a Standard Schema's
  `~standard.types` are read by `index.d.ts` alone — `Collections<S>` maps them to
  `SyncomCollection<R, I>` — and nothing at run time reads `shapes`; `RecordData` is the
  type wherever the schema says no more. A reader of a record takes `R` (`get<R>`,
  `record<R>`) rather than returning `unknown`; a new one does the same.
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
  `src/telemetry/telemetry.js` (the telemetry plugin's) duck-types whatever
  `open({ telemetry })` was given and returns a writer the plugin's `setup`
  hands the core (`telemetry` hook); the core takes a writer given to it
  (`isWriter`) CONTAINED by `writerOf` — a missing method is a no-op, a
  throwing one is swallowed, `withSpan` runs the work exactly once (a writer
  that threw after an append once hung every write) — and refuses an api or
  a tracer without the plugin; the lock
  wait is measured in `#init` and recorded once the writer is there.
  `DISABLED` (src/telemetry.js) is a frozen null-object whose `withSpan` still
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
  `droppedTs`.** The model is the header of `src/versions/history.js`; the glue is
  `src/versions/api.js` (`past`/`applied`/`present`), the versions plugin's,
  outside the queue:
  `log.entriesOf(id)` filtered by `appliedHere` (skipped out, held in once
  the node runs the version), folded with `applyOp`. With `droppedTs > 0` the
  fold of everything retained must `deepEqual` the present (`present`) — the
  counter straddle `repair()` also has — or it is `HISTORY_GONE compacted` /
  `exact: false`; a stamp below a retained `merge` is `reason: 'merge'`, a
  cut before a purge `'scrubbed'`. Never answer a version from the record
  file or the catalog, and never fold from an entry below the exact start.
- **A tag is copy-on-write at the EntryStore seam.** The layout, the read
  walk, the untag move-down and the lazy read of an older tag are the header
  of `src/versions/tags.js` (the versions plugin's: without the plugin
  `core.tags` is null, `stats().tags` null, and a directory with tags is
  refused at open — `#hasTags`). What crosses modules: record files are copied by
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
  `src/versions/api.js`) reads through `sourceAt`, a `storage[SOURCE]`-shaped seam
  over the tag's catalog (`searches` false, `subscribe` throws), and pages
  through `snapshotPage` with a core of the tag's catalog, entries and
  position — the same `pageOf`, never a second page writer.
- **A patch is in the write API's terms, and the only way back is new ops.**
  The vocabulary and the per-kind diff are the header of `src/patch.js`;
  `realize(patch)` maps to `[type, payload]` for `commit()`. `applyPatches`
  (`src/patches.js`, the core's) rehearses, then runs them in ONE `#run` turn;
  `restore(id, at)` = `applyPatches(diff(id, undefined, at))` — never rewrite
  the log or the file. A `remove` patch with `removals` goes out as given
  (`prepareOp` takes `payload.removals` over `observedTags`), one with `own:
  true` keeps this node's tags alone (`ownTags`): an undo revokes this node's
  adds and leaves a peer's. The `commit` event (`announce` in src/commit.js)
  is LOCAL ops only, built only when `listenerCount('commit') > 0`, with
  `before`/`after` as copies and the kinds of both sides — the copies (and
  `embeds`) taken at their first read, never on the write path (`commitEvent`;
  the data objects are never changed in place, so a late copy is the same);
  the undo manager keeps the events (`Kept`: a step's first `before`, last
  `after`) and copies only when it inverts. A peer's op raises `change`,
  never `commit`.
- **A step of the undo stack is a transaction's worth, with the app's meta.**
  `#commit` in src/undo/undo.js joins a commit to the top step when the open
  `group()` takes it, when its `txn` is the step's, or within `mergeInterval`;
  `trackedSources`/`records`/`paths` filter commits first (`reaches` reads
  the commit's `changes`; a whole-record change reaches no path). The step's
  `meta` object is handed out as it is (`stepView`) and copied by reference
  to the opposite stack's step on undo/redo — never cloned. Under `paths` the
  inverse is `scoped` to the tracked fields before the conflict check;
  `typesAround` counts a change at a prefix or under the field as the
  field's.
- **Presence is never logged, and a host relays only a peer's own.** A
  presence update is `{ p: 1, scope, s: [[node, clock, ts, state, sig?]] }`,
  signed per entry as `[1, node, clock, ts, canonical(state)]` through
  `storage[SIGNER]` (`signMessage`/`verifyMessage` of the signing plugin's
  identity; `canonical` lives in src/shape.js). It travels as the
  fire-and-forget event `syncom/presence`: `link.send` on the dialing side,
  the unit's `on.presence` handler on the host (src/sync/hosting.js), which
  refuses — counted, never relayed — an update whose entries are not the
  greeted node's, of a scope not asked for, past `presence.rate`, or unsigned
  under 'require', then relays to `syncom:<scope>` except the sender and
  keeps the newest state per node for a newcomer's hello. The dialing side
  takes a host's relay with `from: null` (the host checked who said what; a
  signature says the rest). Nothing of it reaches the log, the chain or the
  Record; `receivePresence` feeds the registered instances alone.
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
  `snapshot()` and `swap()`; the cursor itself is the query plugin's
  (`src/query/cursor.js`), made through `storage[CURSOR]` (a Collection's
  `select()`, a tag view's through `core.cursor`). `Cursor#matching` is the one place that reads
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
  `#defineSchema`) LAZILY: `#insert`/`#remove` leave the last word per id in
  `#textPending`, and `candidates` flushes it before a `$text` query reads the
  index (re-indexing a text on every keystroke cost the whole text each time)
  — under a try/catch that logs `catalog.search`: derived state never fails a
  write. A `put` that leaves a row as it was posts nothing, saves nothing and
  wakes the watchers with `changed: false` — a covered cursor does not run. `compileQuery` takes
  `$text` at the top level only and makes no test of it; `fieldsOf` skips it;
  `Catalog.candidates` seeds `#narrow` with the index's ranked ids (a fresh
  Set) and every `meet` keeps the seed's order, so an unordered cursor hands
  rows out best first. Never apply a limit inside the index (the equality
  intersection comes after, and `count()` needs every match), never persist
  the index — `load()` replays the rows through `#insert` (into the pending
  map) — and never let the
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
  validator (adapted in `src/schema/define.js`, the schema plugin's; the core
  only applies what the plugin's `schema` hook handed it, through
  `src/entity.js`) sees
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

`INVARIANTS.md` names, for every guarantee (`SYNC-n`, `OPS-n`, `LIST-n`, `SEQ-n`, `RLE-n`,
`TREE-n`, `BOUND-n`, `LOG-n`, `VER-n`, `TAG-n`, `PATCH-n`, `UNDO-n`, `BRANCH-n`), the tests
that hold it; `tests/package/invariants.test.js` fails when an id names no test or a named
title is gone. Rename a test and its row together; a new
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
- **The matrix is data.** Every cell of `docs/comparison.json`, `docs/comparison-rxdb.json` and
  `docs/comparison-crdt.json` keeps the `source` it was decided from (and a `detail` for a footnote left out of
  the table); `pnpm docs:comparison` renders them. A cell about another project is decided from its source and
  official docs, not its README — the CRDT page from the clones in `../../open-source/local-first-alternatives/`
  at the commits it names; the syncom column from this repository. Keep the prose of docs/guide/comparison.md,
  vs-rxdb.md, vs-crdt.md and why.md in step with the counts.

## Documentation

Document what the code does today. When adding docs, verify each example by
running it before writing it down — several examples inherited from the legacy
repo were wrong in exactly that way. A new page needs a sidebar entry in
`docs/.vitepress/config.mts`; `docs/guide/sync.md` and `docs/guide/wrpc.md`
are the two pages that describe the protocol — keep them in step with
`src/sync/manager.js` and `src/sync/hosting.js`, and `docs/reference/wire.md` is the
byte-level reference (slots, codes, payloads, the signed header, the log and record
files, the procedures, the bounds): a change to `packOps`, `wellFormed`, `signedMessage`,
a file format, a procedure or a bound lands with its row there — `docs/guide/hooks.md` with the hook and
event surface of `src/commit.js`, `src/apply.js`, `src/bootstrap.js`,
`src/storage.js` and `src/sync/manager.js`, `docs/guide/schema.md` with
`src/schema/` (metaschema is the first-class example there; zod/ajv/JSON
Schema are the alternatives), `docs/guide/query.md` with `src/query/cursor.js` and
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
  and the error and hot-path rules of this engine. In `src/` no array method takes a callback
  and `Array.from` is not used — loops, enforced by oxlint's `no-restricted-properties` for
  `src/**` (`.oxlintrc.json` `overrides`); a data array is never spread into arguments.
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

`src/` is written in a procedural style, and the linter holds it there: no `map`, `filter`,
`find`, `findIndex`, `findLast(Index)`, `some`, `every`, `flatMap`, `forEach`, `reduce(Right)`
or `Array.from` — an indexed `for` over an array, `for...of` over a Map, a Set or an iterator.
One walk does what it can (no `filter().map()`, no second pass for a count), a membership test
inside a loop is a `Set`, and `push(...items)` / `fn(...array)` never takes a data array (it
throws `RangeError` past ~130 000 elements; a list run holds up to `MAX_RUN`). A new array is
`[]` + `push`, never `new Array(n)` filled by index (holey for good, slower to read), and a bulk
copy stays native (`slice`, `concat`). The two editor APIs named `map` (`RangeSet.map`,
`DecorationSet.map`) carry a disable comment.
