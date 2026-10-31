# Changelog

All notable changes to **`@alexify/syncom`** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

This package has not been published to npm yet, and will not be until it does
what it is meant to. `package.json` carries `0.0.1`, a development placeholder,
not the version of the first release — that is chosen when the release is cut.
There is no released version section until then; everything below lands in it.

**Upgrading a checkout from before the performance branch** (nothing is published, so no
reader of the older shapes was kept): a log directory written before it does not read — its
files have no per-line checksum, so each is told `checksum` and kept under `log/corrupt/`, its
unsealed tail is not replayed, and the node begins a new epoch; a node built from `main` refuses
this branch's ops as `malformed` (the short own references of a splice, a cut or a mark) with no
refusal at `hello`, since `PROTOCOL` stays 1 until the first publication. Keystrokes made at once
or typed through a transaction or a handle that continue each other are one op, so one `change`
and one `commit` event, not one per call.

### Added

- **A synchronous editor's handle on a text: `storage.openText(id, key, { window, actor, source })`**
  (the `text` plugin's). `insert`, `insertEmbed`, `delete`, `format` and `applyDelta` edit at once
  over the handle's reading — the field as announced, its edits on top — and `toString()`,
  `length`, `slice()` and `spans()` read it; `observe()` hears every other writer's change as a
  delta in the handle's indices. The edits are logged a window later (the storage's `defer`) as
  one transaction, keystrokes that continue each other as one op; a flush that cannot be logged
  rejects `flushed` with the new `UNLOGGED` and drops what was not logged — its edits, the flushes
  taken behind it and what was typed since — and the storage logs `handle.unlogged`; a step that
  fails after the append (an `afterWrite` hook) leaves the edits logged. The storage's `flush()`,
  `tag()` and `close()` flush every open handle, one that cannot be logged stopping none of the
  others, as do `compact()`, `restore()` and `applyPatches()` of the record. Handles follow the
  storage's turns through one listener (as many handles as the application opens), and a field's
  run reservations go with its last handle. A hook sees a handle's edit resolved (`ctx.resolved`,
  `content`, `current`); `applyDelta` is checked whole before anything is made; keystrokes typed on
  are one change as they are one op; a handle on a deleted record reads empty (an edit writes it
  again, as the storage's would) and one on a purged record refuses an edit as `NOT_FOUND`;
  `repair(id)` resets the handles on the record. Several writers of one node over
  one text — handles and the storage — never grow one run from two readings.
- **Keystrokes fold into one op.** Sent without waiting (made at once, outside the queue), typed
  through a transaction or through a handle, keystrokes that continue each other — typed on at
  the end of their run, or a chain of cuts — are logged as one op; a signing node folds those of a
  transaction too. A handle folds a word typed backward as well (each keystroke right before the
  one typed last, 256 characters an op): typing at the start of a text through a handle, 60 000
  keystrokes are 236 ops, not 60 000, and 135 000 keystrokes a second, not 48 000.
- **`bench/compare` measures a text typed through a handle** (`syncom-edit`), and `bench/write.js`
  the layers of one write (`--detail`, `--profile`, another checkout under `SYNCOM_BENCH_ROOT`).

- **What the write path does is measured.** `stats()` adds `commits: { fast, queued, coalesced }` — the
  local writes made at once, through the queue, and folded into the write before them — and
  `handles: { open, pending, extents }` for the text handles. `syncom.commits` carries
  `syncom.path` (`queue` / `fast`) and the result `coalesced`; `syncom.handle.flushes` counts a
  handle's flushes by result (`ok` / `unlogged` / `error`); the writer contract gains
  `recordHandleFlush`. Telemetry no longer turns the fast path off: a write made at once is
  counted and timed, never spanned. `stats().log.corrupt` counts every log file that did not read
  whole at open, a segment cut short as much as a checksum that did not match, and a journal's
  last line altered is corrupt, not torn.
- **What the log and the deferred window do is measured.** New metrics:
  `syncom.log.group.ops` (ops per group the log wrote),
  `syncom.log.append.failures`, `syncom.defer.flush.duration`, and the gauges
  `syncom.inflight`, `syncom.deferred`, `syncom.held`; a group that cannot
  be written logs `log.append.failed`. `stats()` adds `plugins`, `defer: {
  window, flushCost, positions }`, `observers`, and in `log` the open and
  unapplied groups, the torn lines and lost entries of the open, and the
  failed appends. The writer contract gains `recordAppendFailure` and
  `recordFlush`, and `recordAppend` the group's size.
- **What an editor adapter shares: `createFit`, `undoSteps`,
  `failureReporter`** (`@alexify/syncom/editor`). The fit — what an
  editor's document differs from the field by, held for its next edit, and
  the index maps across it —, the undo commands that wait for the binding's
  edits, and the failure report were written twice, in the ProseMirror and
  the CodeMirror adapter; both use these now, and an adapter of another
  editor can.
- **ProseMirror and CodeMirror: `indexOf(pos)` and `posOf(index)`.** A
  position of the attached editor's document as an index of the field and
  back, through what the field lacks of the document until the editor's
  next edit sends it — for code that speaks to the storage directly.
  ProseMirror's `indexOfPos` and `posOfIndex` stay the document's own.
- **The log appends to a journal.** A backend may offer `append(dir, name,
  content)`; `node:fs` does (through a few descriptors it holds open, the
  least recently used closed first), and so do `memory()`, `layered()`
  over layers that all have it, and `durable` (an append followed by
  `sync`). Over it the log writes each group of ops as one line of a
  journal, `log/open/<seq>-<token>.jsonl`, begun again at every roll and
  removed once the roll has sealed its groups, instead of a file per group
  made and later unlinked. A torn last line is left out at open
  (`log.open.torn`); a line inside that does not read is lost and counted
  like an unreadable segment; the files are read newest first, so a group
  whose append failed after its line landed is shadowed by the group that
  took its seqs. OPFS, IndexedDB and `atRest` (a file is one ciphertext)
  write a file per group as before. With the window fix under Fixed, on
  disk the pure build inserts about 5,500 records a second (from 2,900), updates and increments about 20,000
  (from 3,400), and types 21,000 characters a second at the end of a text
  (from 4,900) and 8,500 to 9,000 elsewhere (from 1,100 to 1,900).
- **Benchmarks by build, and a durable line.** The cross-library comparison
  measures syncom as two builds — the pure CRDT (the core with `text` and
  `sync`, no signatures, no chain, `defer: 16`) and `@alexify/syncom/all`,
  signed and chained — in place of the chain-on and chain-off rows; typing
  into a text now runs on disk too, every keystroke awaited until each
  library reports it stored (y-leveldb, Loro's appended updates,
  automerge-repo's flush, syncom's log append); and the bundle sizes count
  the core, the core with `text`, and `/all`, resolving the subpaths through
  the package's `exports`. The matrices are decided again from this code:
  in the CRDT comparison syncom now has nested fields, children of list
  elements and tree nodes, embeds, blocks, deltas, events by path, editor
  and UI bindings, transactions, origins and messages, presence, scoped
  undo with cursors, version comparison, forks at any version, blame,
  `unset`, surrogate checks, typed records, a wire spec, checksums and
  anonymized dumps.
- **CodeMirror.** `@alexify/syncom/codemirror`: `createCodeMirror(storage,
  id, path, { state, view })` — CodeMirror's own modules, injected — gives
  an extension for the editor's state and `attach(view)`. An edit's
  ChangeSet leaves as a delta of exact splices; a peer's delta lands as a
  ChangeSet, so the selection maps through it; what CodeMirror makes of the
  text otherwise (`\r\n` read as a line break) is held and goes out with the
  editor's next edit, so the field comes to hold what the editor shows and
  opening an editor writes nothing. `cursors(presence)` and
  `commands(manager)` as for ProseMirror; `keys` for `keymap.of()`.
  CodeMirror is an optional peer dependency (types only).
- **ProseMirror.** `@alexify/syncom/prosemirror`: `createProseMirror(storage,
  id, path, { model, state, transform, view })` — ProseMirror's own modules,
  injected — gives a plugin for the editor's state and `attach(view)`. The
  document is one text with a block marker per block-level node in
  document order (a container, a textblock, a leaf; `parents` the
  containers it sits in), so lists, items and quotes round-trip;
  `docToSpans`/`spansToDoc` and `indexOfPos`/`posOfIndex` are exported. An
  edit leaves as the delta between the documents, a peer's lands as one
  replace step with the selection carried by text index; what the schema
  cannot hold is left out and sent as an edit, so the field comes to fit
  the schema. `cursorPlugin(presence)` shows a room's cursors as
  decorations and publishes this editor's selection; `commands(manager)`
  are undo and redo over the storage's undo stack. ProseMirror is an
  optional peer dependency (types only).
- **Framework stores.** `@alexify/syncom/store`: `toStore(source)` makes a
  query cursor (its rows), a live `Record` (its data), a presence (its
  states) or a storage and a record id (the record as `get()` reads it, or
  one field by path) one store object — `subscribe(run)` with Svelte's
  contract, `getSnapshot()` stable for React's `useSyncExternalStore`, the
  source watched from the first subscriber to the last; `fromEvents(emitter,
  events, read)` for anything else. No framework is imported;
  docs/guide/frameworks.md has React, Svelte, Vue and Solid.
- **Editor binding.** `@alexify/syncom/editor`: `createTextBinding(storage,
  id, path, adapter)` keeps an editor's document and a text field the same
  through deltas — the editor's edits reach the field as one transaction
  each, a peer's reach the editor rebased over what it holds beyond the
  field — with a shadow of the field, one delta in flight at a time and
  `applyDelta`'s new `expect`: a delta the field moved under is refused as
  `STALE` before any op and sent again rebased. `compose`, `transform`,
  `transformIndex`, `applyToText` over Quill-form deltas; `spansToDelta`,
  `deltaToSpans`, `spansToBlocks`, `blocksToSpans`; `diffSpans`/`diffBlocks`,
  the delta between two readings, markers and marks included;
  `selectionToTokens`/`tokensToSelection`, a selection as cursor tokens;
  `presenceCursors`, a room's cursors resolved to indices. A plugin method
  that transacts, called inside a transaction, now runs within it.
- **A text insert's change carries its marks.** A `splice` change of a text
  now has `marks` — the marks its content reads with, one it landed inside
  or one that grew over it — and `toDelta` puts them on the insert as
  attributes, so a delta composed over the reading before gives the reading
  after, rich, not only the string. `applyDelta` sets an insert's attributes
  exactly: a mark that would have grown over typed text is taken off it.

- **Wire format reference.** `docs/reference/wire.md`: the op and its
  eighteen slots, every type's code and payload, what a signature covers
  (the header array, the salted digest), the log files and their checksums,
  the record file and its `meta`, the chain block, the four procedures with
  their arguments, answers and refusal codes, the presence event, the
  bounds a node holds a peer to, and the compatibility policy — every
  example run against the package.
- **Typed records.** A collection's records are typed by the schema: from the
  entity's Standard Schema (`~standard.types` — zod, valibot, arktype:
  `SchemaOutput<S>` is what a record reads as, `SchemaInput<S>` what a write
  takes) or from a `Schema<{ Post: Post }>` annotation (`Shapes`, a phantom
  the types alone read). `SyncomCollection<R, I>`: `get` is `R | null`,
  `insert`/`set` take `I`, `update` a `Partial<I>` plus any field by path,
  `select`/`count` a `MangoQuery<R>` that names the record's fields, `id` or a
  dotted path, a cursor of `QueryRow<R>`; `SyncomRecord<R>` has a property
  per field, `data()` as `R | null`, `delta()` as `Partial<R>`. The storage's
  own readers take the type — `get<R>`, `record<R>`, `getCachedData<R>`, a
  tag view's `get<R>`/`collection<R>`, a transaction's `get<R>` — or infer it
  from the annotation; `RecordData` (`Record<string, unknown>`) wherever the
  schema says no more. `insert`, `set` and `update` take `object`.
  [TypeScript](https://syncomjs.vercel.app/guide/typescript) is the page.
- **Devtools.** `@alexify/syncom/inspect`: `inspect(storage, id)` lays a
  record out raw — the data in the op model's terms and the composed
  reading, the reset stamps, every field with its kind, whether the reading
  shows it and the kind's counts and stamps, the record's retained log
  entries — and `anonymize(value, { salt, keys })` copies anything JSON
  with every string hashed out, the shape kept, for a bug report.
- **A fork at any version; who wrote what.** `branch(parent, { from: { at } })`
  forks at an event id, a stamp or a vector, through the new
  `storage.atVersion(at)` — every record folded to the version, its vector,
  pages to join; `HISTORY_GONE` when the log no longer gives it exactly.
  `lastEditorOf(id, field)` and `editorsOf(id)` read a record's writers from
  its metadata, and the text plugin's `editorOf(id, key, index)` who
  inserted an element — `{ origin, ts }`, a node and a stamp.
- **Log checksums, `retention: 'all'`.** Every log file — a sealed segment,
  an open batch — carries `hash`, the xxHash32 of its entries' JSON
  (`src/hash.js`, pure JS, no dependency on the signing plugin); a file that
  does not match at open is unreadable, as a torn one is: a segment lost
  (`droppedTs` moves) and counted in `stats().log.corrupt`, an open file
  dropped. `sync.retention: 'all'` keeps every segment, so every version
  stays exact.
- **Presence.** `@alexify/syncom/presence`: `createPresence(storage, { scope,
  timeout })` holds this node's ephemeral state and the states it heard of
  — who is here, what they edit, where their cursor is — per node, newest
  by its clock, gone without a renewal, signed with the node's key when the
  signing plugin is registered and verified on arrival (a forged or, under
  `'require'`, an unsigned state is refused), never logged. The sync plugin
  carries it: `storage.sync.presence(instance)` sends updates to every host
  as the `syncom/presence` event; a host's unit checks them (the peer's own
  node, its scopes, a rate), relays them to the scope's room and hands a
  newcomer the room's states at hello. The link contract gains an optional
  `send(event, data)`; the wrpc adapter maps it to `sendEvent` and the
  unit's events.
- **Undo: transactions, groups, step meta, a scoped stack.** A
  transaction's commits are one undo step whatever the interval;
  `group(fn)` (and `groupStart()`/`groupEnd()`) makes one step of everything
  committed meanwhile; every step carries `meta`, the application's object —
  a selection kept as cursor tokens, say, put there on `push` and restored
  on `pop` through `position()` — which travels to its redo step and back;
  `steps` lists them. `createUndo()` takes `trackedSources` (a
  transaction's `source`), `records` (ids or a predicate) and `paths`
  (fields, with what hangs under them; a step's inverse then keeps to
  them), and `onPush`/`onPop`. A write at a prefix of a step's field, or
  under it, counts as a change of the field.
- **Observe, deltas and positions.** `observe(id, path?, listener)` — on a
  `Record` too — hands a listener one record's changes a turn at a time,
  under a path or whole, local and a peer's alike, until the returned
  function is called. The `text` plugin adds `toDelta(changes, field?)`,
  composing a text's changes into one delta in Quill's form (an embed slot as
  `{ insert: { embed: marker } }`, a reset as `null`), `applyDelta(id, key,
  delta)`, making a delta the field's edits as one transaction, and
  `position(id, key, cursor)` / `positions()`, a cursor's index and side.
- **Changes, and the `transaction` event.** Every op announced reports what
  the reading shows of it, in the write API's terms and the reading's
  indices: `applyOp()` returns `changes`, a `change` event carries them as its
  third argument, a `commit` event as `changes` (with `txn`, the first seq
  of the transaction it was made in), and a new `transaction` event hands
  one turn's worth at once — a write, a `transact()`, a peer's page, a joined
  snapshot — tagged by record. A splice's cuts and insert are read from the
  rope in O(log n); a tree move names the node, its parent and the sibling
  before it; a field changed another way is a `reset` with its value.
- **Transactions.** `transact(fn, { actor, source, message })` runs `fn(tx)`
  inside the mutation queue — `tx` the write API less `purge()`, the plugins'
  methods included, plus `get()`/`has()` reading what the transaction wrote —
  and appends the ops as one group once `fn` returns: all durable or none,
  one chain block, each record's file written once, the `commit` events
  after, in order; a throw or a refused write leaves nothing appended.
  `message` (at most 1 024 characters) rides on every op in the signed
  header — the 18th wire slot, `msg` — and `history()` lists it per version.
  `applyPatches()`, `restore()` and `compact()` are transactions now: a hook
  or a validator refusing a later op leaves nothing written (it used to
  leave the earlier ops committed). Yjs's transaction *origin* is syncom's
  `source`: `origin` names the node an op is from.
- **Embeds and blocks in a text.** A document is one text: what is not a
  character — an image, a mention, the start of a paragraph or a heading —
  is an embed slot (U+FFFC) whose value is a marker `{ type, parents, attrs,
  isEmbed }` (Automerge's model). `insertEmbed()` and `splitBlock()` insert
  a slot with its marker (a `splice` carrying `vals`), `updateBlock()` and
  `setAt()` on a text replace it (an `assign`, last writer wins),
  `joinBlock()` cuts a block marker, `block()` and `blocks()` read the
  markers and the document by block, and `spans()` tells them apart: every
  span now carries a `type` — `'text'`, `'embed'` (its marker and marks) or
  `'block'`. `get()` reads a slot as the character; `updateText()`, `splice()`
  and `push()` refuse a text that adds one. A diff hands a splice patch its
  `vals` and a changed marker a `setAt` patch; `restore()`, `compact()` and
  an undo lay the markers again; a `commit` event carries them as `embeds`.
- **Paths: fields with stable segments.** A field name may be a path —
  `update(id, { 'profile/city': 'Kyiv' })`, `inc(id, 'stats/views')` — a
  field of its own under its prefix, merged on its own, so two nodes writing
  different children of one prefix both keep theirs; a read composes the
  paths into nested objects over the register at the prefix. A register
  written at a prefix resets what hangs under it below its stamp (a later
  child survives), an unset of the prefix takes the subtree, a counter, a
  set or a block holds its prefix alone (`FIELD_KIND` with `prefix`; from a
  peer, what hung under it goes), and a record holds at most 4 096 fields
  (`FIELD_KIND`, `kind: 'bound'`, `detail: 'paths'`). `/` is reserved for
  paths. A hook's `current`, a validator, a query and a `Record` see the
  paths composed; the ops, the log and a snapshot keep them apart.
- **Children of elements and nodes.** A list's element and a tree's node
  carry fields of their own, named through the element's name or the node's
  id — `items/<name>/body`, `outline/<node>/title` — each a field like any
  other, merged on its own, read composed into the element (over its value)
  or as the node's `data`; `elementAt()` and `elements()` name a list's
  elements. A write under an element or a node that is not there is
  `NOT_FOUND`; a field under a removed one is unreachable until `compact()`.
- **A surrogate pair is never split.** `splice()`, `mark()`, `unmark()` and
  `cursor()` refuse an index of a text between the two halves of a pair with
  `SURROGATE` (`id`, `field`, `index`), `updateText()` diffs by code points
  where a pair is about, and content with a lone half is a `TypeError`.
- **`unset()`, and `compareVectors()`.** `unset(id, fields)` — on the storage,
  a collection and a `Record`, and as the `unset` patch — removes fields of
  any kind: an `unset` op (wire code `u`) moves the fields' own reset
  watermark (`meta.gone`), so what they held below it goes, an older
  concurrent write of them is moot and a newer one makes them again; a
  field the record does not hold is no op. A diff removes a field with it
  instead of a whole-record reset, so an undo of a step that added a field
  is field by field. `compareVectors(a, b)` says how two version vectors
  stand: behind, ahead, equal or concurrent.
- **The write path: group commit, a free queue, `defer: 16`.** The log reserves
  an op's seq the moment it is appended and writes the ops appended while a
  file is in flight as one file after it; the mutation queue moves on to the
  next write at the append, which builds on the entry in flight, while the
  disk, the record file, the `afterWrite` hook and the events follow in log
  order — what the caller awaits (`stats().inflight`). Record files lag the
  log by 16 ms by default (`open({ defer })`; `0` lands every write at once),
  and `storage.flush()` lands them now. Writes queued behind one another are
  signed on the thread pool. On the memory backend a text takes 44 000
  keystrokes a second pipelined (from 5 000) and 19 000 awaited one by one
  (from 9 000, where the log's roll was quadratic under a window).
- **A rope under every list and text.** A sequence block is a persistent
  B+-tree over its runs' segments (`src/text/btree.js`), its run records in a
  persistent map and a placed run's segments and children in chunked lists:
  an op — a keystroke at the end of a run, an insert anywhere, a cut, a
  peer's run with what hangs under it — lands in O(log n) and leaves a new
  block, the one before reading as it did; a text's reading is cached on the
  rope, so a keystroke costs the path it copied, never the text; a block is
  hydrated from its JSON once, piece by piece, and serialized in walk order
  when read; `placeInsert` reads the rope in O(log n). `bench/sequence.js`:
  527 000 appends a second (from 171 000), 65 000 inserts at random places
  of a 100 KB text of 10 000 runs (from 98), 120 000 prepends to a text of
  10 000 runs (from 98), a 100 KB text hydrated and read 11 500 times a
  second (from 383). A block object carries `k`, `ts`, the maps and `runs`
  alone: `lengthOf(block)` and `totalOf(block)` replace its `length` and
  `total` properties. The `text` entry's budget is 22 KB (21.5 measured), the
  `all` entry's 80 KB.
- **Plugins, and the package in blocks.** The kinds beyond registers, counters
  and sets are plugins registered per storage — `open({ plugins: [text, tree] })`
  with `text` from `@alexify/syncom/text` (lists and texts) and `tree` from
  `@alexify/syncom/tree` — never process-wide; `@alexify/syncom/all` is the
  core with every shipped plugin registered, the API as it was. The main
  entry is the core alone (54 KB min+gzip, from 66). A method, a patch action
  or a local op of a plugin the storage was not opened with is refused with
  `PLUGIN_MISSING` naming the subpath; a peer's op of such a kind is refused as
  `reason: 'kind'`, logged and relayed (a hub without the text plugin carries
  the text between two nodes that have it), a snapshot block of it is left
  out with a `sync.record.kind` warning; `hello` names the kinds both ways and
  a node does not bootstrap from a host that lacks one of its own
  (`KINDS_MISMATCH`); `node.json` remembers the kinds a directory ran with and
  a reopen without one is refused. `storage.plugins`, `storage.kinds`,
  `createPlugins()`. Every subpath is a folder under `src/` and the root holds
  four files; `meta.seqs`/`meta.trees` became one `meta.blocks` slot keyed by
  field, each block naming its kind (`k`).
- **Security as blocks.** The identity and the signatures, the chain and the
  sealing of records are plugins too, each what it was as one piece:
  `signing` (`@alexify/syncom/signing`) makes the node id its Ed25519 key,
  signs every own op and verifies a peer's under `sync.signatures`; `chain`
  (`@alexify/syncom/chain`) writes a block per applied batch, checks a cold
  read and gives `validate()` its walk; `encryption`
  (`@alexify/syncom/encryption`) seals `{ encrypted: true }` records for this
  node's RSA pair. The key functions — `calculateHash`, `generateSigningKeys`,
  `loadSigningKeys`, `sign`, `verify`; `generateKeys`, `loadKeys`, `encrypt`,
  `decrypt` — and `Blockchain` moved to those subpaths off the root, each
  with its own browser types where Web Crypto is async. Without `signing` the
  node id is what `getId` mints (a UUID by default; cuid, ulid… through
  `open({ getId })`), nothing is signed or checked, and a directory keeps the
  key it was given as its id (one born without the plugin is rekeyed once,
  with `identity.rekeyed`, when it arrives); without `chain` no block is
  written and `validate()` is `NO_CHAIN` naming the plugin. What the options
  ask for and no plugin provides is `PLUGIN_MISSING` at `open()`:
  `sync.signatures: 'require'` without `signing`, `chain: true` without
  `chain`, `encrypted: true` without `encryption`. The chain and the schema
  hash use SHA-256 through Web Crypto on both platforms (`src/crypto/digest.js`), so
  the core has no crypto half. New: `atRest(fsi, { key | password, salt })`
  — a backend wrapper (every file AES-256-GCM under one key, PBKDF2 from a
  password, `DECRYPT_FAILED` with a `reason` for a file that is not the
  key's). The main entry is 51 KB; `/all` registers all five plugins.
- **Backends as blocks.** `memory()` — the backend in memory, what
  `createMemoryFsi()` was — is `@alexify/syncom/memory`, off the root; the
  core keeps the contract (`isFsi`). New: `layered([top, …, bottom], { write,
  fill, queue })` from `@alexify/syncom/layered`, one backend over several —
  a read is the first hit top down, filled upward; a write lands on every
  layer in list order, `'through'` (the default) or `'back'` from a queue the
  top answers ahead of (`flush()`, `close()`, `pending`); `create` is
  exclusive across the layers, so a lock on the disk is a lock whatever the
  memory above it holds, and under `'back'` nothing stale is read from below.
- **Sync as a block.** The sync manager — the dialing side and the hosting
  unit — is the `sync` plugin, `@alexify/syncom/sync` (`SyncManager` and
  `isSyncLink` with it); without it `storage.sync` is `PLUGIN_MISSING`, and
  the core still takes a peer's page through `applyRemote()` and selects
  what a peer lacks with `outbound()`, now exported from the root — the
  updates API a transport of the application's own carries. The options,
  the hooks, the link contract and the apply path stay in the core, which
  is 44 KB.
- **Schema as a block.** The entity definitions — the validators adapted,
  the id fields, the indexes, the migrations and the lens — are the `schema`
  plugin, `@alexify/syncom/schema`, read once at `open()`; the core applies
  them (collections, validation on the write path, the catalog's indexes,
  `schemaInfo`, `migrate()`, `check()`) and keeps `ValidationError`. Without
  the plugin `open({ schema })` and `open({ validator })` are
  `PLUGIN_MISSING`, as are `migrate()` and `check()`, and records are
  untyped. The core is 42 KB.
- **Telemetry as a block.** The OpenTelemetry adapter — `{ api }` or
  `{ tracer, meter }` into the writer the engine records through — is the
  `telemetry` plugin, `@alexify/syncom/telemetry`, with `createTelemetry()`
  to build a writer by hand; the core keeps the writer contract, the
  disabled writer and `traced`, takes a writer given to `open({ telemetry })`
  as it is, and refuses an api or a tracer without the plugin
  (`PLUGIN_MISSING`). An `OpLog` opened on its own takes a writer. The core
  is 40 KB.
- **Queries as a block.** The cursor — the Mango predicate, the planner,
  `fetch()`/`count()`/`one()`/`watch()` — is the `query` plugin,
  `@alexify/syncom/query`: `select()` and `count()` on a collection, and on
  a view at a tag, are its; without it they throw `PLUGIN_MISSING`. The
  catalog, its indexes and the text index behind `$text` (`open({ search })`)
  stay in the core, kept whether or not anything queries them. The core is
  39 KB.
- **Versions as a block.** The past — `get(id, { at })` and `history()`
  folded from the log, `diff()` between versions, `restore()`, and the tags
  (`tag`, `untag`, `tags`, `at`, copy-on-write at the record-file seam) — is
  the `versions` plugin, `@alexify/syncom/versions`; `applyPatches()` and
  `compact()`, the present and its patches, stay in the core (the undo
  subpath stands on them). Without the plugin those methods throw
  `PLUGIN_MISSING`, `stats().tags` is `null`, and a directory that holds tags
  is refused at `open()`, since its copies would not be kept. The core is
  35 KB — from 66 before the blocks; `pnpm size` checks that the core and
  every block bundled together weigh what `/all` weighs, so nothing is
  bundled twice, and every block's suite runs over the lean core with the
  plugins given by hand as well as over `/all`.
- **Lists and text.** A field can be a list — an array edited by position —
  or a text — a string typed into: `splice(id, key, index, count, content)`
  and `push(id, key, content)`, on the storage and on a live Record. Two
  nodes inserting at one spot both keep theirs, each writer's run whole
  (Fugue, the rule Loro and list-positions use), a deleted element keeps its
  place for the anchors into it, and a reset drops what is below it. A
  `splice` op carries the cut ranges and either the anchor of a new run or
  the writer's own run to extend — a keystroke at the end of one's run adds
  no key to the record. The index is resolved inside the mutation queue;
  past the length is `OUT_OF_RANGE`. Mixing kinds is refused locally as for
  sets (`FIELD_KIND` with `kind: 'list' | 'text'`); between peers the kinds'
  precedence decides — register, counter, set, list, text, tree (see Fixed).
  Lists and texts cross a
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
  `unmark(id, key, start, end, name)`, `unmarkById(id, key, markId)` and
  `spans()` — a mark is two anchors, an element and a side
  each, so the same tree rule that places typed text decides whether it takes
  the style (Peritext, Loro); per name the newest mark wins, and a `many`
  mark stacks with every other of its name (comments), removable only by id.
  `cursor(id, key, index, { side })` names a place that survives edits around
  it and `index(id, key, cursor)` says where it is now. `@alexify/syncom/order`
  (1.0 KB, off the main entry) mints fractional indexes — strings that
  sort with `<`, with room between any two — for ordering records by a
  position field. Browser budget 42 → 52 KB.
- **Trees.** A field can be a tree: `treeMove(id, key, node, parent, { after,
  before })` puts a node under a parent at a place among its siblings and
  `treeRemove(id, key, node)` takes it out with everything under it, on the
  storage and on a live Record; the field reads as `[{ id, children }]`. A
  `tree` op is one move — the node, its parent (`null` a root, `'$trash'`
  removed) and a fractional index between its neighbours — and the record
  keeps every move of every node; the tree is their fold in stamp order with
  a move that would put a node under itself skipped (Kleppmann et al. 2021,
  the rule Loro's movable tree follows), so two nodes moving concurrently so
  that each would hang under the other agree that the older move stands. A
  parent under the node itself rejects with `CYCLE` (new code), a sibling not
  under the parent with `NOT_FOUND`, both decided inside the mutation queue;
  a move to where the node is makes no op. `migrate()` carries a tree across
  a schema version and counts `trees`. Browser budget 52 → 55 KB — the move
  log and the fold, and `@alexify/syncom/order` now in the core for the
  places.
- **History and read-at-version.** `history(id, { limit, before })` lists a
  record's past as this node's log holds it, newest first, a page at a time
  (`before`, an event id, pages back from it) — one version per op the
  node applied, with the record as it read after it through the lens and
  `afterRead` — and `get(id, { at })` reads one back: by event id (what this
  node held after that log entry), by stamp (every op stamped at or below
  it, the same on every node) or by `{ vector }` (every op it covers); a
  collection's `get` takes `at` too. Both are a fold of the retained log
  (`src/history.js`), exact while nothing was dropped and, after compaction,
  from a reset stamped above `droppedTs`; `history()` reports `exact` and
  `complete`, `get()` rejects with `HISTORY_GONE` (`reason: 'compacted' |
  'scrubbed' | 'merge' | 'epoch'`) or `INVALID_VERSION` (new codes). A
  purge leaves the ops listed with their content gone; an encrypted record
  has no past. The read hooks see `at`. New page: Versions and history.
  Browser budget 55 → 56.5 KB.
- **Tags.** `tag(name)` — a name of the record-id form — names the storage
  as it is now and keeps it on this node: the catalog of the moment plus a
  copy of each record's file
  taken before its first change after the tag — nothing per record until it
  changes, one file after, in the newest tag only. `at(name)` reads records
  as they were (`get`, `has`), `get(id, { at: { tag } })` too; `untag()`
  moves to the next older tag the copies it needs; `tags()` lists them. A
  copy carries its chain block and is checked like the file; a copy that
  cannot be written leaves the record held (`UNPERSISTED`) and the tag
  reading the file; a purge reaches every tag. A tag is the whole storage:
  `at(name).list()`, `at(name).collection('Post').select()`/`count()`/`get()`
  over the tag's own catalog (no `watch()`, no `$text`), and
  `at(name).snapshot()` pages the storage as it was for another storage's
  `mergeSnapshot()`. Tags do not replicate. New codes `TAG_EXISTS` and
  `TAG_NOT_FOUND`; `tags.json` and `tags/` on disk. Browser budget
  56.5 → 58 KB.
- **Diff, restore, patches, the commit event.** `diff(id, from, to)` is the
  list of patches — plain JSON in the terms of the write API: `put`,
  `write`, `inc`, `add`, `remove` (as observed, or exactly the `removals`
  named), `splice`, `treeMove`, `treeRemove`, `delete`, `purge` — that
  turns the record at one version into the record at another, per field by
  kind, with a `write` plus the other kinds made again whole when a
  register is gone or a field changed kind; `applyPatches(id, patches)`
  realizes a list in one turn of the mutation queue — every patch checked as
  the method of its name checks its arguments (`src/args.js`, a `TypeError`
  otherwise), every op rehearsed over a scratch record before the first
  append, so a list lands whole or not at all; `restore(id, at)` leads
  back with new ops, a version of its own that merges like any write. The
  storage raises `commit` for every op of its own once durable — the op,
  its seq, the source, the record before and after, the kinds — built only
  while something listens: what an undo stack keeps. A text's marks are not
  diffed. Browser budget 58 → 60.5 KB.
- **Undo and redo.** `@alexify/syncom/undo` — `createUndo(storage, {
  mergeInterval, limit, scope, exclude, actor })` — is an undo stack over one
  node's own writes, fed by the `commit` event: every commit adds the
  patches that take it back, commits close together make one step, `mark()`
  closes a step, a new write clears the redo stack. `undo()`/`redo()` apply
  a step through `applyPatches()` — new ops that merge like any write — and
  leave a field anyone else changed since alone (`skipped`), a whole-record
  step with a conflict whole, unless `force`; an undone add revokes its own
  tag alone. Events `push`, `pop`, `change`; `canUndo`, `canRedo`, `size`,
  `clear()`, `stop()` (on `close()` too). The manager pins the log from its
  oldest step. A subpath (6.0 KB alone, budget 6; its patch vocabulary, the
  argument checks, Myers, Emitter and shape helpers are the core's and dedupe
  in a bundle).
- **Branches.** `@alexify/syncom/branch` — `branch(parent, { path, from?:
  { tag }, ...options })` forks a storage into a new directory under a new
  identity, standing at the parent's state or at a tag of it (its snapshot
  pages joined, its vector adopted, `branch.json` written); `merge(source,
  { into })` hands either side what the other lacks as ops through
  `applyRemote` — `src/sync/outbound.js`, the selection a push makes, now shared
  with the sync manager, asked for every stream, a third node's included —
  or, when one of those streams is out of the source's log, as a join of
  state (`joined: true`); `branchInfo()`, `drop()`. A branch is a storage
  like any other; a merge into a parent that dials peers reaches them. New
  code `BRANCH_EXISTS`: a path that holds a branch, or any files, is never
  taken over; `drop()` removes a branch alone (a storage without
  `branch.json` is a `TypeError`), and a fork that fails leaves nothing
  behind. A subpath that bundles no engine (3.2 KB, budget 3.5).
- **Faster lists and text.** The index a sequence field is read through
  (the Fugue walk) is built once per change and kept on the cached entry
  (`entry.seqIndex`, never persisted): the resolver that places an insert
  and the fold that reads the field back share it. The build itself parses
  a run's tuple once — an unchanged run keeps its tuple between blocks —
  and keeps one per-slot array instead of three per run; a reset prunes
  through the same parse; a local write observes the record's clock
  without rebuilding its metadata. Typing into a two-thousand-character
  text: at the start 174 → 1,100 ops/s, anywhere 320 → 2,000, at the end
  6,400 → 9,500 (in memory, on one machine); in the cross-library scenarios,
  whose text grows past ten thousand characters, 155 → 399, 224 → 541 and
  1,260 → 1,780 — every op still works over every run of the field, and the
  record file is written whole.
- **The log knows what it dropped.** `storage.log.droppedTs` is the newest
  stamp among the ops compaction dropped, or an open could not read — `0`
  while nothing ever was — persisted in `index.json`; a record's retained
  entries are its whole past only from a reset stamped above it.
  `storage.log.pin(keep)` holds the segments a reader of the past needs,
  like `retain` does for the sync manager, until the returned function is
  called; `stats().log.droppedTs` reports it.
- **`compact(id)` and deferred record files.** `compact(id)` rewrites a
  record as the ops its reading takes today — a `write` of the registers,
  then one op per field of another kind (a text or a list as one run, a tree
  as one move per node) — so what lies under it goes by the reset rule here
  and on every peer and the record reads the same: the answer to a tree's
  move log and a text's runs growing until a reset. It resolves to how many
  ops it took, `0` for a record that is not there. `open({ defer: ms })`
  lets a local write's record file and chain block wait up to `ms`: the log
  append is durable at once, the cache and the catalog read the held entry,
  one timer lands every record due, one file each under one block, `tag()` and
  `close()` flush first, a peer's page or a replay that writes the record
  settles its slot, and a crash before the flush replays the batch like a
  failed file write. Off by default; one keystroke into a 10 KB text on
  `node:fs`, 1,431 → 2,810 ops/s with the chain (on the memory backend the
  file is not the cost, and nothing changes). `stats()` gains `held` and
  `deferred`; a push and a branch merge walk the retained log without
  copying it (`OpLog.scan()`).
- **A keystroke costs its own run, not the field.** A splice that only
  appends to the writer's run carries the held index over (`extendIndex`)
  instead of walking the field again, and the reading with it — applying a
  character at the end of a thousand-character text runs at 155,000 ops/s
  in `applyOp`; an insert elsewhere, or under a peer's concurrent run, still
  walks. `spans()` is one sweep over the walk, O(characters + marks ×
  active) instead of O(characters × marks). A tree is folded once per block
  however often it is read (a 20,000-move tree: one fold of about 100 ms,
  then about 1 ms for a move's checks and the render), a `move()` reads one
  list value instead of rendering the list, and `history()` runs the lens
  and `afterRead` for the versions it hands out only. `bench/tree.js`,
  `bench/tags.js` and `bench/history.js`.
- **Telemetry for versions.** `tag()`, `untag()`, `history()`,
  `get(id, { at })` and `applyPatches()` — so `restore()` and `compact()` —
  are spans: `syncom.tag`, `syncom.untag`, `syncom.history`,
  `syncom.version`, `syncom.patches` (each op a `syncom.commit` child), none
  carrying a record id, an origin, a url or a scope. `stats().log.pins` and
  `stats().tags`. `tests/package/telemetry-events.test.js` fails when a log
  event, a span or a metric of `src/` has no row in the telemetry guide.
- **`INVARIANTS.md`.** Every guarantee — `SYNC-n`, `OPS-n`, `LIST-n`,
  `SEQ-n`, `TREE-n`, `RLE-n`, `BOUND-n`, `LOG-n`, `VER-n`, `TAG-n`,
  `PATCH-n`, `UNDO-n`, `BRANCH-n` — names the tests that hold it, and
  `tests/package/invariants.test.js` fails when an id names no test or a
  named title is gone. The sync-engine suite gains a seeded walk under
  hazards: a link that drops, comes back and may deliver a page twice, the
  dialer closed and reopened mid-walk; after it the two nodes converge and
  every record folds back to its present.
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
  counter, a batch, replicating a store; in memory and on disk; a cold start;
  typing into a text at its end, its start and anywhere, against the three
  CRDT libraries), each pair in a fresh process and checked before it is
  timed; the libraries
  live in `bench/compare`'s own `package.json`, never in syncom's
  devDependencies. `pnpm bench:size` measures browser bundles, `pnpm bench
  --save` records syncom's own benchmarks, `pnpm bench:report` turns all three
  into the charts of the docs and the README. `docs/comparison.json` (rendered
  by `pnpm docs:comparison`) compares forty-eight features, each cell decided
  from the published source. New pages: Why syncom?, Compared with
  alternatives, Compared with RxDB (300 rows from its code and docs),
  Compared with CRDT libraries (Yjs, Automerge and Loro as CRDT libraries
  only: 141 rows from their repositories, `docs/comparison-crdt.json`, with
  the size of each whole package from `pnpm bench:size`), Benchmarks,
  Architecture.

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
  `memory()` (a backend in memory, for tests, SSR and benchmarks —
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

- **A peer’s `actor` and `from` are bounded.** Both are claims, carried as they are — and in the header
  every node hashes, in the browser at once on the main thread, so a peer chose how much a node hashed
  and how large a buffer it kept. An op whose `actor` or `from` is past 256 characters (`MAX_ACTOR`) is
  `malformed`; a local actor past it is a `TypeError`. The browser halves’ scratch buffers (the CRC-32
  table’s, SHA-256’s) are let go of past a megabyte, and a log file or a segment that fails its
  checksum, or is no segment at all, is told by its shape alone — nothing of it is parsed.
- **A host could keep a bootstrapping node paging for ever.** The dialing
  side took the host's snapshot cursor as it came — one that did not move
  on was asked again and again — and read a streamed page to its end,
  however long. A page without records, a cursor that does not pass the
  last one, or a streamed page past `sync.maxPageBytes` (new, 256 MiB by
  default) now stop the bootstrap with `BAD_PAGE` (`url`, `reason`).
- **An op on a purged record no longer costs a rewrite of the log, nor
  carries the payload on.** A peer's op that landed on a record purged
  before it was logged with its payload, relayed with it to every peer this
  node relays to, then scrubbed — and the scrub rewrote every log file that
  had ever held the id, so a peer sending op after op for a purged id made
  this node rewrite all those segments each time. Such an op is now
  stripped before the append (the header, digest and signature stay, so it
  still verifies) and logged `scrubbed`; a scrub rewrites only the files
  holding entries it takes.
- **A fork of a stream is refused, never healed in silence.** Two ops of
  one `origin` and `seq` that differ — a restored backup minting seqs again,
  a cloned directory, an equivocating signer — were taken first-come and the
  other dropped as a duplicate, so nodes diverged for good. Every op now
  names the fingerprint of the op before it in its stream (`prev`, the
  SHA-256 of its header, slot 19 of `packOps`, in the signed header; still
  `PROTOCOL` 1, the wire of the first publication), and the log keeps each op's
  fingerprint and every stream's head (`index.json` `heads`, kept past
  compaction). A peer's op at a seq this node holds under another
  fingerprint, or one whose `prev` is not the held predecessor's, is
  refused as `EQUIVOCATION` (`reason: 'seq'` / `'chain'`): not logged, not
  relayed, counted (`equivocations` in an apply or push result,
  `syncom.ops.rejected{equivocation|chain}`), an `error` event with both
  fingerprints, `refused` on a host. An unsigned op carries no digest, so
  its fingerprint covers its header alone: two unsigned ops that differ in
  payload only are one op to it. A digest and a fingerprint are 43
  base64url characters. Cost: about 2.5 µs per local op on the unsigned
  path (a keystroke in memory 14.5 → 17 µs; the editing trace 47.8k → 42.1k
  ops/s), 3% on the signed one; on disk within noise. Budgets: `/all`
  108.5 KB, `/versions` 33.5 KB.
- **Lists, texts and trees are bounded against a peer.** A peer's op or
  block could cost a node more than it says, or split the mesh: a `[3e8]`
  gap in a snapshot run was expanded element by element; any origin could
  extend another's run, so the order of arrival decided the text; the
  snapshot path had no bound on pending work, so one hostile block spent it
  for every honest op after it; a 4,000-deep tree chain threw in the render
  on the apply path (`PAGE_FAILED`, then `STUCK`); a forged place among
  siblings made every local `treeMove()` next to it throw. Now a run holds
  at most 1,048,576 slots and a field 4,194,304, tombstones included; a run
  is extended by its own origin alone; pending work per field — a run whose
  anchor has not arrived, a cut or an extension of a run not here, a
  register of an element not here, a mark switched off before it arrived —
  is bounded by `open({ sync: { pendingMax } })` (4,096 by default,
  `Infinity` to disable), all of it on the op path and in a snapshot block
  alike (`OP_REFUSED`, reason `bound`, with `detail`, `count` and `max`); a
  place is a fractional index of at most 1,024 characters, a tree reads 512
  levels, and `treeMove()` refuses a move past either (`OUT_OF_RANGE`, with
  `depth` or `reason: 'fi'`); two moves under one stamp tie by node id. A
  payload the engine does not admit is never silent: a `TypeError` on the
  local path, `OP_REFUSED` with `reason: 'malformed'` from a peer — the op
  logged and relayed as a no-op, counted in `syncom.ops.rejected`.
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

- **A write made at once, and `close()`.** A fire-and-forget write made at once (`inc()`, `splice()`,
  `update()`… not awaited) whose group failed raised no `unhandledRejection`, unlike the same call
  through the queue: the call has a promise of its own. A write made at once that could not be
  announced as its group landed left its record in flight for good and its turn unannounced: the
  entry is settled whatever the slot did, and the `transaction` event leaves whatever a refresh did.
  `close()` called twice in one tick sealed the log twice and emitted `close` twice: a second call is
  the same close.
- **A peer could grow a run past `MAX_RUN` through parked extensions, and replicas diverged.** An
  extension `{ run, from }` ahead of its run's length waited in `ext` with no bound on `from`, landed
  with no check when the run reached it, and cost nothing against the field while it waited: a one-slot
  run came to read as three million characters, its spans written over the next run's keys in the id
  index, the block's own JSON came back without the run (`normalizeSeq` dropped it as past `MAX_RUN`),
  and a node joining from the snapshot read five characters where the holder read millions. An
  extension that would end past `MAX_RUN` is refused as `bound` (`detail: 'run'`) where it arrives,
  left out of a peer's block, dropped rather than landed should one ever settle past the bound, and
  what waits in `ext` counts toward `MAX_FIELD` as landed slots do (SEQ-11).
- **A run of no slots in a peer's snapshot threw out of `applyOp` on the next extension.** A block
  carrying `['>1:4:A', []]` was taken, and the first `{ run, from: 0 }` on that run reached for a last
  span it did not have — a `TypeError` out of `applyOp`, so the peer's page failed on every retry. Such
  a run is left out where a peer's block is normalized, and an extension of one is malformed (OPS-12).
- **A peer's cut was unbounded, and a range named twice was reported twice.** The ranges of a splice's
  `cut` were read one by one before the engine saw the op — two thousand copies of one range made two
  thousand changes — and `[[r, 0, 5], [r, 0, 5], [r, 2, 5]]` on `hello world` cut seven characters and
  reported fifteen. A cut of more than `MAX_CUTS` (65 536) ranges is refused as `bound` (`detail:
  'cuts'`) before any range is read, and the change report merges the ranges of one run: what was cut,
  once (BOUND-5). The coalescing of cuts keeps its own, lower bound on how far one op grows.
- **Counting a block's pending work walked every register and mark.** An op whose element or anchor
  was not here yet — a peer's `setAt` ahead of the splice it names, a cut of a run still on its way —
  read the bound on pending work by walking every `pos` and `vals` register and every mark of the
  block, parsing each: 55 ms an op on a list of 200 000 assigned values, refused or not. The
  registers of elements not here and the marks switched off before they arrived are counted as they
  come and go (a slot that arrives settles the registers that named it), so the count is a sum
  (BOUND-1). On the way, a run waiting for its anchor is hung under the anchor's run as soon as
  that run is here — placed or still waiting itself, as a hydration hangs it — where it stayed
  counted as waiting until the parent was placed.
- **A peer's splice whose cut was shaped otherwise stopped its page.** A cut of `[null]`, `[5]` or
  `[[null, 0, 1]]` threw out of `applyOp` before the engine could refuse it, so `applyRemote()`
  failed the whole page and the peer's stream stalled there on every retry. It is refused as
  malformed now, a no-op in the log, and the page goes on.
- **Two writers of one node lost characters growing one run.** Two handles on one text, or a
  handle and the storage, could extend one run at one offset from two readings; the engine took
  the second extension for a duplicate and dropped it.
- **The `/all` storage's type lacked `openText()`.**

- **An unreadable `index.json` vouched for the whole log.** With no index
  the floor is the first seq on disk; with one that did not read it stayed
  at 1, so a log compacted past seq 1 claimed to hold what it had dropped
  and `droppedTs` stayed 0. An index that does not read is now no index.
- **A scope function that threw on one record failed every snapshot.**
  `snapshot()` asked every record its scope and let a throw out, so one
  record the scope function could not read stopped every peer's bootstrap
  from this node. A record it throws on is left out of the page
  (`snapshot.skipped`, `reason: 'scope'`), and a page for every scope no
  longer asks any record its scope.
- **An open of the log could delete what it failed to read.** A read error
  of an open group's file (EIO, EMFILE) was taken for a torn write and the
  file removed, and a group file that failed its checksum — whole once, so
  answered — was removed too. A file that is there and cannot be read now
  fails `open()` with `CORRUPT` (its `cause`), and a group file that fails
  its checksum is moved to `log/corrupt/` and counted as lost. A torn one,
  never answered, is still dropped (`log.open.torn`).
- **A transaction of many ops on one large record held a copy of the
  record per op.** Every op kept the record it left, its delta and its hook
  context until the transaction landed: 2 000 moves of one tree held
  926 MB, 8 000 pushes onto one list 348 MB, and an 8 000-node outline built
  in one transaction ran out of memory. An op a later op of its record
  follows now keeps its op and its changes alone (the record it left only
  while a `commit` listener exists, the hook context only with an
  `afterWrite` hook) — 4.8 MB and 10 MB — and the record is in flight,
  deferred and refreshed once, as its last op left it: a live `Record`
  emits one `update` per transaction, with the delta of all its ops.
- **A list that a move and a push touched could show an element twice.**
  A local push after a move extended the move's position run, so every
  pushed slot read as the moved element (duplicate names, wrong values). A
  position run is never extended now; a peer's extension of one is
  malformed, and a longer one in a peer's block is left out.
- **A splice's embed markers could overwrite a newer `setAt`.** When the
  assign to a slot arrived before the splice that laid it, the splice's
  marker won; both settle by stamp now, so either order reads the same.
- **A move that carried a value from an assign not yet here reported no
  value change**; it reports a `setAt` with the move.
- **A field anchored below an `unset` read as missing after a reopen.**
  A block read from a file was hydrated under the record's base rather than
  the field's own floor.
- **A refused presence update was heard by no one, or as a refused
  hello.** The dialing side dropped what a host's relay carried that did
  not verify (`.catch(() => {})`), and a host counted its presence refusals
  under `syncom.hello.refused` and logged them as `sync.op.refused`. A
  presence instance now raises `refused` (`{ from, forged, unsigned,
  refused }`), both sides count `syncom.presence.refused` by reason, a host
  logs `sync.presence.refused`, and a relay that cannot be taken is logged
  (`sync.presence.receive`). A `change` listener that throws is logged
  (`listener.error`) instead of leaving a rejection unheard.
- **An application's plugin had no methods on the storage.** The facade
  carried a stub for every shipped plugin's method and nothing else, so a
  plugin of the application's reached its methods inside a transaction only,
  though the types promised them on `open()`'s storage. They are installed at
  open now (a name that would shadow a member of the storage is refused).
- **`INVALID_VERSION` was typed as a `SyncomError` code it never is.** It is
  a `TypeError`'s (`typed()`), so `error instanceof SyncomError && error.code
  === 'INVALID_VERSION'` was never true. The codes of the typed `TypeError`s
  are their own union now, `TypedErrorCode` (`PRESENCE_SIZE` among them,
  which had no row in the reference either); a test reads every code `src/`
  raises and holds both unions and the reference table to it.
- **A presence state could be pinned, and a room filled, for good.** An
  entry's stamp had no upper bound, so a state stamped hours ahead outlived
  every timeout; the host stored and relayed entries without the checks a
  receiver makes; a repeated hello refilled the presence rate; the scopes a
  hello asked for were neither checked nor bounded; empty rooms stayed; and a
  state nested thousands deep threw out of the depth check. A stamp more than
  60 s ahead is refused, the host checks every entry as a receiver does
  before it keeps or relays it, the rate bucket survives a hello, a hello asks
  for 256 scopes at most (stream names or `*`, each once), an empty room
  goes, and the depth is checked without recursion.
- **A layered backend's background failure surfaced in an unrelated read.**
  Under `write: 'back'`, a lower layer's failed write was kept and thrown
  from whatever next waited for the queue — a read that missed the top, an
  `exists`, a `list` — and every failure after the first was lost. Each is
  told to the new `onError` and counted (`failed`); only `flush()`, `sync()`
  and `close()` throw it.
- **`drop()` needed the versions plugin, and a failed `branch()` stayed
  open.** Sweeping a branch asked for its tags before closing it — a
  `PLUGIN_MISSING` on the lean core, which left the branch open and locked
  (a failed `branch()` sweeps the same way) — and removed `branch.json` first,
  so a sweep cut short left a directory neither `drop()` nor `branch()` would
  take. The branch closes first, its tags are read only where the plugin
  keeps them, and `branch.json` goes last.
- **A crash or a reader could catch a log index, a segment or `node.json`
  half written.** The `node:fs` backend truncated a file and then wrote it:
  a crash in between left a torn file, and a torn `log/index.json` opened as
  a new epoch (every peer re-bootstraps), a torn `node.json` did not open at
  all. `write(dir, name, content, { atomic: true })` stages the content and
  renames it into place — the log's index and its segments (a scrub rewrites
  them), `node.json`, the schema file, `tags.json`, the catalog, the chain's
  index, the sync registry and `branch.json` ask for it; a record file does
  not (the log's replay mends a torn one, and a rename per landing cost a
  third of the disk's write rate). A temporary file is never listed. A read
  of a tag's record that met a file half written by a landing reads again
  once the landings are down (the flake of the patches suite).
- **A field named like an `Object.prototype` member could take its value.**
  A join read a side's data without checking that it owned the field, so a
  clock naming `valueOf` over data that did not hold it copied the inherited
  function into the record; a merge that dropped a field named `toString`
  did not report it gone; a peer's vector with a `__proto__` key
  re-prototyped the copy the sync manager kept. Own keys alone, everywhere.
- **An encrypted file could stand in for another.** `atRest()` sealed every
  file under one key with nothing tying a ciphertext to its file, so one
  record's file copied over another's decrypted as that one. Ciphertexts are
  bound to their file name now (the additional data of AES-GCM); the
  docs say what stays visible (names, sizes) and what a key cannot tell (an
  older copy put back).
- **`anonymize()` left what it promised to hide.** Keys stayed by default —
  a set's elements (an email), the origins of a clock, the streams of a
  vector — the salt was empty by default, and the hash 32 bits wide. Keys are
  hashed by default now (`keys: false` keeps them), a call without a `salt`
  takes a fresh random one, the hash is 64 bits, and the docs say what it is:
  pseudonymization — the shape, lengths and numbers stay, and a guessable
  string is found again by whoever holds the salt.
- **An op could be signed by a key no one holds.** A node id passed as an
  Ed25519 key by its format alone; the all-zero key and the other points of
  small order verify a forged signature for a share of all messages, so ops
  "signed" by such an id — anyone's to write — went through under
  `signatures: 'require'`, and presence states too. The signing plugin
  refuses those keys (and a y past the field's prime, a second name of a key)
  as forged.
- **One peer could stall a node with a deep tree.** Every tree op refolded
  every move of the field, and the cycle check walked each move up to the
  root: a 10 000-node chain made every later op on that field take 4 s inside
  the mutation queue. The walk stops at 512 ancestors (`MAX_WALK`; a move past
  it is moot, like one that would make a cycle — the same on every node), the
  fold walks an index array, and a field holds 65 536 moves at most
  (`MAX_MOVES`: one more is a `bound` refusal, a snapshot block past it is not
  taken, a join keeps the oldest). One op after a 10 000-node chain: ~15 ms.
- **A counter could lose increments, or diverge, across scopes.** A counter
  kept one slot per origin and compared its stream's seqs: once a record
  moved to another scope, its node's `inc`s were silently nothing, and two
  incs of one node in two scopes summed differently by arrival order. The
  slot is per stream (`origin@scope`) now; a slot keyed by a bare origin reads
  as the global stream's.
- **A peer could push this node's clock years ahead.** A `merge` op was checked
  for the skew of its own stamp, not of the stamps its `meta` carried; the
  first local write to that record then observed them, and every op the node
  made afterwards — on any record — was refused as `SKEW` everywhere,
  through a restart. A merge op whose meta is stamped beyond `sync.maxSkew` is
  `SKEW` now (malformed, never logged or relayed), a stamp must be a positive
  safe integer, and a stamp a record already holds beyond the horizon is
  never observed into the clock (`clock.skew.ignored`, once per record).
- **The host a node dialed could renumber the node's own streams.** A host's
  `advance` and a joined vector were adopted for this node's own keys, and a
  hello's claim that the host held more of them moved them at once: a gap in
  the node's stream forever, or a seq past the safe integers and a node no
  peer would hear. Own keys never move by `advance` or a join now; a hello's
  claim (`REWOUND`) is adopted under `/signing` only with proof — the host
  hands this node's own signed op at that seq — and otherwise only with the new
  `sync.rewind: 'adopt'` (`'report'` by default; `REWOUND` carries `adopted`).
- **A deeply nested payload stopped every signing dialer.** Verifying a
  page's signatures recursed through each op and overflowed the stack on one
  nested a few thousand levels deep — `PAGE_FAILED`, then `STUCK`. An op nested
  past 80 levels is malformed before anything reads it, a verify that throws is
  that op `FORGED` alone, and a local write nested past 64 levels is a
  `TypeError`.
- **One unreadable cursor in a room hid every cursor, and the rejection went
  unhandled.** A peer's presence state with a cursor token the field could
  not read made `presenceCursors` throw, and the ProseMirror and CodeMirror
  adapters called it as `void refresh()`. The token is that peer's cursor
  left out now; the adapters' cursor, selection and undo work report through
  `onError` (or warn `editor.cursors` / `editor.undo`).
- **An editor binding could part ways with its editor, or hang.** An editor
  that threw on a peer's change left the binding's shadow ahead of the
  editor, and later edits landed at the wrong indices; a first load the editor
  refused left the binding buffering the field's events for good; `flush()`
  after a stop never answered — and the adapters' undo waits for it. The
  binding reloads the editor when it throws, a first load that fails stops
  it (`ready` rejects), `flush()` answers at once once stopped, and `stopped`
  and `onStop(reason)` say so.
- **ProseMirror dropped what its schema could not hold without a word.** The
  document left out a mark or a node the field held, and the next edit sent
  that loss to every peer. `onUnfit(delta)` hears it now (a warn,
  `editor.unfit`, without one).
- **A log roll the disk refused hung every write for good.** Once a group of
  ops was on disk, the log rolled — sealing a segment, writing its index — and
  only then answered the group's writers; a roll that threw (the disk full as
  the segment was written) answered no one, and every write landing behind
  them in log order waited forever, `flush()` and `close()` with them, even
  after the disk came back. The group is answered whatever follows its append
  now: a failed roll seals nothing, is logged (`log.roll.failed`, at `error`),
  counted (`stats().log.rollFailures`), and the next append rolls again.
- **A telemetry writer of the application's could hang the same way.** The
  core took a writer given to `open({ telemetry })` as it was, checked for
  `enabled` and `withSpan` alone, and called some twenty methods on it: one
  missing or throwing after an append left the writes waiting. A given writer
  is contained now — a method it lacks records nothing, one that throws is
  swallowed, `withSpan` runs the work exactly once whatever the writer does.
- **A scrub cut short could lose acknowledged groups.** A purge rewrote the
  journal holding the id's ops in place; a crash half way through read back at
  the next open as a torn last line, and every group after the tear was gone —
  the node then handed out its own seqs again, which its peers dropped as
  duplicates. The copy goes under a new name now, which an open reads first,
  and the old journal is removed after it; a copy a scrub left behind is
  removed at the next open, so no payload the scrub took survives it.
- **A failed group could come back in part.** A journal line was taken seq by
  seq: a group whose append failed after its bytes landed, followed by a
  shorter group that took its seqs back, came back at the next open with the
  failed group's tail. A line is a group whole or not at all now.
- **A list run of more than about 130 000 elements threw `RangeError`.** A run
  of a list's elements may hold `MAX_RUN` (1 048 576) of them, but joining two
  pieces of one spread the second into `push(...)`'s arguments, which V8 caps:
  a peer's snapshot with such a run, or an extension of a run whose parent had
  not arrived yet, failed the page. The same spread sat on eight other paths
  (a transaction's changes, a diff's patches, a compaction's mark patches, an
  undo step, a delta of many embeds, a block's spans). None is left.
- **`merge()` threw on a field named like an `Object.prototype` member.**
  `merge({}, { constructor: [2] })` read the inherited `constructor` and threw
  a `TypeError`; it reads the target's own keys only now.

- **Two ProseMirror editors could answer each other without end.** Where
  concurrent edits merged into a structure the schema could not hold, both
  adapters fitted the field at once, the field kept both fits, the doubled
  structure fit no better, and both fitted again, the document growing
  every round. The adapter now never answers a peer's change with an edit:
  every reader builds the same document from the field, and what the field
  lacks of it goes out with the editor's next edit. Opening an editor
  writes nothing.
- **Two CodeMirror editors could make two line breaks of one.** CodeMirror
  reads `\r\n` and a lone `\r` as a line break, and each adapter sent the
  `\n` it showed as soon as a peer's change brought the `\r`: a lone `\r`
  fitted on two nodes at once became two breaks. The fit now goes out with
  the editor's next edit, as ProseMirror's does; until then a peer's change
  shows as the field's text read again, each break where it was.
- **A marker inserted and changed in one turn read as its first value.**
  `toDelta` composed the change onto the insert as an `embed` attribute,
  which a reader takes for a mark: an editor bound to the field kept the
  block it was inserted as. The insert now carries the marker it ends with.
- **A peer's older mark was reported over text a newer one holds.** A mark
  arriving after a newer one of its name was reported over its whole range,
  so an observer, or an editor binding, showed it where the reading shows
  the newer one. It is reported over what the newer ones leave.
- **An editor binding could drift from its field.** `expect` compares
  text, and a peer's change made of the characters it replaced — a letter
  cut and typed again — let a delta land by index over the new characters,
  not as the binding had rebased it: the binding now reads its own event
  against the delta it rebased and reloads where they differ. A send right
  after a failure went out over the delta the failure dropped, and its
  reload never came: sends now wait for it. And what was typed while the
  field was being read again was sent over the contents that replaced it:
  it now goes with them. Each left an editor apart from the field until
  the next reset; under load the two-editor tests failed one run in seven.
- **A deferred window could run its flushes back to back.** A window armed
  while the previous flush was queued or writing fired inside it, so once a
  record's file took longer to write than the window (a text of thousands
  of runs on disk), the flushes ran one after another, each with a
  keystroke or two, each writing the whole record while the writer waited
  behind it: typing at the start of a text fell to about 40 characters a
  second past 12,000 of them. A window is now armed when the flush before
  it is done, and is as long as that flush took when it took longer than
  `defer`; the same typing holds at about 12,000 a second.
- **A list, text or tree field a peer's first op made empty was not
  reported.** An op on a field this node did not hold that left it reading
  as `[]` — a tree move of an unknown node into the trash — made the
  field, but the turn's changes left it out, so an observer's reading
  lacked it. It is reported as a reset to the empty value now.
- **A writer that never yielded slowed down with every write.** Over
  `memory()` an await loop never lets the deferred window's timer fire, so
  every record it wrote stayed held in the cache, and each write walked all
  of them looking for one to evict: inserts fell from about 45,000 a second
  to 2,000 within twenty thousand. The window now also lands by count (1,024
  records or 8,192 positions), a write looks at a bounded few of the oldest
  entries to evict, and the log and the landing take a range's ends with a
  loop rather than a spread an argument list cannot hold. A text insert's
  marks are read at its index alone (`styleAt`, one walk of the marks and
  the rope's measures), never from the whole text's spans.
- **`applyDelta` refused a marker set over two slots.** A delta that sets two
  neighbouring block markers alike composes into one retain over both;
  `applyDelta` sets the marker of every slot of the range now. And an editor
  binding whose sends keep failing no longer retries in a loop that holds
  the event loop: it reloads after a growing pause and stops after five
  failures in a row (`onError`), and a `STALE` that no event explains reloads
  instead of waiting forever.
- **A live Record read a path write as a field of its own.** After
  `update(id, { 'profile/city': 'Kyiv' })` a Record held both the old
  `profile` and a `profile/city` property, where `get()` reads
  `{ profile: { city: 'Kyiv' } }`. A Record is now refreshed with the
  composed reading on every path, a repair's included.
- **A cut across a peer's insert reported the insert as cut.** A `splice`
  that cut a range of a run another node had typed inside (unseen by the
  cutter) was reported as one change from the first cut slot to the last —
  the peer's characters between them included — so a view or an editor
  following the changes dropped text the field kept. A cut now reads as one
  splice per stretch of the reading (`spansOf` in the sequence engine), and
  an insert that also brings a waiting op's elements into view reads as a
  `reset` of the field.
- **`toDelta(changes, field)` missed a deleted record.** Asked for one
  field, it skipped the whole-record `delete`/`purge` change (it has no
  field) and a reset of a prefix of the field, and answered an empty delta
  where it must answer `null` — read the field again.
- **A refused handshake push no longer closes the inbound half, and a failed
  dial is retried.** A push the host refused during the handshake (a rate
  limit, a page over `opsPerPush`) stopped the handshake before the
  `changes` subscription: nothing came from the host until a reconnect or
  `enableNode(url, false)` and `true`, and with no pages there was no sign of
  life to push the rest at. The subscription opens anyway now. And a
  `connect(node)` that threw left the node dead until `enableNode()` or
  `removeNode()`: it stays in `peers()` with its error, and the next
  `sync()` dials it again — no timer, as before.
- **The types say what the code does.** `browser.d.ts` re-exports every type
  `index.d.ts` does — the CRDT branch's (`Patch`, `Version`, `Tag`,
  `TextSpan`, the payloads…) never reached the browser condition — and a
  consistency test keeps it so. The storage `error` event is a union with
  `UNPERSISTED` (`ids`, no `op`); `sync` events carry `outOfScope`;
  `applyOp` takes its `{ pendingMax }`; `OpLog.pins`, `SyncManager.pendingOps()`,
  `UndoManager.listenerCount()`, the hello's `version` and a write context's
  `removals`/`own` are declared; `Patch` takes `mark`; and the doc comments of
  `skipped`, `pageSize`, `branch()`, `branchInfo()` and `drop()` are right.
- **A malformed register, counter or set payload is reported.** A peer's
  `write` or `set` without a plain object, `inc` of no finite number, or
  `add`/`remove` without an array applied as nothing and said nothing — the
  sequence and tree ops already reported theirs. They are `OP_REFUSED` with
  `reason: 'malformed'` now, counted, still logged and relayed as no-ops.
- **A live `Record` reads as `get()` after a change too.** It loaded through
  the lens and the read hooks, but every change it followed — a write here,
  an op from a peer — handed it the record as stored: a redacted field showed
  its raw value after an unrelated `update()`, and a record of an older
  schema version showed its old field names after an `inc()`. The refresh
  now reads through the lens and `beforeRead`/`afterRead`; with either in
  play it runs once the write is done, outside the mutation queue (a read
  hook may write), in the order of the writes.
- **A snapshot block is held to the node's `sync.pendingMax`.** The op
  path took a node's bound, the snapshot path the default 4 096 whatever
  the option said: a node that raised it still dropped blocks a peer's ops
  could have built there. `normalizeMeta` and `normalizeSeq` take the bound
  a `merge` op is applied under.
- **Small edges.** A listener the `maxListeners` cap refuses is no longer
  left registered behind the throw. `diff()` of the CRDT deltas takes a
  `null` side and a non-collection under an array instead of throwing, and
  no longer reads a string as a set of its characters. `$text` at a tag says
  that a tag keeps no text index, not that the entity has no search fields.
  `update()` with an invalid id is `INVALID_ID` like every other writer, and
  its `NOT_FOUND` (and `swap()`'s) carries the `id`. `applyPatches()` names
  an unknown action as such. `adopt` walks a peer's vector by its own keys.
- **A failed undo never inverts part of a record twice.** When a hook or a
  validator refused a later op of one record's inverse, the earlier ops of
  it had landed but the record stayed on the undo stack as the step left
  it, so the retry took them back again (`views` 2 → 1 → 0). The record now
  waits on the stack from where the landed ops left it — their way back is
  on the redo stack — and the retry takes back the rest.
- **A counter stays a number every node reads alike.** One origin's sum had
  no bound: past `Number.MAX_VALUE` it became `Infinity`, saved as `null`,
  so a node that reloaded the record counted again from 0 while one holding
  it in memory kept `Infinity` — a divergence a peer could cause on purpose.
  Each origin's sum now stays within ±`Number.MAX_SAFE_INTEGER`: an `inc`
  past it is a bound refusal (`detail: 'counter'`; `FIELD_KIND` locally,
  `OP_REFUSED` from a peer), the same on every node; a snapshot slot past it
  is not taken; and the sums add up in origin order, so a counter of
  fractions no longer reads differently by the order of arrival. A merged
  record this node did not hold is joined like any other rather than copied,
  so data its meta does not back — a slot or block refused, a value with no
  stamp — does not come with it.
- **`compact()` keeps what a record reads as.** It made a text again from its
  string and dropped its marks, dropped a counter at `0`, and refused a text
  or a list longer than one run (`FIELD_KIND`, `detail: 'run'`). The marks
  in force are laid again now, in stamp order and with the expand rule their
  anchors had (`marksIn` in src/sequence.js; patches take a `mark` action), a
  counter at `0` is made again with an `inc` of 0, and a long field in runs
  of `MAX_RUN` — `restore()` too. And one `splice()` that a writer's own run
  cannot hold whole anchors a new run instead of overflowing it, as typing
  past a full run already did.
- **`spans()` reads a name that has both plain and stacking marks.** A
  stacking (`many`) mark newer than a plain mark of its name over the same
  characters threw `marks[key].push is not a function` from `spans()` — a
  read any peer could break with two marks — and a plain mark whose value
  was an array took the stack's entries into the block's own value. On one
  name the two now mix in stamp order: a plain mark takes the place of what
  is there, a stack included, and a newer stacking mark starts a stack over
  it.
- **An array spliced into a text, or a string into a list, is refused.**
  `push(id, 'body', [1])` on a text field was let through the local kind
  check; the list it made outranks a text, so the text was dropped — on
  every node the op reached. A splice now names its kind by its content
  and meets the field's before it is stamped (`FIELD_KIND`, the field left
  whole), as a string on a list already did inside the engine.
- **A kind clash converges.** Two nodes making one field as different kinds
  at once — a write carrying it as a register, an `inc`, an `add` or a
  `splice` to it — stayed apart for good: each refused the other's op, while
  a snapshot merge of the same two states let the register win. One rule
  now, on the op path as in the merge, by the kinds alone: a register
  outranks a counter, a counter a set, a set a list, a list a text, a text a
  tree. Where the winner's op arrives, the loser's state is dropped; where
  the winner is held, the loser's op is refused for that field
  (`OP_REFUSED`). Locally a write of another kind is refused before it is
  stamped (`FIELD_KIND`), for `write`, `set`, `inc`, `add` and `remove` as
  for the sequence and tree ops.
- **The edges of branches, patches and tags.** `drop()` wiped any storage
  handed to it; `branch()` opened over an existing storage and merged the
  parent into it; a fork that failed left a half-made directory for the
  retry to reuse; a merge asked only after the source's own streams, so a
  third node's ops the parent had compacted past were skipped as gaps while
  `merge()` reported success. A patch was checked more loosely than the
  method of its name, so `applyPatches()` could mint nothing and answer with
  a count; a `SyncomError` from a second op left the first committed, so a
  `restore()` could land its reset without the rebuild; the `removals` a
  patch named were kept by reference in the log; a `tags.json` line's name
  became a path under `tags/` unchecked (such a line is dropped at load,
  `tags.dropped` with `reason: 'name'`); `open('path')` opened the default
  directory in silence — `open()` takes an options object, and anything
  else is a `TypeError`.
- **A failed undo never inverts a record twice.** A throw on the third
  record of a step — a hook refusing its inverse — put the step back whole,
  though the first two were already inverted and their redo was lost; the
  next `undo()` inverted them again. A step keeps its seqs per record: on a
  failure the records taken back leave the step with their way back on the
  redo stack, and the rest wait for another try. The own seqs the manager
  kept are forgotten below its pin instead of growing for its life.
- **An unreadable `tags.json` no longer fails `open()`.** The tags are
  auxiliary, yet a torn `tags.json` failed the open like `node.json` does.
  The storage now opens without tags, keeps the file aside as
  `tags.corrupt.json` for a repair by hand, warns `tags.unreadable`,
  reports `stats().tags.corrupt` and refuses `tag()` with `CORRUPT`; every
  record changed meanwhile has its file kept once under `tags/.pending/`,
  and the next open with a readable file hands those copies to the newest
  tag, so the tags a repair brings back read as they did.
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
  `src/emitter.js`, `src/logger.js` and `src/crypto/keys.js` now, shared, and
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

- **The sequence engine is new: a copy-on-write rope.** Lists and texts stand on a copy-on-write
  B+-tree with two measures (`src/text/rope.js`), an id index from (run, offset) to a run
  (`src/text/ids.js`) and hash tries for the registers and the marks (`src/text/cow.js`); a run's
  name is parsed once per lineage, an op reads every bound before it writes and copies each node
  it touches once. The blocks, their JSON, every reading and every refusal are the old engine's,
  op for op. The B4 editing trace through `applyOp` runs at 273 000 edits a second with every
  version kept; a list op is O(log n) — setAt in a 50 000-element list 2 000 → 154 000 a second —
  its reading made when it is read. The text plugin is 3.4 KB larger.
- **A write is made at once where nothing asynchronous is set up** — no write hook, signature,
  validator, unique key, telemetry, actor function or lens, the record files deferred: appended
  before the call returns, landed and announced as its group is written (74 promises a keystroke
  became about 9). The browser makes it too: an op's header is hashed in JavaScript, at once.
- **The editor binding stands on a text handle.** `createTextBinding` no longer sends one delta at
  a time with `expect`, nor rebases a STALE one: the editor's edits are made at once over the
  handle's reading, and every other writer's change reaches the editor as a delta in its
  indices. The adapters are unchanged; a binding takes `window`.
- **`applyDelta()` counts the ops logged**, a keystroke folded into the one before it none.

- **A folder of `src/` is a zone, not only a subpath.** A module lives in the
  folder of what it is about even where the core requires it: the telemetry
  writer contract is `src/telemetry/writer.js`; the wire shape, the protocol
  constants, the link check, the outbound selection and the shared-log
  contract are in `src/sync/`; the validator's projection is
  `src/schema/entity.js`; the Quill delta algebra is `src/text/quill.js`; the
  key pairs, PEM and SHA-256 are `src/crypto/` (a zone with no subpath). The
  root of `src/` holds the core alone. No export, entry point or bundle
  changed.
- **A large text is written in pieces, not whole at every flush.** A list
  or text block of 1 024 runs or more keeps its runs in files of 512 beside
  the record file (`<id>~<n>.json`), by the order the node first named them;
  a flush writes the pieces whose runs read otherwise, the record file, and
  removes what it no longer names. A local insert grows a run of the newest
  piece alone, so a keystroke anywhere — at the start, in the middle — writes
  that piece and no other, through a handle too. A text of 25 000 inserts: a keystroke
  under `defer: 0` 33.2 ms and 3 MB written → 1.35 ms and 242 KB (8 000:
  9.1 → 0.7 ms); under the default window, at 8 000, 231 → 146 µs and
  9.7 → 0.9 KB. A read assembles the block
  whole; `file()` (a tag's copy) hands it whole; a piece gone is
  `INTEGRITY`. The kind plugin hook is `pieces(block)`.
- **A push reads what the receiver lacks, not the whole log, and a roll
  writes no index.** The log keeps its retained entries by stream; a push on
  a handshake or a recovery, a branch merge and a host's REWOUND proof pick
  from it by a binary search per stream (200 000 ops retained over 1 000
  streams: 18.7 → 0.17 ms a handshake). `index.json` names no segment any
  more — they are what the directory lists, a gap among them is
  `log.segment.missing` — and is written where compaction dropped
  something, not at every roll: with one op a group it was rewritten every
  64 ops and grew with the history (272 KB under `retention: 'all'`).
- **An editor's send no longer compares the whole text.** `applyDelta()`
  resolves to `{ ops, revision }` (it was the op count) and takes
  `revision` beside `expect`: while the field is still at that revision —
  a token per engine block, `revision(id, key)` reads it — the text is not
  compared (it was O(n), the rope flattened, on every send). A field that
  moved past it is compared as before, so `STALE` and the rebase are what
  they were. The editor binding sends the revision the last answer handed
  back while its shadow has not moved since: typing alone into a 1 MB text
  costs a send 193 µs instead of 376 µs (100 KB: 81 instead of 96).
- **The sequence engine is five modules, not one file of 2 957 lines, and the
  text plugin four.**
  `src/text/sequence.js` keeps the design and the public names; the code is
  `keys.js` (names, anchors, refusals), `state.js` (the block, hydration,
  every reading), `splice.js` (what an op does, the registers), `marks.js`
  (the marks and their index) and `join.js` (a snapshot's block normalized,
  pruned, joined), layered without a cycle. The text plugin likewise:
  `src/text/text.js` is the plugin object over `kind.js` (what the core
  calls), `diffs.js` (the patches), `methods.js` (the storage methods) and
  `deltas.js` (Quill deltas). Nothing a caller reads changed; the names that
  cross a module are not minified, so `/text` is 1.9 KB larger (31.5 →
  33.4 KB).
- **`migrate()` and `check()` are the schema plugin's, and so is
  `schema.json`.** The facade keeps a stub for each (PLUGIN_MISSING
  without the plugin, as before); the code, and the reading and writing of
  the version file, moved to `src/schema/api.js` — the core 0.7 KB lighter
  (50.8 → 50.1 KB), `/schema` 4.9 → 5.9 KB. A plugin's `setup(ctx)` gets
  `hash`, the core's SHA-256; the lent core gets `kindOf`.
- **Nothing reads a shape from before the first publication.** The wire,
  the signed header and the files are version 1 as that publication will
  have them (`PROTOCOL` 1, the header's version `1`, `enc1:` bound to its
  file name), and the readers of the shapes before it are gone: a log file
  without a hash is unreadable (`checksum`), an `index.json` with a field
  missing is no index (a new epoch, as for an unreadable one), an unbound
  `enc1:` ciphertext is `DECRYPT_FAILED`, and a hello that names no kinds
  holds none (a dialer that runs a kind does not bootstrap from it).

- **A tree move costs one step, not the tree.** Every op of a tree field
  folded every move again (a sort, the cycle walks), rendered both readings
  whole and diffed them: a move cost 2 ms at 2 000 nodes and 52 ms at
  32 000, and an 8 000-node outline built in one transaction took 44 s.
  The fold is kept per block and handed to the block an op derives from
  it: a move newest in the fold is one step, an older one undoes the newer
  moves and does them again (Kleppmann et al.'s undo–do–redo), the reading
  is path-copied and the change report comes from what the move changed —
  the same reading and report, op for op, as the full fold (a seeded
  differential test against it). A local move at 2 000 / 8 000 / 32 000
  nodes: 78 / 96 / 133 µs; the 8 000-node outline 0.25 s. The block's JSON
  is unchanged. Budgets: `/tree` 9 KB, `/all` 113.5 KB.
- **A ProseMirror keystroke costs where it is, not the document.** Every
  local edit read both documents whole and diffed them; typing, a cut or
  inline content pasted inside one textblock is now sent from its steps,
  the field index of a position summed from block sizes kept per node. A
  keystroke in 100 / 1 000 / 5 000 paragraphs: 0.27 / 2.7 / 15 ms →
  0.018 / 0.026 / 0.055 ms. Anything else is still diffed.
- **One delta algebra.** The text plugin's `toDelta` and the editor
  binding each had their own Quill-form `compose` — with different edge
  rules — and both compared a style by its JSON, so `{ bold, italic }` and
  `{ italic, bold }` stayed two ops. Both stand on `src/text/quill.js` now, which
  compares a style whatever its key order; a property test holds the laws.
- **A hub's vector is no longer copied per page.** Applying a peer's page
  copied the whole version vector (a key per client and scope — thousands
  on a hub), so did every log group (for a rollback it rarely needed), the
  host's push answer and the dialer's merge of it. A page now reads seqs
  key by key over what it moved, a group records only the keys it moves,
  and the answers merge in place: one peer's one-op page on a hub holding
  20 000 streams went from 9.6 ms to 153 µs.
- **A snapshot record is normalized once, not three times.** Joining one
  read its meta for the skew check, again for the clock and again for the
  join, hydrating its blocks each time; a peer's merge op twice. A meta its
  holder will not change (`settleMeta`) is now normalized once per object:
  joining 400 records of 2 000-character texts took 840 ms, now 550.
- **A write no longer reads its record for a scope nobody asked for.**
  Every local write merged the record with its data and composed it —
  twice — to ask a scope function, even with no `sync.scope` given; now the
  record is read only where one is, and composed once.
- **A large set no longer slows down every op of its record.** Every op
  copied every set of its record whole, walked it for the newest stamp and
  listed its keys for a kind check, and an add or a remove sorted and parsed
  the whole set again. A set field is now shared between versions until an
  op writes it, the newest stamp is carried from op to op along a record a
  write path reads (a fold no one stamps after carries nothing, so a plain
  register op costs what it did), a set's emptiness is remembered, and an add
  or a remove moves the reading by the elements it names. On a record holding 20 000 elements: a register write 5.4 ms →
  71 µs, an add 20 → 3.6 ms, a remove 19.4 → 3.1 ms (what is left is the one
  copy of the set the op writes).
- **A host refuses a push past 10 000 ops unless told otherwise.** With no
  `limits`, a peer could push a page of any length; `opsPerPush` now
  defaults to 10 000 (twenty pages of a dialer's default size), checked on
  the length before anything is read — `limits: { opsPerPush: Infinity }`
  lifts it. The bytes and the rate stay opt-in.
- **A node without a kind's plugin reports its refusals once per page.**
  A core-only hub relaying a text raised an `OP_REFUSED` and a warning per
  keystroke; the metric still counts each op (`reason: 'kind'`), and the
  warning and the error come once per page, with `count` and `kinds`. A
  bootstrap refused for `KINDS_MISMATCH` counts in `syncom.bootstraps` as
  `refused`.
- **Lost data is logged at `error`.** `log.segment.unreadable`,
  `log.open.unreadable`, `storage.unpersisted` and `tags.unreadable` were
  warnings, like a peer's refused op; they are errors now, and
  `log.open.torn` — a last line whose append was never acknowledged, so
  nothing answered is lost — is `info`. `storage.unpersisted` names the
  first 32 ids and says how many (`count`), not every id of a batch. The
  telemetry page's level column is checked against the code.
- **Marked texts, long lists, long typed runs and a cold record cost what
  the op touches.** A keystroke into a text read every mark (5 000 marks:
  3.4 ms → 31 µs): the marks' anchors are an index in walk order, kept
  across every op that leaves the marks, and pos/vals/marks live in
  persistent maps. `setAt`, `move` and `push` on a list read it whole
  (50 000 elements: 9.2 / 9.5 / 5.0 ms → 100 / 189 / 128 µs): an element's
  index comes from the rope, the reading is derived from the one before. A
  body grows by `SEG_MAX` (2 048) slots at most, so a read inside a long
  typed run no longer flattens it (200 000 characters: 7.3 → 1.4 MB held).
  A block read from a file is hydrated once (first op on a 1.75 MB record:
  322 → 153 ms). The block's JSON is unchanged. Budgets: `/all` 107 KB,
  `/text` 31.5 KB.
- **More than eight storages in a process no longer reopen their log files.**
  The `node:fs` backend held eight append descriptors for the whole process;
  a ninth log appending made them take turns opening and closing their files
  (about fifteen times the cost of a held write). It holds one per directory
  — a log appends to its newest journal alone — and 64 in all.
- **An undo manager no longer costs the record on every keystroke.** The
  `commit` event copied the record before and after every local write, and
  scanned a text for its embed slots, though an undo step keeps only its
  first `before` and its last `after`. The copies are taken at their first
  read now and the manager keeps the events, copying when it takes a step
  back: 1 027 → 76 µs per keystroke into a 400 KB text with an undo manager
  listening.
- **Marking writes applied no longer walks every open group.** The log kept
  the groups waiting for their records in a map it walked from the oldest on
  every mark, once per written position: a deferred flush of a busy window
  cost positions × groups. They are a sorted array searched by halves now —
  8 192 marks over interleaved records, 49 ms → 2.7 ms.
- **A searchable text is no longer re-indexed on every keystroke.** The
  catalog handed the text index the whole joined text of a record at every
  write; it keeps the last word per record now and hands it over when a
  `$text` query asks — 2.5 ms → 78 µs per keystroke in a 40 KB searchable
  text. A write that leaves a record's catalog row as it was (a field the
  catalog does not hold) posts nothing, saves nothing, and does not run a
  watch the catalog covers.
- **A live `Record` no longer copies the whole record on every write.** It
  took a JSON copy of the record, walked it for references and redefined its
  accessors on every change — a 200 KB text made each keystroke of another
  field cost the text. It lays the fields the write changed over what it
  holds now (a path, a lens or a read hook still take the whole reading):
  275 → 58 µs per write of a record with a 200 KB text, under the default
  window.
- **A delete no longer re-hints the whole text.** The change report of a
  splice read the stretches it cut from the block before it — after the
  splice had made the new block the head of the rope's lineage, so the old
  block was a fork, and the rope re-hinted every item of it, O(n), on every
  delete: two thirds of an editing trace's time. The cut is read while the
  old block is still the head now. The automerge-perf trace replays at
  35 600 keystrokes/s in memory (12 700 before), 25 600 with `/all`
  (11 000).
- **`src/` is written in loops.** No array method that takes a callback
  (`map`, `filter`, `find`, `some`, `every`, `flatMap`, `forEach`, `reduce`…)
  and no `Array.from` is left in the published code; `pnpm lint` refuses them
  in `src/**` (`no-restricted-properties`). Walks that ran twice run once (a
  set's added and removed elements, a transaction's ops, positions and
  signatures, a version's applied entries, purges and merges, a scrub's
  segments), membership tests inside loops are `Set`s, and a few searches
  became indexes: a list block's elements by key, a tree block's members, the
  hydration of a run's children, the cuts and extensions a join collects, a
  rope leaf's item index, the move list of a tree node (a binary search where
  it was a sort). The bundles grow with it: `/all` 98.3 → 100.7 KB min+gzip,
  `/text` 28.1 → 28.7, `/tree` 6.4 → 6.8; their budgets are raised by name.

- **A tag is read at its first use.** An open read every tag's catalog and
  copy listing, so its time grew with the tags times their records; it reads
  `tags.json` and the newest tag alone now (the one the write path copies
  into), and an older tag's catalog and copies once, at its first read.
  `at(name)` stays synchronous; its `has()` and `list()` are promises, and a
  cursor at a tag waits for the catalog. A tag whose catalog cannot be read
  is dropped at that first use, as `untag()` drops it (`tags.dropped` with
  `reason: 'catalog'`), and its reader is told `TAG_NOT_FOUND`.
- **The field kinds' API and the versions API are modules.** `storage.js`
  had grown back to 1,821 lines: `src/fields.js` (`inc` … `treeRemove`,
  `spans`, `cursor`, `index`) and `src/versions.js` (`get(id, { at })`,
  `history`, `diff`, `applyPatches`, `restore`, `compact`, `tag`, `untag`,
  `at`) run over the core Storage lends its write paths, the facade one
  delegate per method; the run-length content of a run is `src/rle.js`, out
  of `src/sequence.js`; the write API's argument checks are `src/args.js`,
  shared with `realize()` in `src/patch.js` and so with the undo subpath. No
  public name, type or message changed.
- **Browser budget 60.5 → 65 KB, under a ceiling.** The bounds above
  (62 KB), the argument checks and the rehearsal of `applyPatches()`
  (62.5 KB), the two API modules (64.5 KB — the core's property names where
  private fields minified away) and `src/rle.js` (65 KB; 64.6 measured, 65.0
  with the tags read at their first use). 64 KB was set as the v1 ceiling
  with the second review and lifted the same day for the module split; a
  raise still names its feature in `scripts/size.js`, and one of more than a
  kilobyte is a design decision, taken in a plan. `PROTOCOL` 1 is the wire
  as of the first publication: every op type and `packOps` slot added before
  it bumps nothing.
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
  the hosting side of replication in `src/sync/hosting.js` (`createUnit`), with
  `src/sync/protocol.js` for what both halves share. No public name, error
  message, event, hook signature or on-disk format changed. The browser budget was raised
  33.5 → 35.5 KB: a class's private names minify to one letter, the property
  names of a seam shared between modules do not (+2.3 KB min+gzip).

### Changed (breaking)

- **The log's files and an op's payload changed shape** (nothing is published, `PROTOCOL` stays
  1): a log file is `{"e":[[seq, fp, header, payload, rest?, flags?]],"c":"<crc32>"}`, its CRC-32
  checked before it is parsed, and a segment is the lines its groups were journaled as and a
  trailer; an op names what is its own origin's without the origin — a run by its stamp, an
  element as `ts:offset`.

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
