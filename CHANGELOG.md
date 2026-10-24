# Changelog

All notable changes to **`@alexify/syncom`** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

This package has not been published to npm yet, and will not be until it does
what it is meant to. `package.json` carries `0.0.1`, a development placeholder,
not the version of the first release — that is chosen when the release is cut.
There is no released version section until then; everything below lands in it.

### Added

- **Lists and text.** A field can be a list — an array edited by position —
  or a text — a string typed into: `splice(id, key, index, count, content)`
  and `push(id, key, content)`, on the storage and on a live Record. Two
  nodes inserting at one spot both keep theirs, each writer's run whole
  (Fugue, the rule Loro and list-positions use), a deleted element keeps its
  place for the anchors into it, and a reset drops what is below it. A
  `splice` op carries the cut ranges and either the anchor of a new run or
  the writer's own run to extend — a keystroke at the end of one's run adds
  no key to the record. The index is resolved inside the mutation queue;
  past the length is `OUT_OF_RANGE`. Mixing kinds is refused as for sets
  (`FIELD_KIND` with `kind: 'list' | 'text'`); a merge lets a register, a
  counter or a set outrank a list, a list a text. Lists and texts cross a
  schema version through `migrate()`, are indexed and queried as the arrays
  and strings they read as, and converge over a mesh in the seeded fuzz.
  A list is movable: `setAt(id, key, index, value)` and `move(id, key,
  from, to)` are a value and a position register per element, so two nodes
  moving one element concurrently leave it once, at the newer move's place,
  and a move concurrent with a removal brings the element back.
  `updateText(id, key, text)` diffs a text field against a whole new string
  inside the mutation queue (Myers, UTF-16 units) and sends one splice per
  hunk — what an editor hands over becomes the edits that merge. A text
  carries rich text: `mark(id, key, start, end, name, value, { expand, many })`,
  `unmark()` and `spans()` — a mark is two anchors, an element and a side
  each, so the same tree rule that places typed text decides whether it takes
  the style (Peritext, Loro); per name the newest mark wins, and a `many`
  mark stacks with every other of its name (comments), removable only by id.
  Browser budget 42 → 51.5 KB.
- **Full-text search.** An entity names its `search: ['title', 'body']`
  fields and `open({ search: createSearch() })` gives the index —
  `@alexify/syncom/search`, a subpath under 1 KB, so a node that never
  searches ships none of it. `select({ $text: 'quick fox', orgId })` is
  fuzzy, typo-tolerant trigram search ranked by TF-IDF over the record's
  length, best first unless ordered, narrowed by any equality, with `limit`,
  `one()`, `count()` and `watch()` as for any cursor; text is normalized
  (marks stripped, lower case). The catalog keeps each record's search text
  (format 3 — an older `catalog.json` is rebuilt once) and replays it into
  the index at open, so no record is read; an index that throws is logged
  (`catalog.search`), never failing the write. A `TextIndex` of your own fits
  too. Browser budget 40 → 41 KB.

- **Signed operations.** Every op a node makes is signed with its Ed25519
  key, and the node id *is* that key — the raw public key in base64url — so a
  peer verifies an op against its `origin` through any relay, with no key
  exchange. The signature covers the header and a salted digest of the
  payload; a purge scrubs the payload and the nonce and leaves a header that
  still verifies. `open({ sync: { signatures: 'verify' | 'require' | false } })`:
  A peer's page is verified sixty-four ops at a time, on Node's thread pool
  (Web Crypto in the browser), so a replica is not held to one check after
  another. `'verify'` (the default) checks a signature when there is one, `'require'`
  refuses unsigned ops and keyless origins too (and a keyless `hello`, 403
  `UNSIGNED`). Refusals are `forged`/`unsigned` in the apply result and the
  `refused` event, `error` events `BAD_SIGNATURE`/`UNSIGNED` once per page,
  `syncom.ops.received{refused}` and `syncom.ops.rejected{forged|unsigned}`.
  New: `generateSigningKeys`, `loadSigningKeys`, `sign`, `verify` on both
  halves (async in the browser), `SigningKeyPair`, `storage.signatures`,
  `keys/sign-public.pem` and `sign-private.pem`, `node.json` rekeyed once
  from a UUID (`identity.rekeyed`) and refused when it names another key
  (`IDENTITY_MISMATCH`), `packOps` slots 15–17 (`sig`, `digest`, `nonce`).
  Browser budget 38 → 40 KB.

- **Observed-remove sets.** A third field kind next to the register and the
  counter: `storage.add(id, field, elements)` and `storage.remove(...)` (and
  `record.add`/`record.remove`) commit `add`/`remove` ops (wire codes `+`/`-`,
  payload in the key/value slots). Two nodes that add concurrently both keep
  theirs; an element one node removes while another re-adds it survives, since
  a remove names the adds its node had seen (`meta.sets[field][element][origin]
  = [added, removed]`); a reset drops and clamps slots so metas agree in any
  order. A set reads sorted by element text. The kind rule gains
  `reason: 'set'` (`FIELD_KIND`, `OP_REFUSED`); a set op is validated as the
  record it leaves; `migrate()` adds sets back and reports `sets`. The catalog
  posts an indexed array under each element, so `{ tags: 'bug' }` narrows to
  the arrays holding it — a covered count and a loaded fetch used to disagree
  on an indexed array. Browser budget 37 → 38 KB.

- **Benchmarks against nine libraries and a comparison with eighteen.**
  `pnpm bench:compare` measures syncom against Yjs, Automerge, Loro, TinyBase,
  PouchDB, RxDB, Fireproof, GUN and OrbitDB (insert, update, read, a converging
  counter, a batch, replicating a store; in memory and on disk; a cold start),
  each pair in a fresh process and checked before it is timed; the libraries
  live in `bench/compare`'s own `package.json`, never in syncom's
  devDependencies. `pnpm bench:size` measures browser bundles, `pnpm bench
  --save` records syncom's own benchmarks, `pnpm bench:report` turns all three
  into the charts of the docs and the README. `docs/comparison.json` (rendered
  by `pnpm docs:comparison`) compares forty features, each cell decided from
  the published source. New pages: Why syncom?, Compared with alternatives,
  Benchmarks, Architecture.

- **`storage.repair(id)`.** A record whose file fails its integrity check
  (`INTEGRITY`) or is torn is rebuilt from this node's log: the retained
  entries of the id replayed from the first whole-record op (`write`,
  `merge`, `delete`, `purge`), written back with a chain block of its own —
  `{ ops, alive }`. `UNRECOVERABLE` when the log holds no such op (compacted
  away, never written here, encrypted). `OpLog.entriesOf(id)` is what it
  reads; `record.repaired` is logged at info.
- **Queries: the first page costs its reads, not its sort.** An ordered
  cursor with a `limit` keeps only the best `offset + limit` rows as the
  candidates go by (a bounded, stable top-k) instead of sorting every match;
  a loaded cursor reads its candidates sixteen at a time, in candidate
  order; the catalog narrows through every `$and` branch and through an
  `$or` whose branches all name an indexed equality; `ids()` is cached
  until the collection changes, `indexed()` is one set per collection.
  Browser budget 36 → 37 KB (36.5 measured), for this, `repair()` and the
  log read together.
- **A scoped feed moves past other scopes' ops.** `OpLog.read(eventId, {
  scopes, limit })` answers `{ entries, last }` — `last` the seq of the last
  entry examined, in scope or not; the host's `changes` feed moves its
  cursor there when a wake brings nothing for the peer, so an op of another
  scope is looked at once, not on every wake (`since()` is `read().entries`).
  The cursor moves to a real entry's position, never to `lastEventId`, which
  runs ahead of the entries while an append is in flight.
- **Benches for the apply path and for replication.** `bench/apply.js`
  (`applyOp`, `packOps`/`unpackOps`, `applyRemote` pages of 100 and 500
  writes, sets and incs, with and without the chain) and `bench/sync.js`
  (a write applied one and two hops away over the memory link, a snapshot
  page, a 2 000-record bootstrap, a scoped feed under another scope's
  appends); the cold-read row of `bench/storage.js` closes the instance it
  opens.
- **`SyncomError`: every operational error carries a `code`.** What syncom
  rejects with when an operation cannot be done — `CLOSED`, `IN_HOOK`,
  `NOT_FOUND`, `FIELD_KIND`, `ENCRYPTED`, `INTEGRITY`, `CORRUPT`,
  `DOWNGRADE`, `LOCKED`, `KEYS_INCOMPLETE`, `BAD_ENVELOPE`, `BLOCK_NOT_FOUND`,
  `NOT_CONTRACT`, `NODE_EXISTS`, `NODE_NOT_FOUND`, `BAD_HELLO`,
  `HANDSHAKE_LOOP`, `PAGE_FAILED`, `STUCK`, `STREAMS_UNSUPPORTED`, `SKEW`,
  `OP_UNREADABLE`, `OP_REFUSED`, `OP_INVALID` — is a `SyncomError` (exported
  from the package root, `SyncomErrorCode` the union) with the fields the
  code documents (`field`/`kind`, `id`, `url`, `hash`, `cursor`/`attempt`,
  `op`…) and `cause`; `HookError` and `ValidationError` are `SyncomError`s.
  A wrong argument stays a `TypeError` without a code (`INVALID_ID`,
  `TYPE_IMMUTABLE` and `NO_CHAIN` keep theirs). A host's wire refusal keeps
  its numeric code and gains `reason` (`HELLO_FIRST`, `BAD_HELLO`,
  `PROTOCOL`, `SELF`, `UNAUTHORIZED`, `SCOPES`, `OPS_PER_PUSH`,
  `BYTES_PER_PUSH`, `OPS_PER_SECOND`), logged in `sync.hello.refused`. No
  message changed; three registry argument errors (`addNode` without a url
  or with bad scopes, `start()` without `connect`) are now `TypeError`s.
  Browser budget 35.5 → 36 KB.
- **`open({ chain: false })`.** A node that only replicates — a hub — keeps
  no hash-linked chain: two file writes less per record (the chain grew by
  one block file per write and was never compacted), reads without the
  block re-check, `validate()` rejecting with `code: 'NO_CHAIN'`.
- **WebRTC, through wrpc 2.** No transport code in syncom: a `PeerLink`'s
  `remote` from `@alexify/wrpc/webrtc` is a `WrpcClient`, which
  `createWrpcLink()` takes as it is, and `storage.sync.unit()` mounts on a
  browser's `PeerHost` as on a server — a browser node hosts. The
  integration suite runs syncom over a raw data channel (a fake pair)
  attached to an `RpcServer` (both directions, a streamed bootstrap, a
  channel factory that reconnects and resumes) and to a `PeerHost`
  (`authorize` on the pseudo-session, 403, the unit's limits). A guide,
  [WebRTC](https://syncomjs.vercel.app/guide/webrtc), with the dial, host,
  signaling, mesh and raw-channel recipes. devDependency `@alexify/wrpc`
  1.0.0 → ^2.0.1.
- **Purge.** `storage.purge(id)` forgets a record for good: a `purge` op
  (the 7th op type, `meta.purged`) that wins over every other op at any
  stamp and that nothing later revives, plus `OpLog.scrub(id)` — every entry
  of the id stripped of its payload in memory and in the files
  (`LogEntry.scrubbed`), position and stamp kept. A peer that receives the
  purge, or anything else about the id afterwards, scrubs its own log the
  same way. A scrub rewrites files in place; a crash mid-way tears one,
  which a resuming peer answers with a bootstrap. Browser budget raised
  27.5 → 28 KB.
- **Hosting limits.** `storage.sync.unit({ limits: { opsPerPush,
  bytesPerPush, opsPerSecond } })` refuses a page over the first two with
  code 413 and a peer over the third (a token bucket per peer) with 429 —
  codes the dialer reports and recovers from at its next handshake, never a
  hang-up; the `syncom.ops.limited` metric counts them. `unit({ meta })` is
  copied onto all four procedures for a wrpc `onRequest` hook to read.
  `isSharedLog()` and the `SharedLog` type reserve the contract of the
  broker-backed hub mode (the shape of wrpc's `BrokerLog`);
  `open({ sync: { sharedLog } })` is refused until that mode exists.
  Browser budget raised 26.5 → 27.5 KB.
- **Who wrote it.** `open({ actor })` — a string, or a function asked per
  write — and a per-write `{ actor }` on `insert`, `set`, `update`, `inc`,
  `delete`, `swap`, `saveData`, `Record.save/inc/delete`, the collection's
  methods and `migrate()` stamp the op with `actor` (the 14th packed slot;
  older readers ignore it). It is a claim, not a signature: it rides on the
  op into every log, `change` and `beforeApply`, never into the record.
  `WriteContext.actor`.
- **Queries.** `collection.select(query)` is a cursor over a Mango-shaped
  query (`{ field: value }`, `$eq` `$ne` `$in` `$nin` `$gt` `$gte` `$lt`
  `$lte` `$exists` `$regex`/`$options`, `$and` `$or` `$not`, dotted paths,
  an array field holding a scalar) with `order`/`desc`, `limit`/`offset`,
  `filter`, `projection`, `fetch`/`count`/`one`, `for await`, and
  `watch(listener)` — run now and after every change to the collection,
  coalesced. A query whose fields are all indexed (and has no filter) is
  answered from the catalog alone; an equality on an indexed field narrows
  the records read. `collection.count(query)`. **Unique keys**: an entity's
  `unique` fields (single or composite) are refused on a local write with
  a `ValidationError` issue `{ code: 'unique', conflict }`; a peer's op
  that leaves two records on one key is applied and reported through the
  `conflict` event `{ kind: 'unique', entity, fields, id, other, op }` and
  the `syncom.conflicts` metric. Browser budget raised 24.5 → 26.5 KB.
- **The record catalog.** Every live record's id, collection and indexed
  field values stay in memory (`src/catalog.js`), kept by every write and
  persisted as `<path>/index/catalog.json` stamped with the log position it
  reflects (every `catalog.flushEvery` changes, default 64, and at close);
  a reopen re-reads only what the log changed since, or rebuilds from one
  scan of `data/` when it cannot say. `list()` and `hasRecord()` answer from
  it with no I/O — `list()` used to be four reads and a hash per record.
  `cache: { max }` bounds the entry cache (default 5000, LRU, a live
  `Record` pins its own; absent ids are no longer cached), and
  `integrity: 'lazy'` skips the chain check on a cold read. Browser budget
  raised 23 → 24.5 KB.
- **One instance per directory.** `open()` holds the directory — Web Locks
  in the browser, `<path>/lock.json` with the pid elsewhere (stale once the
  process is gone, or after 30 minutes without a pid) — and a second
  `open()` of it rejects with `code: 'LOCKED'`; `lock: 'wait'` waits,
  `lock: false` leaves the coordination to the caller. `close()` releases
  it; an `open()` that fails releases it too. Browser budget raised
  22 → 23 KB (with the injected backend).
- `@alexify/syncom/idb` — `createIdbFsi({ name, store, indexedDB })`, the
  backend over IndexedDB for browsers where OPFS is unavailable or unwanted:
  one object store keyed by `[dir, name]` with an index on `dir`, opened
  lazily, reopened after a `versionchange`, closed by its own `close()`.
  `fake-indexeddb` is a devDependency for its tests.
- **The backend is injected.** `open({ fsi })` takes any object with the
  five functions of the contract (`read`, `write`, `exists`, `remove`,
  `list`) and routes the records, the log, the chain, the keys and the
  registry through it; `storage.fsi` is what the storage uses. `isFsi()`,
  `createMemoryFsi()` (a backend in memory, for tests, SSR and benchmarks —
  two storages opened over one share it), and `open({ durable: true })`:
  every write followed by the backend's `sync` (fsync on `node:fs`; a
  backend without one logs at debug). `loadKeys`, `Blockchain` and `OpLog`
  take `{ fsi }` too.
- **Reading across schema versions.** A record of an older version is read
  through a lens: `schema.migrations` (keyed by the version migrated to,
  storage-wide or per entity, `up(data, { entity, id, from, to })`), then
  the entity's Standard Schema validator (aliases and defaults — a metaschema
  model reads a renamed field with no migration written); `schema.lens`
  picks the steps. `get()`, `Record` and `swap()` read the view, `update()`
  validates and folds through it; `snapshot()`, `getCachedData()` and
  replication stay raw. `storage.migrate({ entities?, batch? })` rewrites
  the old records as whole-record writes of their view with the counters
  added back — idempotent, one node runs it. `schema.ahead`: `'apply'`
  (default) applies an op from a newer version as it is and emits `schema`
  `{ kind: 'ahead', op, held: false }`; `'hold'` keeps it in the log
  (`LogEntry.held`, `OpLog.held()`, `droppedHeld`) until an open runs that
  version, reported as `schemaInfo.held = { replayed, lost }`. Browser
  budget raised 20.5 → 22 KB.
- **Schema versions on the wire.** `open({ schema: { version, snapshot } })`:
  the version (a positive integer, 1 by default) is stamped on every op this
  node makes as `v` (the 13th slot of the packed shape; older readers ignore
  it), and a record remembers the version of its last whole-record write as
  `meta.v` (a `set` that creates the entry takes its op's; a merge takes the
  higher). `snapshot` is any JSON describing the schema (metaschema's
  `model.toJSON()`), hashed and kept in `<path>/schema.json`
  `{ version, migrated, hash }`; `storage.schemaInfo` is `{ version, hash,
  previous }`, `previous` being what the file held before this open when
  that differed (an upgrade to migrate after, a snapshot change, a logged
  downgrade). `hello` carries `schema: { version, hash } | null` both ways:
  `authorize(context, hello)` sees it, `listNodes()[0].remote.schema` keeps
  it, the `peer` and `hello` events carry it, and the same version with
  another hash is reported on both sides as the storage's `schema` event
  `{ kind: 'drift', peer, version, hash, local }` plus a warning — never
  refused. `WriteContext.v`.
- **Schema validation, injected.** An entity definition
  (`open({ schema: { entities: { Project: { schema, idField, validate, index, unique, fields } } } })`)
  may carry a validator of any of three shapes, none of them a dependency: a
  Standard Schema (`~standard` — an entity of a metaschema `Model`, zod,
  valibot, arktype), a compiled function (ajv), or a plain object compiled
  through `open({ validator })` (JSON Schema, TypeBox; an Ajv instance fits).
  Every write to the collection is validated as the whole record it leaves,
  after the op is applied and before anything is logged; what the validator
  returns (defaults, aliases, stripped keys) is what is written and
  replicated, a `set` keeping only its own keys. A failed write rejects with
  `ValidationError` (`code: 'VALIDATION_FAILED'`, `entity`, `issues`,
  `cause`). A peer's op the schema refuses is skipped like a `beforeApply`
  `false` and reported through the `error` event (`entity`, `issues`). The id
  is handed to the validator under `idField` — `id`, metaschema's
  `<entityName>Id`, or none — and dropped from its output; `validate: false`
  reads a definition-only schema. `storage.check(entity, data)`,
  `Collection.set()`, `$type` immutable on the local write path, `index` /
  `unique` (explicit or off a metaschema schema) checked at open.
  `@alexify/metaschema` is a devDependency for one skip-guarded integration
  test. Browser budget raised 18 → 20 KB.
- **Hooks.** `open({ hooks })` — `beforeWrite` (sees the op being made and
  the record it lands on; may replace the data of a write or a set; a throw
  refuses the write), `afterWrite` (the durable op), `beforeRead` /
  `afterRead` (refuse or redact what `get()` returns — `swap`, `snapshot` and
  the cache stay raw), `beforeApply` (per remote op; `false` skips it here
  while it is still logged and relayed, a throw aborts the batch before
  anything is durable), `afterApply`. `open({ sync: { hooks } })` —
  `beforeConnect` (`false` leaves a node registered but not dialled) and
  `beforeBootstrap` (`false` refuses to join a peer's whole state). Hooks run
  inside the operation; a throw rejects it with `HookError` (`code:
  'HOOK_FAILED'`, `hook`, `cause`). A write issued from a hook is refused
  rather than left to deadlock the queue. `applyRemote` reports `skipped`
  and takes a `peer` descriptor. Browser budget raised 17 → 18 KB.
- **Events are contained.** Every event now goes out through one path:
  listeners are invoked at once, never awaited, and a throwing listener is
  logged at debug instead of failing the write it observed (or, for the
  fire-and-forget emits in `Record` and `SyncManager`, becoming an unhandled
  rejection). A `change` listener that writes back queues behind the write.
  New events: `apply` and `close` on the storage; `start`, `stop`, `node`,
  `connect` and (hosting side) `hello` on the manager. Typed event maps
  (`StorageEvents`, `SyncEvents`, `RecordEvents`) and the `SyncManager`
  members the types were missing (`started`, `enableNode`, `sync`, `peers`,
  `unit`).
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

### Security

- **Scopes bound what a peer writes, not only what it declares.** An
  `update()` took the scope of its delta, so with a field-based `sync.scope`
  (`data.$type`, as the docs show) it was minted global and reached every
  peer; an op now takes the scope of the record as it leaves it, read after
  validation. And a host took the scope an op declared on trust, so a peer
  granted `Other` could overwrite a `Doc` record by sending an op with no
  scope: a host's `push` now passes the grant to `applyRemote` as `bound`,
  and an op whose record is outside it — before or after the op, as the host
  scopes it — is refused (`outOfScope` in the answer and the apply result,
  `refused` with `reason: 'scope'`). Found while comparing with RxDB.

- **Record ids are checked at every entrance.** An id is
  `[A-Za-z0-9_@-][A-Za-z0-9._@-]{0,127}`: the local writers reject anything
  else with `TypeError` `code: 'INVALID_ID'` (naming `getId` when it minted
  the id), a peer's op with another id is `malformed`, a snapshot record is
  skipped. Before, an id became `data/${id}.json` as given — `../x` wrote
  outside the storage on `node:fs`, and an id with `/` left an op in the log
  that no reopen could replay.
- **A peer's op is `wellFormed` before anything reads it** — `origin`, `seq`,
  `ts`, `type`, `scope`, `v` and the id — and a stamp more
  than `sync.maxSkew` (default 24 hours, `Infinity` to disable) ahead of the
  node's clock is refused with an `error` event `code: 'SKEW'` instead of
  being observed into the clock. Before, one op stamped far in the future
  (or with a string `ts`) silently froze every later local write to the
  field, on every node that saw it, across restarts.
- **`mergeEntry`/`normalizeMeta` walk own keys only.** A `merge` op (or a
  snapshot record) whose metadata carried a `__proto__` or `constructor`
  counter polluted `Object.prototype` / `Object` on the receiving node;
  non-finite counter sums leaked into records. Peer metadata is now rebuilt
  into the trusted shape — stamps as `[ts, origin]`, counts as
  `[seq, sum, ts]` — and fields named `constructor`/`toString` are ordinary
  fields rather than silently dropped.
- **Scopes are a boundary on the host.** `push` refuses ops outside the
  scopes `hello` granted (counted as `outOfScope`, announced as `refused`,
  metric reason `scope`); `snapshot` and `changes` serve the intersection of
  what is asked and what was granted (403 when nothing is). Before, the
  scopes only selected what a peer was *sent*.
- **An `advance` moves the vector only from the feed host's own ops.**
  Pushed or relayed, it is logged and passed on but adopts nothing
  (`applyRemote({ adoptFrom })`). Before, any peer could mark another
  origin's future ops as already seen.
- **`validate(id, data, block)` checks the block's own hash**, so a file
  planted beside the chain with the right `records` map no longer passes.
- **`loadKeys` refuses half a key pair** (`code: 'KEYS_INCOMPLETE'`) instead
  of minting a new one that orphans every sealed record; `private.pem` is
  written `0o600` where the backend has permissions (`fsi.write`'s optional
  `{ mode }` hint).
- A `Record` field named like a member of the class (`save`, `delete`, `data`,
  `on`) no longer shadows the method (`record.shadowed` is logged once).

### Fixed

- **A snapshot that carries a purge scrubs the joiner's log.** A node that
  held a record's ops and then bootstrapped from a peer where the record was
  purged kept the payloads in its log and served them to the peers behind
  it. The bootstrap merge now scrubs every id the page purges, as a peer's
  page does.
- **An op on a sealed record is skipped, not accepted.** A peer's op on a
  record this node keeps `encrypted` was logged as applied, so a replay or
  a fold of the log would have applied what the node never did; it is
  flagged `skipped` now. Also: `ahead: 'hold'` accepts `retention.ops: 0`
  (keep everything), and `repair(id)` counts a held op this node has since
  applied.
- **Offline writes past retention reach the host.** A node that wrote more
  ops than `retention.ops` before reaching a host had the oldest compacted,
  and the host took none of them — nor any later one of that stream —
  without a word. A node that dials now keeps its own ops until every
  enabled registered node holds them (`listNodes()` shows `acked`,
  `OpLog.retain(keep)` is the hook), and a host that lacks ones the log no
  longer holds is reported once per hello as `UNDELIVERABLE`.
- **A restored directory no longer forks its node in silence.** A node
  restored from an older copy minted again seqs its peers already held, and
  they dropped its new writes as duplicates. At hello it now reports
  `REWOUND`, moves its streams past what the host holds, and bootstraps from
  the host to get back what the lost ops wrote.
- **Logged is committed.** A record file (or chain block) that failed after
  the log append rejected the write while its op stayed logged and
  replicated, and the writer read the record as missing until a reopen. The
  write now stands: the entry is held in memory, the batch is replayed onto
  the files at the next open, and the storage reports `UNPERSISTED`. A
  peer's batch is held the same way.
- **A torn record file is `INTEGRITY`**, not a bare `SyntaxError` from
  `get()`/`has()`; `repair(id)` rebuilds it.
- **A collection answers for its own records.** `collection.get(id)`
  returned a record of another collection, and `update`, `delete` and
  `record` acted on one; `get` is `null` there now, the others reject with
  `NOT_FOUND`. An entity named like a storage member (`get`, `close`, `log`…)
  replaced it, or broke `open()` with a bare `TypeError`; it is refused at
  `open()`.
- **`cursor.one()` leaves the cursor as it was** instead of a `limit(1)` the
  next `fetch()` kept.
- **Indexed objects match whatever their key order.** `$eq`/`$in` through
  an index, and unique keys, compared JSON text; they compare canonical keys
  now, as the predicate does.
- **`merge()` and `diff()` walk own keys and never take `__proto__`** as a
  field (a JSON-parsed delta set the result's prototype).
- **`import { open } from '@alexify/syncom'` works in Node.js ESM.** The root
  re-exported through spreads of locals, which Node's CommonJS lexer cannot
  read; both barrels spell their exports out.
- **Docs that disagreed with the code:** failing listeners and watch runs
  log at `warn`, not `debug`; an op that skips ahead is dropped as a gap, not
  set aside; there is no read-only open for a second tab; a host relays an
  op its validator or `beforeApply` skipped; a nested object is one
  register; the event tables list `log`, `refused` and every `error` code.

- **The debt that had no decision attached.** The `Emitter`, the logger
  and `loadKeys` lived twice (once per platform half); they are
  `src/emitter.js`, `src/logger.js` and `src/keys.js` now, shared, and
  "in scope" is defined once in `src/scope.js`. The directory lock uses an
  exclusive create where the backend has one (`fsi.create`, on `node:fs`
  and the memory backend), so openers racing for a free lock lose
  deterministically; `open({ lock })` takes an object (`mode`, `staleAfter`,
  `poll`, `timeout` — a `'wait'` that gives up). `open({ maxListeners })`
  tunes the listener cap, a hundred by default (ten threw at the eleventh
  `change` listener). `$regex` is capped at 1000 characters and
  `projection(['__proto__'])` refused. A torn registry file is reported and
  skipped at open; a torn `node.json`, `schema.json` or `.blockchain.json`
  rejects with `code: 'CORRUPT'` and the file's name. The OPFS backend keeps
  its directory handles, the browser crypto its imported keys; the log's
  `latestTs` rides in the index, its open builds the dedup set once.
  `examples/` is linted and closes its
  storage; the wrpc integration test skips only on `MODULE_NOT_FOUND`.
  Removed: `between`, `vectorDominates` (no callers).
- **Docs, types and comments that had drifted from the code.** The API
  reference named two subpaths (there are three; `createIdbFsi` now has a
  line), `migrate()` without its `actor`, `fetch()` returning ids (rows),
  `schemaInfo` without `held`, `remote` without `schema`, the write hooks
  without `purge`; `storage.logger`, `OpLog.latestTs` and the `Collection`
  and `Record` constructor types existed at runtime but not in `index.d.ts`;
  the package consistency test now checks the subpaths' exports against
  their types too. Comments that said the opposite of the code are fixed
  (`packOps` is the wire shape, not the log's; a streamed snapshot page is
  collected whole; a torn open log file is dropped, not bootstrapped; the
  mesh helper waits three polls).
- **What an operator could not read at runtime.** `storage.stats()` (queue,
  cache, catalog, log, chain, lock — from memory), `peers()[i].lastError`,
  `sync.hosted()` (every live `changes` feed on a host) and a `log` event
  when the log seals a segment (`floor` is where a resume still works).
  `via` on `change`, `apply` and the apply hooks is `{ url, node }` of the
  peer, on both sides; before, the dialing side handed out its internal
  peer object — with the registered token on it.
- **What an operator could not see.** Spans for a served snapshot page
  (`syncom.snapshot`), a scrub (`syncom.log.scrub`) and a catalog rebuild
  (`syncom.catalog.rebuild`); histograms for hook durations
  (`syncom.hook.duration{syncom.hook}`) and the lock wait at open
  (`syncom.lock.wait`); a counter for calls a hosted unit refused before the
  handler (`syncom.hello.refused{syncom.code}`); observable gauges for the
  outbox, the mutation queue, the cache, the catalog and the log; `skipped`
  as its own outcome of `syncom.ops.received` (it hid inside `applied`).
  `includeIdentity: false` now also keeps the scope and the exception text
  off a span. A log that changed epoch says so (`log.epoch.new`, a warning
  when a log was there); an event listener or a `watch()` that throws is
  logged at warn, not debug; the OPFS backend swallows only "not there"
  from `exists()`/`remove()` and lets a denied or broken storage surface.
  The log events are documented as a surface in the telemetry guide.
- **Every record inserted through a collection stayed in memory for good.**
  `Collection.insert()` returned a `Record`, and the storage kept every
  `Record` ever made, which also exempted its cache entry from eviction —
  the "bounded" cache was unbounded for collection users. Live Records are
  now held weakly: one the application still references pins its entry and
  follows the record; one it dropped is collected, and the pin with it.
- **A bootstrap paid a full commit per record.** Every snapshot record went
  through `[COMMIT]` on its own: a log append, a chain block, a tail-pointer
  rewrite and a record write each, and one log entry per record towards
  `retention.ops`. A page is now joined as one batch under one turn of the
  queue — one append, one block, one catalog flush — with the same hooks,
  events and `merge` ops as before. A record the dialer keeps sealed no
  longer fails the page; it is left alone and logged.
- **`snapshot()` listed the data directory on every page** and loaded every
  entry to decide what to send — O(N) per page, O(N²/limit) per bootstrap,
  and a decrypt per sealed record just to skip it. The catalog now keeps a
  row for every entry with a file, tombstones included (`gone`), and a page
  is a slice of its sorted ids; a record this node cannot read is left out
  of the page instead of failing it. The persisted catalog is format 2 (an
  older file is rebuilt once).
- **The catalog was written on the mutation queue.** Every 64th write paid
  for a full serialization of the catalog before it returned; the save now
  runs off the queue (the rows and the stamp taken as it starts, one save in
  flight at a time, `close()` waits for it).
- `node:fs` writes no longer `mkdir -p` on every call (once per directory;
  a directory removed behind the storage's back is made again); a local
  write mints its seq without copying the whole vector (`OpLog.seqOf`); a
  scrub finds an id's entries through an index instead of a walk over the
  retained log.
- **A failed relay left the peer behind until the link reconnected.** A 429
  or 413 (or any failed push) dropped the outbox and nothing re-pushed until
  the next handshake, which on a stable link never came: silent divergence
  until a manual `sync()`. The peer is now marked `behind`
  (`peers()[i].behind`), queues nothing more, and is caught up from the
  vector — what a handshake does — at the next sign of life on the link (a
  page received, an op to relay) or on `sync()`, backed off by timestamp
  (1 s doubling to a minute) after a failed recovery.
- **Pushes to one peer could overlap.** The handshake push and `sync()`
  bypassed the relay's single flight, so two pushes could carry one op and
  the vector answer was last-writer-wins. Every push now runs on one chain
  per peer (`peers()[i].pending` counts the one in flight).
- **The outbox was unbounded.** `sync.maxOutbox` (default 10 000) drops the
  backlog beyond it, logs `sync.outbox.dropped` and marks the peer behind.
- **A page from the host taught the dialer nothing.** The host's vector was
  known from hello and push answers only, so ops that came down the feed
  could be offered straight back. Every op a page delivers now advances the
  known vector; a push answers with the keys the page touched (merged, not
  replaced) and a snapshot carries the vector on its first page only.
- **A host that kept answering 428 was greeted forever.** Five fresh hellos
  in a row refused with 428 end in one `error` `code: 'HANDSHAKE_LOOP'`.
- A repeated hello no longer refills the peer's rate bucket; `bytesPerPush`
  counts UTF-8 bytes rather than UTF-16 units; a feed page carrying only the
  dialer's own echoes moves the cursor without an `applyRemote` or a
  registry write; `close()` refuses writes from the moment it is called.
- **A roll could seal an op before its record was written.** `OpLog.append`
  rolled after writing the new batch, sealing it out of the tail a reopen
  replays — a crash between the log append and the record write left an op
  in the log and the vector that no replay ever applied. The storage now
  opens its log with `sealApplied` and marks each batch `applied` once its
  records are written; a roll stops short of the oldest batch still pending,
  so a crash, or a record write that failed while later writes went through,
  is replayed at the next open. `close()` seals what is applied, so a clean
  reopen replays nothing.
- **A page the dialer could not apply was stepped over.** A `beforeApply`
  that threw, or a record file this node could not read, failed the page and
  the next page moved the cursor past it: its ops were lost to this node for
  good, reported only as `gaps`. Pages now run one after another per peer, a
  failed page closes the subscription and reopens it from the last saved
  cursor (`error` `code: 'PAGE_FAILED'`, with `cursor` and `attempt`), and
  the third failure in a row leaves the peer `stuck` (`code: 'STUCK'`,
  `peers()[i].stuck`) rather than silently behind. `gaps > 0` on a page is
  logged (`sync.gaps`).
- **A record this node cannot read no longer poisons a page.** An op on a
  record whose file is torn or fails its integrity check is skipped like a
  `beforeApply` `false` — logged, relayed, replay-safe — and reported
  (`error` `code: 'OP_UNREADABLE'`, metric reason `unreadable`); before, the
  whole push failed and a host's dialer offered the same page at every hello.
- **`swap()` compared outside the mutation queue**, so two concurrent swaps
  on one expectation could both pass; the comparison now runs inside the
  queue (`expect` on the commit), against the record as it reads.
- **Data was shared by reference across the boundary.** `get()` returned the
  cached object, `set()`/`update()` kept the caller's; editing either changed
  the cache, the in-memory log entry (later written to disk by a roll or a
  scrub) and the base of the next write, without an op. Everything now
  crosses as a JSON copy — `get()`, a cursor's rows, the write payloads.
  `getCachedData()` and `snapshot()` stay raw.
- **A pending read hook blocked every write.** The guard against writes from
  inside a hook counted `beforeRead`/`afterRead` too, so any `set()` that ran
  while a read hook was in flight was refused. Read hooks run outside the
  queue; a write from one simply queues.
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

### Changed

- **Comparison: Jazz at 2.0.** The Jazz column described 0.20 (Jazz Classic);
  it now describes 2.0.0-alpha.59, the version jazz.tools documents — a
  server-merged relational database with queries, lenses, row policies and
  queryable history, and without CoValues, per-change signatures, list or
  text CRDTs or a purge. The method gains the rule for a project whose npm
  `latest` is legacy, and the prose counts follow.

- **Browser budget 41 → 42 KB.** The fixes above — scopes checked on the
  record, own ops kept until delivered, `REWOUND`/`UNDELIVERABLE`,
  `UNPERSISTED`, scoped collections, canonical index keys — add about 1.2 KB
  min+gzip; the browser entry is 41.9 KB.

- **A write no longer costs more as the store grows.** The record catalog is a
  whole file, and it was saved every `catalog.flushEvery` (64) puts whatever
  its size, so every write paid for a sixty-fourth of every row: inserts into
  20,000 records in memory ran at a third of the speed of inserts into 1,000,
  and the save was half of the CPU. `flushEvery` is now the floor: a catalog
  is saved every sixteenth of its size as it grows, never more than half the
  log's `retention.ops` apart (so a node stopped without `close()` still
  catches up from the log rather than rebuilding from a scan). Inserts in
  memory hold their speed at 40,000 records; `OpLog.retainedOps` says what
  the log keeps.

- **The engine is modules, not one class.** `src/storage.js` (1 900 lines)
  is now the facade — the open sequence, the mutation queue, the public API
  — and lends a `core` to its three write paths: `src/commit.js` (a local
  op: prepare, validate, persist, announce), `src/apply.js` (a peer's batch:
  admit, apply, persist, announce) and `src/bootstrap.js` (snapshot pages,
  merge pages, `adoptVector`). Record files, the cache and the catalog rows
  live in `src/entries.js` (`EntryStore`); `Reference`/`Record`/`Collection`
  in `src/record.js`; `open()`'s option checks in `src/options.js`; the
  entrance checks (ids, stream names, a peer's op shape) in `src/shape.js`;
  the hosting side of replication in `src/hosting.js` (`createUnit`), with
  `src/protocol.js` for what both halves share. No public name, error
  message, event, hook signature or on-disk format changed; every function
  in the engine is now under 60 lines. The browser budget was raised
  33.5 → 35.5 KB: a class's private names minify to one letter, the property
  names of a seam shared between modules do not (+2.3 KB min+gzip).

### Changed (breaking)

- A record id is `[A-Za-z0-9_@-][A-Za-z0-9._@-]{0,127}`; every writer rejects
  anything else (`code: 'INVALID_ID'`), `get()`/`has()` answer absent, and a
  peer's op or snapshot record with another id is dropped as `malformed`.
- `applyRemote()` answers `{ applied, skipped, duplicates, gaps, malformed,
  unsigned, forged }` (the `sync` and `apply` events carry the new counts too), and takes
  `adoptFrom`: an `advance` is adopted only when its origin is that node.
- `storage.on('error')` payloads carry `code` — `OP_REFUSED`, `OP_INVALID`,
  `SKEW`.
- `open({ sync: { maxSkew } })` (default 24 hours) bounds how far ahead of the
  node's clock a peer's stamp may be.
- A hosted unit refuses `push` ops outside the peer's hello scopes (answer
  field `outOfScope`, `refused` event) and serves `snapshot`/`changes` for the
  granted scopes only (403 when none of the asked ones is).
- `loadKeys` rejects with `code: 'KEYS_INCOMPLETE'` when exactly one of
  `public.pem`/`private.pem` exists; before, it generated a new pair.
- `fsi.write(dir, name, content, options?)` takes an optional `{ mode }` hint;
  `withSync` forwards it. Adapters without permissions ignore it.

- **`open()` is exclusive by default.** A second instance over the same
  directory used to open silently and mint the seqs of the first; it now
  rejects with `code: 'LOCKED'` unless `lock: 'wait'` or `lock: false`.
- **Smart contracts moved to `@alexify/syncom/contracts`.** `SmartContract`
  and `DataReader` (and their types) are no longer on the package root:
  `SmartContract.load` runs code from the chain, and a process that never
  imports the subpath — a hub — never does.
- An entity definition is `{ schema?, idField?, validate?, index?, unique?,
  fields?, search? }` and any other key is a `TypeError` at `open()`; a legacy field
  map (`Post: { title: 'string' }`) goes under `fields`. A `schema` with a
  key other than `version` and `entities`, and a `getId` that is not a
  function, are refused at `open()` too (the latter used to be ignored).
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
