# src/CLAUDE.md — The core

Every top-level module of `src/` and the rules that span the core: plugins and the seam of the api plugins, ids, a peer's op, own keys, the op model and its kinds, paths, the three write paths, the log, stamps, the hash chain, purge, the catalog, locks, fsi, hooks and events. A folder below with a CLAUDE.md of its own holds the rules of its modules; what holds for the whole repository is in [CLAUDE.md](../CLAUDE.md).

## Layout

```
src/<name>/<name>.js      every subpath is a folder under src/ with its entry and its .d.ts beside it; package.json#exports points there.
                          A folder is a zone: a module of its zone lives in it even where the core requires it (src/telemetry/writer.js,
                          src/sync/wire.js, src/schema/entity.js), and the root holds the core alone; src/crypto/ is a zone with no subpath
src/all/all.js            @alexify/syncom/all — the core with every shipped plugin registered (text, tree, signing, chain, encryption): the
                          API as it was before the blocks
src/chain/chain.js        @alexify/syncom/chain — the chain plugin and Blockchain; SHA-256 through src/crypto/digest.js
src/plugin.js             createPlugins — the registry one open() builds: kind modules (ranks, block codes, op types, apply/join/prune/render/
                          resolve/diff/realize/migrate/compact/methods) and API modules; PLUGIN_MISSING; PENDING_MAX — requires shape.js, errors.js
src/contracts/contracts.js the @alexify/syncom/contracts subpath — never back in the barrel
src/idb/idb.js            the @alexify/syncom/idb subpath — the IndexedDB backend, browser-only
src/store/store.js        the @alexify/syncom/store subpath — toStore/fromEvents: one store object for Svelte's contract and
                          React's useSyncExternalStore over a cursor, a Record, get(), a presence or an emitter — no requires
src/inspect/inspect.js    the @alexify/syncom/inspect subpath — a record's anatomy (through the [SOURCE] seam's raw `entry`) and anonymize; requires compose, shape, symbols, hash only
src/backend.js            the fsi contract (isFsi/checkFsi; sync, create and append optional), withSync — no requires
src/memory/memory.js      @alexify/syncom/memory — memory(), the backend in memory (a Map; size, dump, the exclusive create, append) — no requires
src/layered/layered.js    @alexify/syncom/layered — layered([top, …, bottom], { write, fill, queue }): one fsi over several, a multi-level
                          cache; 'back' drains its queue before any lower layer is consulted; create is exclusive across layers
src/emitter.js            the Emitter both halves extend — no requires
src/logger.js             createLogger, the duck-typed logger writer — no requires
src/crypto/digest.js      sha256, hashOf — SHA-256 of a value's JSON as hex: the chain's, the schema hash's, an op's digest and fingerprint;
                          node:crypto here, Web Crypto in src/crypto/digest.browser.js; `sha256` async on both, `hashOf` at once in Node.js and a
                          promise in the browser (the write path names every op with it)
src/crypto/keys.js        loadKeyPair — the on-disk key pairs (RSA for sealing, Ed25519 for signing), generator injected by each crypto
                          half; the signing and encryption subpaths share it — requires errors.js only
src/crypto/pem.js         base64/PEM helpers over btoa/atob for the browser crypto halves of signing and encryption — no requires
src/scope.js              GLOBAL_SCOPE, inScope, opInScope — the one definition of "in scope" — no requires
src/blame.js              lastEditorOf, editorsOf — who wrote what, from a record's meta (registers' clocks, counters' sums, sets' slots, the plugins' `editors` hook); never the log
src/hash.js               xxHash32 in pure JS — what `anonymize` hashes a string by (src/inspect/inspect.js); a checksum, never a signature — no requires
src/crc32.js              CRC-32 of a string's UTF-8, 8 hex digits — the checksum every log file carries; zlib's in Node.js, the table of
                          src/crc32.browser.js where it is absent and in the browser (package.json#browser)
src/header.js             what names an op, the core's: the header (v1, `prev` last), payloadOf, the salted digest every node mints
                          (`digest`), the fingerprint (SHA-256 of the header) — requires digest.js and shape.js only (the signing subpath
                          ships it); `link` in src/commit.js sets an op's `prev` from the op before it in its stream
src/shape.js              isPlainObject, own, asJson, isRecordId, isStreamName, wellFormed — what enters is checked here
src/paths.js              field paths: isPath, ancestorsOf, under, valueAt, MAX_PATHS — no requires
src/compose.js            compose (the paths nested for a reader), decompose (a reading back to the fields) — requires paths.js
src/args.js               spliceArgs, treeArgs, markArgs, setElements, jsonValue, isNodeId — the write API’s argument
                          checks, shared by Storage and realize() in patch.js — requires paths.js only
src/order/order.js        the @alexify/syncom/order subpath — fractional indexes over a 62-letter alphabet (Loro's rule, MIT), as
                          strings, for ordering records — no requires; the tree plugin uses it for a node's place
src/patch.js              patches — the one vocabulary of diff()/applyPatches()/restore(): diffViews by kind, realize() to an op — requires shape.js, args.js, paths.js, plugin.js only
src/symbols.js            COMMIT / REFRESH / SOURCE — the module-private seams between Storage and what it hands out — no requires
src/lazy.js               lazyField, putLazy, copyData, assignData — a field read when it is read (a list's, `mod.lazy`): an accessor
                          the data and the delta share, copied as it is — no requires
src/options.js            normalizeStorageOptions — open()'s plain options checked and defaulted (lock, cache, chain, skew…)
src/lock.js               exclusive open: Web Locks or lock.json, stale by pid or age — requires errors.js only
src/catalog.js            the record catalog: live ids, collections, indexed values; index/catalog.json — no requires
src/storage.js            Storage — the facade: open sequence, the mutation queue, the public API, the `core` it lends
src/defer.js              DeferredWindow — `open({ defer })`'s slots, timer and landing step — no requires
src/identity.js           loadIdentity — which node a directory is (the signing key, node.json, getId) — requires errors.js, shape.js only
src/observe.js            Observers — `observe()`'s registry over the `transaction` event — requires paths.js only
src/fields.js             the API of the core's kinds beyond registers — inc/add/remove — over the lent core; a plugin's methods
                          come with it; Storage keeps a delegate per method
src/patches.js           reading, applyPatches, compact — the present and its patches, the core's (the undo subpath stands on
                          applyPatches); appliedHere lives in log.js
src/entries.js            EntryStore — record files under data/ (a large block's runs in pieces beside them: `<id>~<n>.json`),
                          the bounded cache, the catalog row each change leaves
src/record.js             Reference, Record, Collection — what the application holds; public API + the symbols only
src/commit.js             the one local write path: prepare → validate → issue (in the queue) → land → announce (outside it, in log order) (`storage[COMMIT]`)
src/apply.js              a peer's batch: admit → apply one by one → persist → announce (`storage.applyRemote`)
src/bootstrap.js          snapshot pages out, merge pages in, adoptVector — the bootstrap write path
src/errors.js             SyncomError, ValidationError, typed() — no requires
src/ops.js                the record-level model: applyOp / mergeEntry / isAlive
src/vector.js             clocks, version vectors, event ids
src/log.js                OpLog — the persisted operation log over fsi: seqs reserved at append, groups written one file each
src/                      ships as-is — no build step, CommonJS, 'use strict'
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
- **The security blocks are api plugins over one seam.** A plugin that is not a kind has
  `setup(ctx)` — `{ fsi, path, logger, options, settings, storage, hash, catalogOf }`, run in `#open` before the
  log opens, in registration order — and hands back hooks the core takes: `identity` (`{ id,
sign, verify, signMessage }`, the signing plugin), `seal` (`{ encrypt, decrypt }`, the
  encryption plugin), `chain` (a Blockchain, the chain plugin) — and `open(ctx)` — `{ storage,
options, settings, logger }`, run after the replay — hands back `sync` (the SyncManager, the
  sync plugin: `storage.sync` is PLUGIN_MISSING without it). The core reads them as
  `core.sign`/`core.verify`, `core.seal`, `core.chain`, and `core.hash` is
  `sha256` from `src/crypto/digest.js` (async on both platforms; its one crypto half is the hash —
  signing and sealing are the plugins'). Without a hook: the node id is what `getId` mints (checked by `isStreamName`), ops are
  neither signed nor verified (`checkPage` answers OK for every op), `block: null`, and an
  encrypted write is `PLUGIN_MISSING`. What the options ask for and no plugin provides is
  refused in `#open` with `missing()` — `signatures: 'require'`, `chain: true`, `encrypted` —
  never silently downgraded. A new api plugin adds a hook name here and a line in
  `docs/reference/api.md` Plugins; it never reaches the storage's state except through `ctx`
  and the hooks.
- **Browser halves are `*.browser.js`** (dot, not dash): `fsi`, `utils` and `crypto/digest` in the core,
  `signing/ed25519` and `encryption/rsa` in their subpaths. Everything else (storage, log, ops,
  sync, chain, wrpc adapter, and the require-free `emitter`, `logger`, `scope`, `crypto/keys`,
  `crypto/pem`) is shared; the two `utils` halves only re-export `Emitter`/`createLogger`
  and add the platform's own bits. Adding a split means three edits: the file, `package.json#browser`,
  and `src/index.browser.js`. `tests/package/consistency.test.js` catches a
  missed one. To run shared code against the browser halves under Node, load
  it through `tests/utils/browser-env.js` — requiring `src/index.browser.js`
  alone does NOT redirect the nested requires.
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
  recurse; `checkPage` runs after `wellFormed` and never throws, a throwing
  check is that op's FORGED); a stamp beyond `sync.maxSkew` ahead of
  `Date.now()` — the op's `ts` or any stamp a `merge`'s meta holds
  (`latestClock`) — is refused the same way (`SKEW`), never observed into
  the clock, and a stamp a record already holds past it is not observed by a
  write either (`core.observe`, `clock.skew.ignored`). `malformed` ops are
  counted, not logged, not relayed. A local write deeper than
  `MAX_JSON_DEPTH` is a TypeError (`copyPayload` in src/commit.js); the 16
  levels between the bounds are what an op and a meta wrap around a value —
  keep them apart. Payload shape is `applyOp`'s business.
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
  which rewrites the files holding what it takes (every file of the id only after a failed
  rewrite); `persist` in `src/apply.js` and `mergeBatch` in `src/bootstrap.js` scrub every id
  of the batch whose entry the batch purged, after the batch is durable and before the relay,
  and an op that lands on a record purged BEFORE it is stripped (`scrubOp`, src/header.js) and
  appended `scrubbed` — never logged or relayed with its payload. Never log a payload for a
  purged id through another path.
- **`packOps` is 19 positional slots, both halves together.** `v` (13),
  `actor` (14), `sig`, `digest` and `nonce` (15–17), `msg` (18, a
  transaction's message, ≤ `MAX_MESSAGE` in `src/shape.js`, in the signed
  header), `prev` (19, the fingerprint of the op before it in its stream, in
  the signed header) were appended; a reader
  of fewer slots ignores the rest, a reader of more takes an absent slot as
  null. Append, never reorder — the
  shape is on the wire between every pair of peers (the log itself stores
  keyed `{ seq, op, fp }` JSON; `packOps` — src/sync/wire.js — is for `push` and `changes` only). An
  op type is one character in `TYPE_CODES`/`CODE_TYPES` (`+`/`-` are the set
  ops). Once the package is published, an older reader counts an unknown type
  as malformed and its stream stalls there — a new type, or a slot an older
  reader cannot take as null, is then a `PROTOCOL` bump (`src/sync/protocol.js`).
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
  `added > removed`, read sorted by element text — a field's elements map shared between an entry
  and the one an op derives from it until the op writes it (`writableSet` in src/ops.js: every
  in-place write of a set goes through it), the reading moved by the elements the op names; a list or a text is
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
  src/text/kind.js, over the rendered text; `spliceArgs` refuses content with
  a lone half; src/text/myers.js diffs by code points where a surrogate is
  about, so `updateText` never makes one; the tree plugin's `resolve` reads
  the fold the block keeps and hands back `null` for a move to where the node is, and
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
- **`applyOp` reports what the reading shows.** `changes` (src/ops.js) are
  in the write API's terms and the reading's indices: the path that applied
  the op pushes its own — `put`, `inc`, `add`/`remove` (the elements that
  came in and went out), a plugin's `change` from `apply` (a splice's cuts
  in the indices before, last first, and its insert in the indices after,
  both read from the rope by `S.spanOf` in O(log n); a tree's moves from the
  fold as the op found it and as it leaves it — the nodes that moved, the
  siblings next to them, the levels that cross a cut — the node with its
  parent and the sibling before it, in the order the two readings diffed would
  list them; a mark over its anchors' range less what a newer mark of its key holds, `S.newerRanges` — a
  peer's older mark changes no character a newer one decides) — and marks the field `covered`;
  `changesOf` completes the rest from
  `delta` as a `reset` with a copy of the value, or an `unset`; `delete` and
  `purge` are one change each. Never diff two readings on the op path. Every
  announce hands them on: `change(op, via, { changes })`, `commit.changes`
  and `commit.txn`, and ONE `transaction` event per turn (a commit, a
  transaction, a peer's page, a joined snapshot) with the changes tagged by
  id — built only while something listens.
- **`observe` is a registry over the `transaction` event, not listeners.**
  `Observers` (src/observe.js; per id, `{ path, listener }`) is fed by ONE
  `transaction` listener attached at the first `observe()` (the event is
  built only with a listener, so observers cost nothing before); `touches`
  decides a path's share (the field, under it, a prefix of it, the whole
  record); a listener is contained like an event listener. `toDelta` in
  src/text/deltas.js composes changes with a small Quill `compose` (retain /
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
  `storage[COMMIT]` awaits `done`. A write is made AT ONCE, outside the queue
  (`Storage#fastCommit` → `commitAtOnce` in src/commit.js, LOG-9), where a turn of the queue
  of its own would change nothing: the storage set up with nothing asynchronous on the write
  path (`#fastIssue`: no beforeWrite/afterWrite hook, no signing, no telemetry, no actor
  function, no lens, `defer > 0`, a hash Node.js makes at once), the queue idle, no hook
  running, no landing step pending (`#slowSteps`), the record live and held here (in flight or
  cached — `#currentNow`), its entity without a validator or unique keys, nothing encrypted or
  expected; anything else goes through the queue. It shares `opOf`/`applyLocal`/`prepared` with
  `prepare`, chains at once and appends with `log.enqueue(…, { onDurable })`: the landing
  (`landNow` — the deferred slot, `settled`, the announce) runs as its group is written, before
  the group's promise settles, and `core.landed(done)` makes every landing step after it wait
  for that group. The method delegates (`splice`, `push`, `setAt`, `move`, `inc`, `add`,
  `remove`, `unset`, `update`) have no async frame: an argument they refuse is a rejection,
  never a throw. `close()`, `flush()` and `tag()` drain the
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
  the append: `land` hands the entry to the `DeferredWindow` (src/defer.js, `write`) — `EntryStore.hold`
  (cache, catalog, held), a slot per record with its positions, one timer —
  and its `flush()` is a STEP of the landing chain (the
  slots taken when the step runs, after every landing before it, so the
  cache never goes back to an older entry and `#persistBatch` never runs
  twice at once) that lands every slot through `#land` (one block, the files)
  and marks the positions applied — `settle(id, toSeq)` settles a
  slot only when the landing covered its positions. While a deferred landing
  is queued or running a write arms no timer — the landing arms
  the next window when it is done, `max(defer, cost)` long — or the
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
- **A log file is whole or it is nothing.** `fileOf`/`readFile` in src/log.js
  are the ONLY writer and reader of a log file's text: `{"e":[…],"c":"…"}`,
  the entries positional (`[seq, fp, header, payload, rest?, flags?]` — the header the
  text `link` fingerprinted, handed to `log.enqueue` as `headers`; `opOf` in src/header.js
  reads an op back) and `c` the CRC-32 (src/crc32.js) of their text, last, checked BEFORE
  they are parsed. A segment (`segmentOf`/`readSegment`) is the lines its groups were
  journaled as — each open group keeps its `line` until sealed, and a scrub or a rewritten
  journal writes it again first (`#lineOf`, LOG-10) — and a trailer `{"lines","to","c"}`, read
  whole or not at all; a mismatch is
  `log.segment.unreadable`/`log.open.unreadable` with `reason: 'checksum'`,
  counted in `corrupt`, never read in part — an open group file so is moved to `log/corrupt/`,
  never deleted; a read that fails other than ENOENT fails the open (`readOrNull`, `CORRUPT`). A file without a hash is not
  whole. The segments are what the directory lists — the index names none and is written where
  compaction dropped something; a gap among them is `log.segment.missing`. `retention: 'all'` is `{ ops: Infinity }`
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
  `#run`, all over the `core` Storage lends them (`#lend`: frozen, its members listed by
  `tests/package/core-surface.test.js` — a new one changes that list on purpose), all ending in
  `#persistBatch` or `EntryStore.write`. Do not add a fourth, and do not
  reach the storage's state from a path module except through `core`. A
  transaction (`transact` in src/commit.js, what `storage.transact()`,
  `applyPatches`/`restore`/`compact` run) is the first path over a core
  whose `current` and `seqOf` see the ops made before — `prepare` per op,
  ONE `log.append` of them all, one `core.land` (a chain block, the files),
  the announces after; a throw from `fn` leaves nothing appended. An op its
  record's later op follows keeps its op and changes alone (`release`): the entry only while a
  `commit` listener exists, the hook ctx only with an `afterWrite` hook — N copies of a large
  record were N² memory — and a record is in flight, deferred and refreshed ONCE, as its last op
  left it (the live Record with the deltas laid over each other). A plugin
  method takes the transaction's core as its `core`, so it needs no
  transaction-aware code: it must only go through `core.commit`/`commitNow`
  and `core.current`, never `core.log` or `core.entries` for a write.
- **A stream is a hash chain; a fork is refused, never healed.** An op's
  fingerprint is the SHA-256 of its header (`fingerprintOf`, src/header.js) —
  the same on every node, whole after a scrub — and it names the one before it
  in its stream (`opKey`, the `@~` stream too) as `prev`. The log keeps `fp` on
  every entry it is handed one for (`append({ fps })` — every write path hands
  them), an index stream → seq → fp of what it retains and reserves, and a head
  per stream (`[seq, fp]`, in index.json beside the vector, kept past
  compaction); both move at the append and go back with the vector in `#fail`.
  `admit` (src/apply.js) holds a peer's op to them: a duplicate with another
  fingerprint, and a next op whose `prev` is not the one held at seq − 1 (or
  none, signed), are `EQUIVOCATION` (`reason` `'seq'`/`'chain'`) — not logged,
  not relayed, a gap, reported once per page, never a throw. Where nothing is
  held at seq − 1 (a stream joined by snapshot, a REWOUND stream without its
  proof op) the op is taken and the chain held from it; an unsigned op without
  `prev` is a hand-made one, taken. A REWOUND proof's op becomes the stream's
  head (`log.adoptHeads`). A new path that mints an op of this node's own goes
  through `link` before it signs, or its next op names the wrong predecessor.
- **`merge` adds numbers.** `merge({ hits: 10 }, { hits: 1 })` is `11`. This is
  the counter CRDT and it is deliberate — but it means a `diff` of numeric
  fields is not a plain patch. Do not "correct" it, and do not write docs or
  examples that assume replacement. Storage does NOT replicate through
  `merge`; the op model in `src/ops.js` is what converges.
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
- **The catalog is derived state, kept at one seam.** `EntryStore`
  (`src/entries.js`) is the only place that `catalog.put`: `write` (every
  write path goes through it), `writeSealed`, `remove` and `index`; it
  indexes the lensed view and never fails a write (a throwing lens is logged
  and the raw data indexed). `#flushCatalog` (`core.saveCatalog`) saves it OFF the
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
- **Hooks run inside the operation; events never do.** `src/hooks.js` (it
  requires errors.js only — it ships to the browser) is the whole mechanism. Storage hooks
  go through `#hook()` inside the mutation queue, and `#run` refuses a write
  while one is running — a write from a hook would wait for the hook that
  waits for it. Hook calls live in `src/commit.js`, `src/bootstrap.js`
  (`core.hook`), `get`, `src/apply.js`, `#connect` and `#bootstrap` only; there is deliberately no hook on the ops
  that leave for a peer (a withheld op is a gap that stops that stream —
  scopes are the per-peer filter). Only the hooks that run inside the
  mutation queue go through `#hook` (`core.hook`) and its `#inHook` guard;
  `beforeRead`/`afterRead` call `runHook` directly — a write from a read hook
  queues. Every event leaves through `notify()` (a path module's through `core.emit`, which is it):
  never `await this.emit(...)`, never emit `error` any other way (the Emitter
  throws on an unheard `error`, and that throw used to fail a push before the
  vector moved). A remote op a `beforeApply` skipped is still appended, with
  `skipped: true` on its log entry — that flag is what keeps `#replayTail`
  from applying it on reopen; do not strip it.
