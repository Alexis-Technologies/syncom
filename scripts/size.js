/**
 * Honest bundle-size measurement for the README "Bundle size" table.
 *
 * Every entry from package.json#exports is bundled the way a consumer's
 * bundler would (browser condition for the browser half, plain Node
 * resolution for the node half), then reports:
 *   - raw:      bundled, un-minified
 *   - min:      fully minified (whitespace + identifier mangling + syntax,
 *               comments stripped)
 *   - min+gzip: the number that matters for shipping to browsers
 *
 * Only the entry that DOES reach a browser carries a `budget` (min+gzip KB),
 * and exceeding it fails the run, which is what keeps CI honest about bundle
 * growth. The node entry is reported for visibility, not as a shipping cost.
 *
 * Run with `pnpm size`.
 */

'use strict';

const { gzipSync } = require('node:zlib');
const path = require('node:path');
const esbuild = require('esbuild');

const ROOT = path.join(__dirname, '..');

// One row per package.json#exports entry — tests/package/consistency.test.js
// fails if the two ever drift apart.
const ENTRIES = [
  // A ratchet, not a target: raise it deliberately, in the same change that
  // earns the bytes. 5 KB was the migrated storage/chain/crdt core; the
  // replication engine (the op model, the persisted log, the sync protocol
  // that makes `storage.sync` move data) earned the raise to 14 KB; the
  // injected OpenTelemetry writer (src/telemetry/writer.js and its call sites in
  // storage, log and sync) the raise to 17 KB; hooks (src/hooks.js and the
  // write, read, apply and sync seams they run in) the raise to 18 KB; the
  // schema layer (src/schema.js: entity definitions, the injected validator
  // normalized to one shape, validation in the write and apply paths) the
  // raise to 20 KB; schema versions (the `v` slot, `meta.v`, schema.json,
  // hello.schema and drift) the raise to 20.5 KB; reading across versions
  // (the lens, migrate(), held ops) the raise to 22 KB. Moving smart
  // contracts to their own subpath gave ~0.4 KB back; the injected backend
  // (src/backend.js, durable writes) and the exclusive open (src/lock.js)
  // spent it and earned the raise to 23 KB; the record catalog
  // (src/catalog.js, the bounded cache, integrity) the raise to 24.5 KB;
  // queries (src/query.js, unique keys, watch) the raise to 26.5 KB; the
  // actor slot, hosting limits and the reserved shared-log contract the
  // raise to 27.5 KB; purge (the op, the scrub) the raise to 28 KB; the
  // trust boundary (record ids checked at every entrance, a peer's op
  // well-formed before it is read, the skew horizon, scopes enforced by the
  // host, own-key walks in ops.js) the raise to 29 KB; the failure paths (the
  // log sealing only applied batches, a failed page as a break in the
  // stream, swap inside the queue, copies at the boundary, unreadable
  // records contained) the raise to 29.5 KB; push recovery (one push chain
  // per peer, `behind` and the vector-based catch-up, the outbox bound, the
  // vector learned from the feed, the 428 cap) the raise to 30 KB; the
  // optional chain, weak live Records, catalog saves off the queue and the
  // scrub index the raise to 30.5 KB; the bootstrap page as one batch and
  // snapshots over a catalog that keeps tombstones the raise to 31 KB; the
  // operator's signals (snapshot/scrub/rebuild spans, hook and lock
  // histograms, refusal counts, five observable gauges, identity scrubbing)
  // the raise to 32 KB; introspection (stats, hosted feeds, lastError, the
  // log event, via as a descriptor) the raise to 32.5 KB; the lock knobs and
  // its exclusive create, the OPFS handle and key caches, the CORRUPT codes
  // and the query guards the raise to 33.5 KB. Splitting the 1 900-line
  // Storage into the facade and its write paths (src/commit.js, apply.js,
  // bootstrap.js over a shared `core`, entries.js, record.js, options.js,
  // hosting.js) cost ~2.3 KB with no new behaviour: a class's private names
  // minify to one letter, the property names of a seam shared between
  // modules do not — the raise to 35.5 KB buys readable modules, not bytes.
  // The error model (src/errors.js: a code constant on every operational
  // error, a reason on every wire refusal) the raise to 36 KB; top-k and
  // parallel reads in queries, candidates narrowed through $and/$or,
  // repair(id) and the log read a scoped feed moves its cursor by, the
  // raise to 37 KB (36.5 measured). Observed-remove sets — a third field
  // kind in src/ops.js: `add`/`remove` ops, a slot per element and origin,
  // their reset and merge rules — the raise to 38 KB (37.7 measured). Signed
  // ops — Ed25519 on both crypto halves, the signing pair and the node id
  // derived from it, the canonical form and three packed slots, every own op
  // signed at its three sites, the verify pre-pass over a peer's page with
  // its two refusals and the `sync.signatures` option — the raise to 40 KB
  // (39.8 measured). The search seam — an entity's `search` fields joined
  // into its catalog row (format 3), the injected TextIndex contract, `$text`
  // seeding the candidates in the index's order — the raise to 41 KB (40.7
  // measured); the index itself is the @alexify/syncom/search subpath. The
  // fixes the RxDB comparison found — scope bounds on a push, a dialer that
  // keeps its own ops until its nodes hold them, REWOUND, a record file that
  // fails after the append held and replayed — the raise to 42 KB (41.9
  // measured). The sequence engine (src/sequence.js: Fugue runs with
  // extension, run-length tombstones, pending runs and cuts, the walk, the
  // reset rule and the join) wired into ops.js as the list and text kinds —
  // the raise to 47 KB (47.0 measured); its API — splice() and push(), the
  // index resolved inside the queue, OUT_OF_RANGE, migrate() over lists and
  // texts — the raise to 48 KB (47.7 measured). The movable list — setAt()
  // and move(), a value and a position register per element, position runs
  // — the raise to 49 KB (48.9 measured). updateText() with the Myers diff
  // behind it (src/myers.js) — the raise to 50 KB (49.7 measured). Rich text —
  // marks as anchor pairs with an expand rule, the newest per key, stacking
  // marks, spans() — the raise to 51.5 KB (51.4 measured). Cursors — a place
  // that survives edits, cursor()/index() — the raise to 52 KB (51.7 measured).
  // Trees — the move log per node, the fold with the cycle check, treeMove()/
  // treeRemove(), and src/order.js in the core for a node's place among its
  // siblings — the raise to 55 KB (54.6 measured). History — a version as a
  // cut through the log, the exact start above droppedTs, the fold and the
  // present check, history()/get(id, { at }) — the raise to 56.5 KB (56.2
  // measured). Tags — tags.json, a catalog per tag, copy-on-write record
  // files at the EntryStore seam, tag()/untag()/at() — the raise to 58 KB
  // (57.7 measured; 58.0 with the views at a tag; ≈60 KB at the end of the versions epic was agreed).
  // Diff, restore, patches and the commit event (src/patch.js) — the raise to
  // 60.5 KB (60.0 measured), the end of the versions epic. The bounds of the
  // second review's first epic — slot caps on a run and a field, a run
  // extended by its origin alone, the snapshot path under the same bound,
  // orphan registers and off-placeholders counted, a fractional index
  // checked, a tree read to a depth, a malformed payload reported, the
  // `sync.pendingMax` option — the raise to 62 KB (61.7 measured). The second
  // epic — the argument checks shared with realize(), the kind clash refused
  // before any index is read, applyPatches rehearsed before the first append,
  // a merge that asks for every stream — the raise to 62.5 KB (62.0 measured).
  // 64 KB was the ceiling set with the second review (2026-10-24); the raise
  // past it was decided the same day, for the review's maintainability epic:
  // the API of the field kinds (src/fields.js) and the versions API
  // (src/versions.js) as path modules over the lent core, the facade a
  // delegate per method — the raise to 64.5 KB (64.4 measured; the shared
  // property names of the core cost what private fields minified away). The
  // run-length content as src/rle.js, out of sequence.js (the same epic) —
  // the raise to 65 KB (64.6 measured: a module's exports and requires). The
  // bugs the docs audit found (2026-10-24), fixed one commit each: a splice's
  // content checked against the field's kind before the stamp — the raise to
  // 65.5 KB (65.0 measured); compact() laying a text's marks again
  // (sequence.js marksIn, the `mark` patch, long fields in runs) — the raise
  // to 66 KB (65.6 measured). The kinds beyond registers, counters and sets
  // became plugins (src/plugin.js; `/text`, `/tree` carry the engines) — the
  // main entry is the core alone and came DOWN to 54 KB (53.4 measured); the
  // whole of it is `/all`. The identity and the signatures (`/signing`), the
  // chain (`/chain`) and the sealing of records (`/encryption`) became
  // plugins too — the core keeps the hooks and SHA-256 through Web Crypto
  // (src/crypto/digest.js) — and came down to 52 KB (51.4 measured). The rule
  // stays: a raise names its feature here.
  // 52.8 with a write made at once (Storage#fastCommit, src/commit.js commitAtOnce, the log's enqueue, events
  // dispatched; 2026-10-31). 53, raised by name.
  // 53.1 with the log's lines: positional entries, the header text made once, a CRC-32 checked before the
  // parse (src/crc32.browser.js). 53.5, raised by name.
  // 53.8 with a field read when it is read (src/lazy.js). 54, raised by name.
  // 54.2 with keystrokes made at once grown into the op before them (coalesced, log.lastGathered). 54.5,
  // raised by name.
  // 54.6 with what a text handle stands on (core.editing, core.on, a transaction's commitResolved). 55, raised by name.
  // 55.5 with SHA-256 in JavaScript (src/crypto/sha256.js), so the browser makes a write at once. 56, raised by name.
  // 56.1 with the handles followed through one listener of the storage's, every handle flushed before a flush(), a
  // tag(), a close(), a compaction, a restore or a patch, a hook's context for an edit made elsewhere, and a write
  // that adds a `$type` kept off the fast path (review №4, E2). 56.5, raised by name.
  // 56.5 (over by bytes) with the writes counted by path (`stats().commits`, `syncom.path`), the handles' flushes
  // recorded, a peer's `actor` and `from` bounded, and one close (review №4, E3–E6). 57, raised by name.
  // 57.1 with the rename to Database / Collection / Document (`createDatabase`, `document()`) and the pre-rename
  // names kept as aliases until 1.0 (engines plan, E0). 57.5, raised by name.
  // 58.6 with the engine contract (src/engine.js) and the files engine (src/files/files.js) the core opens every fsi
  // through — a seam's property names do not minify (engines plan, E1). 59, raised by name.
  // 59.3 with the log's medium behind a store (src/files/journal.js: load, append, seal, sealed, drop, saveIndex, scrub;
  // engines plan, E1.2). 59.5, raised by name.
  // 59.7 with the database opened through its engine: the stores behind EntryStore, the catalog, the lock, the
  // identity, the tags and the chain; `createDatabase({ engine })` (engines plan, E1.3). 60, raised by name.
  // 60.6 with a follower (`readOnly`: src/readonly.js, the change stream heard) and an engine's lease (`db.lock`,
  // LEASE_LOST; engines plan, E5). 61, raised by name.
  // 61.0 with a follower refused over an engine that is not shared and from hosting, and a lost lease fenced
  // locally — the stores and the log's medium swapped for the read-only ones, every landing after it held
  // (review №5, E2: R-4, G-2, S-2). 62, raised by name.
  // 62.1 with the keys of the contract checked where they become a file name or a filter (src/engine.js isKvKey,
  // checkWriteSet; review №5 S-3/S-5) — a seam's property names do not minify; both together 63. 63.5, raised by name.
  // 63.5 with one read a record (pieces.getMany, a page of records at a time) and the engine measured (stats().engine;
  // review №5 P-3/P-4/O-4). 64, raised by name.
  // 64.1 with collections defined after the open (`collections`, `addCollections()`, `removeCollection()`,
  // `Catalog.define`) and the catalog's action stream (collections plan, C1.1). 64.5, raised by name.
  // 65.2 with records named by their data (composite ids, the id field as the id, EXISTS), the bulk writes,
  // `upsert()`/`insertIfAbsent()` and IN_TRANSACTION (collections plan, C1.2–C1.3). 65.5, raised by name.
  // 66.9 with the update operators (src/operators.js, `operate`) and `ifMatch` (collections plan, C1.5). 67, raised by name.
  // 67.0 with `delete(id, { data })` and a revival's resets; declared references, `populate()` (collections plan,
  // C1.7–C1.8). 67.5, raised by name.
  // 67.7 with an entity's methods and statics and the collection events (collections plan, C1.9–C1.10). 68, raised by name.
  // 68.2 with `collection.remove()`, `drop()`/`dropDatabase()` and src/layout.js (collections plan, C1.11). 68.5, raised by name.
  // 68.8 with the catalog's sorted indexes (compound keys, `scan`) and `compare` shared, an array keyed per element (collections plan, C3.1). 69.5, raised by name.
  // 69.8 with folded tombstones (Catalog.fold, EntryStore.fold, the row rebuilt on a read; collections plan,
  // C4.5) and the transaction event's eventId. 70, raised by name.
  // 70.0 with a tombstone's row keeping its collection and the stamp of its delete (catalog FORMAT 5; review №6, E1.1;
  // 2026-11-02). 70.5, raised by name. 70.5 with the folded tombstones in the `tombstones` kv namespace (EntryStore.foldMany,
  // the fallback read, the rebuild over both stores; review №6, E1.2–E1.3). 71, raised by name.
  // 71.0 with a row's id laid last, writes by query matched again inside the queue, drop() under the lock, dropDatabase()
  // refusing a stray directory, composite ids refused on the separator and immutable (ID_IMMUTABLE), EXISTS by
  // `expect: ABSENT` (review №6, E2). 71.5, raised by name.
  // 72.7 with the catalog's sorted indexes on SortedIndex (src/sorted.js, chunked sorted arrays: 1.2 of it), a put that
  // re-keys only the indexes a changed field belongs to, load/define/adopt built once (review №6, E4.2; the design
  // estimated 0.6 less). 73, raised by name.
  // 73.0 with a scan that seeks a page's edge and yields lazily, a one-sided range closed at its kind's edge (review №6,
  // E4.4). 73.5, raised by name.
  // 73.5 with the planner's cost model, a plan that follows the definitions, a path split once (review №6, E4.5–E4.8).
  // 74, raised by name.
  // 74.2 with the unique keys in flight kept in a map, a purge's ids scrubbed together, remove() over the ids as the
  // call began (review №6, E5.1, E5.5; 2026-11-02). 74.5, raised by name.
  // 74.7 with the collection's events on a microtask, the unique keys in maps, one operator per field, a query's depth
  // bound (review №6, E6; 2026-11-02). 75, raised by name.
  // 75.1 with the writer's record methods, the stats fields, the error fields and the log lines of E7 (review №6, E7; 2026-11-02). 75.5, raised by name.
  // 75.5 (over by bytes) with a peer's register write that lost told as a conflict (applyFields' `lost`, apply.js
  // reportLost; sync-parity plan, S1; 2026-11-06). 76, raised by name.
  { label: 'main entry — browser (@alexify/syncom)', entry: 'browser.js', platform: 'browser', budget: 76 },
  { label: 'main entry — node (@alexify/syncom)', entry: 'index.js', platform: 'node' },
  // Platform-neutral (no node builtins, no browser-only globals): one file
  // serves both, bundled as a browser entry so the self-contained check
  // guards it too.
  { label: 'wrpc adapter — browser (@alexify/syncom/wrpc)', entry: 'src/wrpc/wrpc.js', platform: 'browser', budget: 2 },
  // Smart contracts: off the main entry on purpose (a `new Function` over
  // chain data), so a node that never imports the subpath never pays for it
  // — in bytes or in attack surface.
  {
    label: 'contracts — browser (@alexify/syncom/contracts)',
    entry: 'src/contracts/contracts.js',
    platform: 'browser',
    budget: 1,
  },
  // The IndexedDB backend: browser-only by nature, its own row so the main
  // entry pays nothing for it.
  // 2 was the file store alone. The engine over object stores (src/idb/engine.js: six stores, key ranges, one transaction per
  // write set, the log's rows, a BroadcastChannel; engines plan, E3). 6, raised by name.
  { label: 'idb backend — browser (@alexify/syncom/idb)', entry: 'src/idb/idb.js', platform: 'browser', budget: 6 },
  // The engine over SQLite (src/sqlite/sqlite.js): node:sqlite required inside the factory, so a node-only row with no
  // browser budget (engines plan, E4).
  { label: 'sqlite engine — node (@alexify/syncom/sqlite)', entry: 'src/sqlite/sqlite.js', platform: 'node' },
  // The engine over MongoDB (src/mongodb/mongodb.js): the driver injected, node-only, no browser budget (engines plan, E5).
  { label: 'mongodb engine — node (@alexify/syncom/mongodb)', entry: 'src/mongodb/mongodb.js', platform: 'node' },
  // An engine over a message port (serveEngine/remoteEngine/connectEngine) and a copy between engines (copyEngine):
  // platform-neutral, measured as a browser entry (engines plan, E6–E7). 9.1 with the served side checking every
  // call against the contract (a table of stores, methods and their arguments), the port's death and a timeout heard
  // (ENGINE_UNREACHABLE, stats()), and a copy that lands the identity last and takes a failure away (review №5 E1).
  // 9.5, raised by name. 9.7 with a lease's life crossing the port (gen, expiresAt, its events; review №5 O-2). 10, raised by name.
  {
    label: 'engines — browser (@alexify/syncom/engines)',
    entry: 'src/engines/engines.js',
    platform: 'browser',
    budget: 10,
  },
  // The trigram text index behind `$text`: platform-neutral, off the main
  // entry so a node that never searches pays nothing for it.
  { label: 'search — browser (@alexify/syncom/search)', entry: 'src/search/search.js', platform: 'browser', budget: 2 },
  // Fractional indexes for ordering records: a helper off the main entry.
  { label: 'order — browser (@alexify/syncom/order)', entry: 'src/order/order.js', platform: 'browser', budget: 1.5 },
  // The undo manager with the patch vocabulary, Myers, the argument checks
  // realize() shares with the write API (src/args.js) and the Emitter it
  // stands on — measured alone; in an app bundle those are shared with the
  // core. 6 KB since the shared checks (5.9 measured); 6.5 KB since the
  // `mark` patch (6.0 measured).
  // 6.5 with the unset patch and the loose inverse per field.
  // 7.4 with the paths (a reading taken back to its fields, src/compose.js).
  // 7.8 with transaction steps, groups, step meta and the scoped stack (trackedSources, records, paths).
  // 8.0 with the canonical JSON in shape.js.
  { label: 'undo — browser (@alexify/syncom/undo)', entry: 'src/undo/undo.js', platform: 'browser', budget: 9 },
  // A fork opened through the parent's constructor, merged as ops: the
  // selection a push makes, the shape helpers, the protocol constants.
  {
    label: 'branch — browser (@alexify/syncom/branch)',
    entry: 'src/branch/branch.js',
    platform: 'browser',
    // 3.6 measured once ValidationError moved into the errors module it shares.
    // 4.0 with the canonical JSON in shape.js.
    // 4.6 with the log's stream index (a push and a merge pick by stream; 2026-10-27). 5, raised by name.
    budget: 5,
  },
  // Presence: the emitter, the bounds, the signed entries; the identity comes from the storage.
  // 4.5 (over by bytes) with the writer's new record methods it bundles (review №6, E7; 2026-11-02). 4.75, raised by name.
  {
    label: 'presence — browser (@alexify/syncom/presence)',
    entry: 'src/presence/presence.js',
    platform: 'browser',
    // 3.8 measured: shape.js (the canonical JSON, the stream and key checks) comes with the emitter.
    budget: 4.75,
  },
  // The editor binding: deltas composed and transformed, the diff between two readings (the text plugin's Myers
  // comes along, and the vector keys), the binding itself, selections and presence cursors. The plan said 4; the
  // transform and the diff are what an editor needs, so 6, raised by name (4.9 measured).
  {
    label: 'editor — browser (@alexify/syncom/editor)',
    entry: 'src/editor/editor.js',
    platform: 'browser',
    // 6.0 with a send's revision (the shadow's version, the answer held for). 6.5, raised by name.
    budget: 6.5,
  },
  // The CodeMirror adapter: the editor binding it stands on (4.9), a ChangeSet as a delta and back, the cursors'
  // decorations, the undo commands. CodeMirror itself is injected, never bundled. The plan said 3; the binding
  // under it is most of it, so 7, raised by name (6.6 measured).
  {
    label: 'codemirror — browser (@alexify/syncom/codemirror)',
    entry: 'src/codemirror/codemirror.js',
    platform: 'browser',
    // 7.5 with what the adapters share (createFit, undoSteps, failureReporter in editor.js; 2026-10-27). 8, raised by name.
    budget: 8,
  },
  // The ProseMirror adapter: the editor binding it stands on (4.9) and the document as one text with block
  // markers, the replace step, the cursors' decorations, the undo commands. ProseMirror itself is injected, never
  // bundled. The plan said 6; the binding under it is most of it, so 8, raised by name (7.5 measured).
  {
    label: 'prosemirror — browser (@alexify/syncom/prosemirror)',
    entry: 'src/prosemirror/prosemirror.js',
    platform: 'browser',
    // 8.6 with the one delta algebra it shares with the text plugin (src/text/quill.js; 2026-10-27). 9, raised by name.
    // 9.0 with an edit sent from its steps (block sizes kept per node). 9.5, raised by name.
    budget: 9.5,
  },
  // Framework stores: one object for Svelte's contract and React's useSyncExternalStore, over a cursor, a
  // Record, get(), a presence or any emitter; no requires.
  {
    label: 'store — browser (@alexify/syncom/store)',
    entry: 'src/store/store.js',
    platform: 'browser',
    budget: 1.5,
  },
  // The inspector: a record's anatomy and an anonymized copy; the composition, the shapes and the hash come along (4.6 measured).
  {
    label: 'inspect — browser (@alexify/syncom/inspect)',
    entry: 'src/inspect/inspect.js',
    platform: 'browser',
    // 5.0 with own() from shape.js and the checksum's reused buffer (2026-10-27). 5.5, raised by name.
    budget: 5.5,
  },
  // Everything in one import: the core with the text and tree plugins
  // registered — what the main entry was before the kinds became plugins.
  // 68.5 KB: what the 66 KB entry was, plus the registry and the plugins'
  // own module shells (68.0 measured).
  // The core with every shipped plugin: 68.3 at the kinds epic, 70.2 with
  // the at-rest wrapper and the plugin seams of the security blocks, 71.3
  // with the sync plugin's seam and the layered backend, 72.2 with the
  // schema, telemetry and query seams.
  // 79.8 with the rope under the sequence engine (the persistent tree, map
  // and chunked list it is made of, the walk and the hydration), 81.0 with
  // the group commit, the queue freed at the append and the public flush.
  // 82.0 with unset (the per-field reset), compareVectors and the surrogate rule.
  // 83.6 with field paths (src/paths.js, src/compose.js) and the prefix rules.
  // 85.3 with the children of a list's elements and a tree's nodes (the
  // members' seam, a compaction in rounds).
  // 87.3 with embeds and blocks in a text (the markers, the typed spans and
  // blocks, the diff context, the commit event's embeds).
  // 88.6 with transactions (transact in src/commit.js, the facade's tx, the message slot).
  // 90.2 with the change reports (applyOp changes, the plugins' changeOf, the transaction event).
  // 92.0 with observe, the deltas (toDelta's compose, applyDelta) and the cursor positions.
  // 94.6 with presence carried by the sync plugin.
  // 96.5 with a fork at any version (atVersion) and blame.
  // 98.3 with the change reports exact under concurrency (a mark less what newer ones hold, a marker set
  // in the turn that inserted it). 98.5, raised by name.
  // 100.7 with src/ in procedural loops (no array callbacks — a loop is longer than a callback; 2026-10-26). 101, raised by name.
  // 101.1 with a contained telemetry writer and a log that answers every durable group (2026-10-26). 101.5, raised by name.
  // 101.6 with the review's performance fixes (a lazy commit event, the lazy text index, the log's pending groups
  // searched by halves, a live Record patched by its delta). 102, raised by name.
  // 102.8 with the review's security fixes (merge-meta skew, own streams moved only with proof, a nesting bound) and the editors' containment (2026-10-26). 103.5, raised by name.
  // 103.6 with the tree's bounded fold and the counters per stream. 104.5, raised by name.
  // 106.4 with the text engine's indexes (the marks by anchor in walk order, pos/vals/marks in persistent maps,
  // a list's reading derived from the one before, bodies capped at SEG_MAX, one hydration per plain block;
  // 2026-10-27). 107, raised by name.
  // 108.0 with a hash chain per stream (src/header.js: the fingerprint, `prev`, the fork refused as
  // EQUIVOCATION; the log's fingerprints and heads). 108.5, raised by name.
  // 108.6 with presence refusals reported, unreadable log files kept and failing the open, a scrub that rewrites
  // what it takes and an op on a purged record stripped before the append (2026-10-27). 109, raised by name.
  // 109.1 with a bootstrap's pages checked (BAD_PAGE), a default opsPerPush and kind refusals reported once a
  // page. 110, raised by name: room for the review's remaining fixes, measured again at the end of it.
  // 110.4 with sets shared between versions, a hub's vector read key by key, the log's groups and the deferred
  // window measured (stats, three gauges, three instruments). 111.5, raised by name.
  // 113.0 with the tree's kept fold (+1.6) and a ProseMirror edit sent from its steps. 113.5, raised by name.
  // 114.6 with the sequence engine in five modules (src/text/{keys,state,splice,marks,join}.js: the names that
  // cross a module stay whole; 2026-10-27). 115, raised by name.
  // 115.3 with the text plugin in four modules beside it (src/text/{kind,diffs,methods,deltas}.js). 115.5, raised by name.
  // 115.5 with a field's revision (applyDelta's fast path past `expect`, the binding's send). 116, raised by name.
  // 117.1 with a large block written in pieces (src/entries.js, the text plugin's `pieces`). 117.5, raised by name.
  // 117.6 with the write path's first pieces at once (events dispatched, a cheap prepare, a hold and an announce
  // without a promise; 2026-10-31). 118.5, raised by name: room for the fast path, measured again at its end.
  // 118.6 with a write made at once (the fast path itself). 119, raised by name.
  // 119.3 with the log's lines and segments of them (a CRC-32 checked before the parse, positional entries, a
  // segment the journaled lines and a trailer). 120, raised by name.
  // 120.3 with a list read when it is read and keystrokes coalesced. 121, raised by name.
  // 122.6 with the synchronous text handle; 123.2 with an op's own references short (src/text/kind.js fullRefs).
  // 123.5, raised by name. 124.1 with SHA-256 in JavaScript (src/crypto/sha256.js), so the browser makes a write at once. 124.5, raised by name.
  // 124.6 with the editor binding on a handle (the handle's embeds and spans, a run's offsets reserved). 125,
  // raised by name. 128.3 with the v2 sequence engine (a copy-on-write rope, the id index, the hash tries, names
  // interned per lineage; v1's persistent tree, map and lists gone). 128.5, raised by name. 128.7 with a large
  // block's pieces by run number and a word typed backward folded by a handle. 129, raised by name.
  // 129.3 with the handles followed through one listener of the storage's, a flush cancelled behind one that could
  // not be logged, and every handle flushed at a flush(), a tag() and a close() (review №4, E2). 129.5, raised by name.
  // 129.8 with a handle's delta checked whole first, its keystrokes one change, a hook's context for its edits, the
  // handles reset by a repair, and a write that adds a `$type` kept off the fast path. 130, raised by name.
  // 130.0 (over by bytes) with a peer's `actor` and `from` bounded (MAX_ACTOR), a write made at once with a promise
  // of its own and its entry settled whatever the slot did, one close, the browser halves' buffers let go of past a
  // megabyte, and a log file told altered or torn by its shape (review №4, E3–E4). 130.5, raised by name.
  // 130.5 (over by bytes) with a failed append's line taken out of its journal, the index's counter kept, the
  // evidence copies scrubbed by a purge, a once listener added during an emit kept, and the writes counted by
  // path (review №4, E6, E9). 131, raised by name.
  // (E1, the engine agent) block's pieces by run number and a word typed backward folded by a handle. 129, raised by name. 129.1 with
  // (E1, the engine agent) the engine's bounds read before anything is written (a parked extension against MAX_RUN and MAX_FIELD, a cut's
  // (E1, the engine agent) ranges against MAX_CUTS and merged for the report) and its pending work counted as it comes (2026-10-31).
  // (E1, the engine agent) 129.5, raised by name.
  // 131.1 with the engine's bounds (E1, above) and the write path's, the handle's and the log's fixes (E2–E9) in one
  // bundle. 131.5, raised by name — M-3/M-6 (the folds written once, the two B+-trees sharing their node code) are
  // what should give some of it back.
  // 131.5 (over by bytes) with state.js split where its seams are clean — the names (src/text/names.js) and a peer's
  // block normalized (src/text/normalize.js), names across modules unminified (review №4, M-4). 132, raised by name.
  // 133.4 with the engine contract and the files engine in the core (engines plan, E1). 133.5, raised by name.
  // 134.1 with the log's store seam (engines plan, E1.2). 134.5, raised by name.
  // 136.1 with the engine in memory (src/memory/engine.js; engines plan, E2). 136.5, raised by name.
  // 137.0 with the follower and the lease (engines plan, E5). 137.5, raised by name.
  // 138.7 with atRest over an engine (src/encryption/at-rest-engine.js; engines plan, E6). 139, raised by name.
  // 139.0 with a lost lease fenced locally, the lease's renewals heard (`lease` events, `stats().lock`) and a
  // follower refused from hosting (review №5, E2: S-2, R-7, O-2, G-2). 140, raised by name.
  // 139.9 with the keys of the contract checked in the core (review №5 E1, see the main entry). 140.5, raised by name.
  // 140.6 with the catalog's delta, the at-rest place and base64 in chunks (review №5 E4); both branches together
  // 141.4. 142, raised by name. 142.0 with a follower's counts (stats().follow; review №5 O-6). 142.5, raised by name.
  // 142.7 with collections defined after the open (collections plan, C1.1). 143, raised by name.
  // 143.9 with named ids, the bulk writes and upserts (collections plan, C1.2–C1.3). 144.5, raised by name.
  // 145.7 with the update operators and `ifMatch` (collections plan, C1.5). 146, raised by name.
  // 146.0 with `delete(id, { data })`, the writes by query, declared references (collections plan, C1.6–C1.8). 147, raised by name.
  // 147.4 with methods, statics and the collection events (collections plan, C1.9–C1.10). 148, raised by name.
  // 148.4 with collection.remove/drop, immutable cursors and the six query operators (collections plan, C1.11–C2.1).
  // 149, raised by name.
  // 150.1 with live queries kept by event-reduce, watchCount and the query cache (collections plan, C2.2). 150.5,
  // raised by name.
  // 151.2 with keyset paging, distinct/countBy and nearest (collections plan, C2.3). 151.5, raised by name.
  // 152.8 with compound indexes, the planner and explain() (collections plan, C3.1–C3.2). 153.5, raised by name.
  // 153.8 with the local plugin registered (collections plan, C4.1). 154.5, raised by name.
  // 154.6 with a tombstone's row typed and stamped (review №6, E1.1; 2026-11-02). 155, raised by name.
  // 155.1 with the folded tombstones in the `tombstones` kv namespace (review №6, E1.2–E1.3). 155.5, raised by name.
  // 155.5 with the writes made safe (review №6, E2). 156, raised by name.
  // 157.5 with the sorted indexes on SortedIndex (review №6, E4.2). 158, raised by name.
  // 158.1 with the lazy, seeking scan (review №6, E4.4). 158.5, raised by name.
  // 159.2 with the planner's cost model (review №6, E4.5). 159.5, raised by name.
  // 159.8 with the unique keys of the records in flight and of a transaction's own kept in maps (review №6, E5.1;
  // 2026-11-02). 160, raised by name.
  // 160.2 with the query cache per collection and the live delivery (review №6, E5.2–E5.3). 160.5, raised by name.
  // 160.5 with a purge's ids scrubbed together through the log and the tags (review №6, E5.5). 161, raised by name.
  // 161.3 with the events, the guards and the bounds of E6 (review №6, E6). 161.5, raised by name.
  // 162.3 with the blocks recording their work (review №6, E7). 162.5, raised by name.
  // 165.9 with the shared log (src/sync/shared.js: the relay, the consumer, a read-only hub's shadow vector and its
  // forwarded pushes; the feed and the positioned snapshot in hosting.js; sync-parity plan, S0; 2026-11-04). 166.5,
  // raised by name.
  // 167.1 with one-way links, a host's `allow`, the idle page and the awaits, register conflicts (sync-parity plan,
  // S1; 2026-11-06). 167.5, raised by name.
  // 169.6 with the host's rules and the dialer's (authorizeWrite, beforeSend, prove, revoke, query/count, forget;
  // sync-parity plan, S1; 2026-11-06). 170, raised by name.
  { label: 'all — browser (@alexify/syncom/all)', entry: 'src/all/all.js', platform: 'browser', budget: 170 },
  // The list and text kinds alone: the sequence engine over its rope
  // (src/text/rope.js, ids.js, cow.js), its patches and its methods;
  // in an app bundle the core they stand on is shared (21.4 measured).
  // 22.1 with the surrogate rule (the code-point diff, the refused indexes).
  // 22.6 with the field-path check every method takes (src/paths.js).
  // 24.6 with embeds and blocks: the markers, the six methods, the typed
  // spans and the diff that carries a slot's marker.
  // 25.2 with the change reports (changeOf: a splice's spans, marks, moves; S.spanOf).
  // 26.7 with the deltas (a Quill compose, toDelta, applyDelta) and the cursor positions.
  // 27.6 with the editor binding's needs: a cut read as one splice per stretch (spansOf), an insert's marks
  // in its change and exact in applyDelta, applyDelta's `expect` (STALE). 28, raised by name.
  // 28.1 with a mark's change less what newer marks of its key hold (S.newerRanges) and a marker set in
  // the turn that inserted it composed into the insert. 28.5, raised by name.
  // 28.7 with src/ in procedural loops (no array callbacks — a loop is longer than a callback; 2026-10-26).
  // 30.9 with the engine's indexes (the marks by anchor, persistent pos/vals/marks, a list's reading
  // derived, bodies capped at SEG_MAX, one hydration per plain block; 2026-10-27). 31.5, raised by name.
  // 32.8 with the engine in five modules (the names that cross a module are not minified). 33, raised by name.
  // 33.4 with the plugin in four modules beside text.js. 33.5, raised by name.
  // 33.6 with revision() and applyDelta's revision. 34, raised by name.
  // 34.1 with a list's reading made when it is read (deriveLater; 2026-10-31). 34.5, raised by name.
  // 36.8 with the synchronous text handle (src/text/handle.js, openText) and keystrokes coalesced; 37.4 with an op's
  // own references short (src/text/kind.js fullRefs). 37.5, raised by name. 37.7 with the handle's embeds and spans
  // and a run's next offset reserved while a handle is open (extendsRun). 38, raised by name. 38.2 with what a handle's
  // edit made carried to its flush. 38.5, raised by name. 41.6 with the v2 sequence engine (src/text/rope.js, ids.js,
  // cow.js and the state that stands on them, in place of v1's btree.js, pmap.js, plist.js). 42, raised by name.
  // 42.1 with the pieces by run number (tokens per piece, the quiet writes) and a handle's word typed backward
  // folded (prepends). 42.5, raised by name.
  // 42.7 with a handle's flushes cancelled behind one that could not be logged, a prepend held to the turns heard, a
  // delta checked whole first, keystrokes one change, the reservations per field (review №4, E2). 43, raised by name.
  // (E1, the engine agent) folded (prepends). 42.5, raised by name. 42.5 with the bounds read before anything is written (a parked
  // (E1, the engine agent) extension against MAX_RUN and MAX_FIELD, a cut's ranges against MAX_CUTS and merged for the report) and the
  // (E1, the engine agent) pending work counted as it comes (2026-10-31). 43, raised by name.
  // 43.3 with the engine's bounds (E1: a parked extension against MAX_RUN and MAX_FIELD, a zero-slot run left out, a
  // cut's ranges against MAX_CUTS and merged for the report, the pending work counted as it comes, a block rebuilt
  // once per base, MAX_MARKS) beside the handle's fixes (E2) in one bundle. 43.5, raised by name.
  // 43.5 (over by bytes) with a join that is the same on every node whatever a forged picture differs in under one
  // key (the lesser text wins; SEQ-13). 44, raised by name.
  { label: 'text — browser (@alexify/syncom/text)', entry: 'src/text/text.js', platform: 'browser', budget: 44 },
  // The tree kind alone, with the fractional indexes a place is made of and
  // the argument checks it shares with the core (5.1 measured).
  // 5.5 with the field-name check unset shares with it (src/args.js).
  // 5.9 with the field-path check (src/paths.js).
  // 6.1 with a node's data (the members' seam).
  // 6.3 with the change reports (treeChanges: the placements before and after).
  // 6.8 with src/ in procedural loops (no array callbacks — a loop is longer than a callback; 2026-10-26).
  // 8.6 with the fold kept per block and moved one step a move (the undo–do–redo of an older one, the reading
  // path-copied, the change report from what the move changed; 2026-10-27). 9, raised by name.
  { label: 'tree — browser (@alexify/syncom/tree)', entry: 'src/tree/tree.js', platform: 'browser', budget: 9 },
  // The security blocks, each measured ALONE — with the shape checks, the
  // PEM pair, the backend contract and the errors it shares with the core,
  // which an app bundle holds once (4.2 / 2.0 / 3.6 measured; what each
  // adds to the core is the difference `/all` shows).
  // Signed ops: the Ed25519 half, the canonical form and the verdict.
  // 4.5 with src/ in procedural loops (no array callbacks — a loop is longer than a callback; 2026-10-26) (a hex table in the browser half).
  // 5.1 with the keys no one holds refused (the points of small order, a y past the prime). 5.7 with the op's
  // header hashed in JavaScript (src/crypto/sha256.js, through src/header.js). 6, raised by name.
  {
    label: 'signing — browser (@alexify/syncom/signing)',
    entry: 'src/signing/signing.js',
    platform: 'browser',
    // 6.3 with the key pair read through a store (src/engine.js kvNamespace/fsiNamespace; engines plan, E1.3). 6.5, raised by name.
    // 6.6 with the engines' shared errors beside the contract (src/engine.js unreadableRecord, eexist; review №5 M-4). 6.75, raised by name.
    budget: 6.75,
  },
  // The chain: the blocks, SHA-256 through Web Crypto, the plugin. 2.9 with the digest module's SHA-256 in JavaScript,
  // which the chain does not call (a browser split of its own was not worth 0.4 KB). 3, raised by name.
  // 3.4 with the blocks in a store — the database's `blockchain` namespace, or a directory (engines plan, E1.3). 3.5, raised by name.
  // 3.6 with the contract's keys (src/engine.js isKvKey, KV_NAMESPACES; review №5 E1). 3.75, raised by name.
  // 3.8 with the `tombstones` namespace among the contract's keys and a tombstone's row typed and stamped (review №6, E1.1;
  // 2026-11-02). 4, raised by name.
  { label: 'chain — browser (@alexify/syncom/chain)', entry: 'src/chain/chain.js', platform: 'browser', budget: 4 },
  // Sealed records (the RSA half) and the at-rest wrapper (AES-GCM, PBKDF2).
  // 4.1 with the key pair read through a store (engines plan, E1.3). 4.5, raised by name.
  // 5.7 with atRest over an engine (src/encryption/at-rest-engine.js: every store's value sealed, the log's entries and
  // index; engines plan, E6). 6, raised by name.
  // 6.2 with the place bound to the database too (the path in the additional data; review №5 S-6) and base64 made in
  // chunks (P-7). 6.5, raised by name.
  {
    label: 'encryption — browser (@alexify/syncom/encryption)',
    entry: 'src/encryption/encryption.js',
    platform: 'browser',
    budget: 6.5,
  },
  // The backends as blocks: the Map in memory; the multi-level cache over
  // several (with the contract check it shares with the core).
  {
    label: 'memory — browser (@alexify/syncom/memory)',
    entry: 'src/memory/memory.js',
    platform: 'browser',
    // 0.75 was the Map behind five functions. The engine in memory (src/memory/engine.js: the stores, the log's rows,
    // the catalog's rows kept as they are; engines plan, E2). 3 (2.9 measured), raised by name.
    // 3.2 with the contract's keys (src/engine.js isKvKey, KV_NAMESPACES) and a scrub that swaps a wrapper's copies
    // (review №5 E1). 3.25, raised by name.
    // 3.3 with the engines' shared errors beside the contract (review №5 M-4). 3.5, raised by name.
    budget: 3.5,
  },
  {
    label: 'layered — browser (@alexify/syncom/layered)',
    entry: 'src/layered/layered.js',
    platform: 'browser',
    budget: 1.5,
  },
  // The sync of ops: the manager and the hosting unit, measured ALONE with
  // the op model (packOps), the vectors, the hooks, the scopes and the
  // telemetry writer they share with the core (17.7 measured; what it adds
  // to the core is the 6.8 KB the main entry came down by).
  // 20.4 with presence: the unit's inbound event, the room's memory, the manager's carrying.
  // 21.1 with a contained telemetry writer and a log that answers every durable group (2026-10-26).
  // 22.5 with the review's sync fixes: proof for own streams, the hash chain's heads, presence refusals reported,
  // a bootstrap's pages checked (BAD_PAGE, maxPageBytes; 2026-10-27). 23, raised by name.
  // 23.0 with sets shared between versions (the core's ops.js it bundles). 23.5, raised by name.
  // 25.4 with the shared log (src/sync/shared.js), one-way links, the awaits, a host's rules — authorizeWrite,
  // prove, revoke, query/count — and the dialer's beforeSend and revert (sync-parity plan, S0–S1; 2026-11-06).
  // 25.5, raised by name.
  { label: 'sync — browser (@alexify/syncom/sync)', entry: 'src/sync/sync.js', platform: 'browser', budget: 25.5 },
  // The schema: the definitions read once, the validator adapters, the lens.
  // 4.3 with a set folded back by path (src/schema/entity.js over src/paths.js).
  {
    label: 'schema — browser (@alexify/syncom/schema)',
    entry: 'src/schema/schema.js',
    platform: 'browser',
    // 4.6 with the canonical JSON in shape.js.
    // 5.9 with migrate(), check() and schema.json moved out of the core (the
    // main entry 50.8 → 50.1; 2026-10-27). 6, raised by name.
    // 6.0 (over by bytes) with a peer's `actor` and `from` bounded in shape.js (MAX_ACTOR; review №4, E4). 6.5,
    // raised by name.
    // 6.6 with the id named by the data, a composite id and the declared references read off a schema's relations
    // (collections plan, C1.2–C1.8). 7, raised by name.
    budget: 7,
  },
  // The OpenTelemetry adapter: the tracer and meter resolved, the instruments, the gauges.
  // 4.1 with nine instruments more — the query cache, live changes, plans, bulk rows, pipeline turns and lag, cleanup, dumps, named inserts (review №6, E7; 2026-11-02). 4.5, raised by name.
  {
    label: 'telemetry — browser (@alexify/syncom/telemetry)',
    entry: 'src/telemetry/telemetry.js',
    platform: 'browser',
    budget: 4.5,
  },
  // Queries: the predicate, the planner and the cursor, measured ALONE with
  // the catalog's value keys it shares with the core.
  // 6.0 with src/ in procedural loops (no array callbacks — a loop is longer than a callback; 2026-10-26).
  // 7.0 with the catalog persisted through a store (src/engine.js kvNamespace/fsiNamespace; engines plan, E1.3). 7.5, raised by name.
  // 7.6 with `Catalog.define` and the action stream (collections plan, C1.1). 7.8, raised by name.
  // 7.9 with the write terminals (update/modify/delete by query) and `matches` (collections plan, C1.5–C1.6). 8.2, raised by name.
  // 8.3 with a page's references populated (`populate`; collections plan, C1.8). 8.5, raised by name.
  // 8.7 with immutable builders, `$type`/`$size`/`$mod`/`$all`/`$elemMatch`/`$nor` and `matches` (collections plan, C2.1). 9, raised by name.
  // 10.3 with live queries kept by event-reduce (src/query/live.js), `watchCount` and the query cache
  // (src/query/cache.js; collections plan, C2.2). 10.5, raised by name.
  // 11.3 with keyset paging (`page`/`after`), `distinct`/`countBy` and `nearest` over src/search/distance.js
  // (collections plan, C2.3). 11.5, raised by name.
  // 12.8 with the planner (src/query/plan.js), `explain()` and the catalog's sorted indexes it reads (collections plan,
  // C3.1–C3.2). 13.5, raised by name.
  // 14.9 with the catalog it is measured with standing on SortedIndex (src/sorted.js, bundled alone here; in an app the
  // core shares it) (review №6, E4.2). 15, raised by name.
  // 15.5 with the cursor pulling a lazy scan, keyset by id over the postings and the collection, count() from the index,
  // stream() running once where no index sorts (review №6, E4.4). 15.5 — at the measure; 16, raised by name.
  // 16.5 with the planner's cost model — estimate, cardinality, narrow, a $in scanned value by value (review №6, E4.5;
  // the design estimated 14.5 for all of E4). 17, raised by name.
  // 17.0 with a live run delivering a row that stayed as the copy it was, nearest() streamed into its sink, the
  // cache bounded by rows and the key built once (review №6, E5.2–E5.3; 2026-11-02). 17.5, raised by name.
  { label: 'query — browser (@alexify/syncom/query)', entry: 'src/query/query.js', platform: 'browser', budget: 17.5 },
  // Versions: the fold of the log, the tags, the view at a tag — measured
  // ALONE with the write path, the snapshot pages and the patches it shares
  // with the core.
  {
    label: 'versions — browser (@alexify/syncom/versions)',
    entry: 'src/versions/versions.js',
    platform: 'browser',
    // 32.9 with the write path's hash chain (src/header.js, the log's fingerprints). 33.5, raised by name.
    // 33.8 with the review's write-path fixes it bundles (a transaction's records held once, sets shared
    // between versions, an op on a purged record stripped). 34.5, raised by name.
    // 34.8 with the log's stream index and the segments read from the listing; 2026-10-27. 35, raised by name.
    // 35.1 with the write path's pieces at once and the log's enqueue (a group's promise shared, its callbacks
    // once durable; 2026-10-31). 35.5, raised by name.
    // 35.5 (over by a few bytes) with a write made at once. 36, raised by name.
    // 36.1 with the log's lines and segments of them. 36.5, raised by name.
    // 36.8 with a list read when it is read and keystrokes coalesced. 37, raised by name.
    // 37.0 (over by bytes) with what a text handle stands on. 37.5, raised by name.
    // 37.9 with SHA-256 in JavaScript (src/crypto/sha256.js), so the browser makes a write at once. 38, raised by name.
    // 38.0 (over by bytes) with a handle's flush taking what its edits made. 38.5, raised by name.
    // 38.5 (over by bytes) with the log's failed line taken out, the index's counter kept, the evidence copies
    // scrubbed, the writes counted by path and one close (review №4, E3–E9). 39, raised by name.
    // 39.5 with the log's store seam the versions plugin bundles with the log (engines plan, E1.2). 40, raised by name.
    // 40.1 with the write path's `expect: ABSENT` and the immutables it bundles (review №6, E2). 40.5, raised by name.
    // 40.5 (over by bytes) with the cursor and the catalog it bundles grown through E5 (review №6, E5.6; 2026-11-02). 41,
    // raised by name.
    budget: 41,
  },
  // Local documents: a store over the `local` kv namespace, the plugin — measured with the kv namespace and the
  // contained event it shares with the core (collections plan, C4.1). 2.3 measured; 2.5.
  // 2.5 with the changes of a key one at a time (`set(key, fn)`), a contained observer and CORRUPT (review №6, E3b). 2.75,
  // raised by name.
  // 2.8 with a write after close() or a lost lease refused through the seam's guard (review №6, E6; 2026-11-02). 3,
  // raised by name.
  { label: 'local — browser (@alexify/syncom/local)', entry: 'src/local/local.js', platform: 'browser', budget: 3 },
  // Persistent app state by name and path, over a record or a local document — measured with the paths and the
  // shapes it shares with the core (collections plan, C4.2). 2.9 measured; 3.
  { label: 'state — browser (@alexify/syncom/state)', entry: 'src/state/state.js', platform: 'browser', budget: 3 },
  // Dumps: export/import over snapshot pages, a move between engines — measured with the engines' copy it ships
  // (collections plan, C4.3).
  // 6.5 measured; 7.
  { label: 'dump — browser (@alexify/syncom/dump)', entry: 'src/dump/dump.js', platform: 'browser', budget: 7 },
  // Connectors: a collection kept in step with a backend through pull/push handlers, the checkpoint in the `connector`
  // kv namespace (sync-parity plan, S2). The plan said 5; measured alone it brings shape.js (the id check, the canonical
  // JSON it compares a document by) and the emitter — 7.0; 7.5, raised by name.
  {
    label: 'connector — browser (@alexify/syncom/connector)',
    entry: 'src/connector/connector.js',
    platform: 'browser',
    budget: 7.5,
  },
  // The connector's adapters, each over an injected client or fetch — the plan said 2 KB each (sync-parity plan, S2).
  { label: 'connector/couchdb — browser', entry: 'src/connector/couchdb.js', platform: 'browser', budget: 2 },
  { label: 'connector/graphql — browser', entry: 'src/connector/graphql.js', platform: 'browser', budget: 2 },
  { label: 'connector/mongodb — browser', entry: 'src/connector/mongodb.js', platform: 'browser', budget: 2 },
  { label: 'connector/supabase — browser', entry: 'src/connector/supabase.js', platform: 'browser', budget: 2 },
  { label: 'connector/firestore — browser', entry: 'src/connector/firestore.js', platform: 'browser', budget: 2 },
  { label: 'connector/appwrite — browser', entry: 'src/connector/appwrite.js', platform: 'browser', budget: 2 },
  // Google Drive speaks four routes (the search by name, the v2 metadata for the ETag, the create, the media upload)
  // where OneDrive speaks two: 2.1 KB measured, raised to 2.5 (sync-parity plan, S2c).
  { label: 'connector/gdrive — browser', entry: 'src/connector/gdrive.js', platform: 'browser', budget: 2.5 },
  { label: 'connector/onedrive — browser', entry: 'src/connector/onedrive.js', platform: 'browser', budget: 2 },
  // Several instances over one database: the election, the facade over a leader or a follower, the forwarded writes
  // and the recorded transaction — the plan said 6 KB (sync-parity plan, S3).
  { label: 'shared — browser', entry: 'src/shared/shared.js', platform: 'browser', budget: 6 },
  // Pipelines: a handler over a collection's turns, checkpointed in the `pipeline` kv namespace (collections plan, C4.7).
  // 3.0 with a replay and a rebuild paged, live turns joined while one is handled (review №6, E5.4; 2026-11-02). 3.25,
  // raised by name.
  {
    label: 'pipeline — browser (@alexify/syncom/pipeline)',
    entry: 'src/pipeline/pipeline.js',
    platform: 'browser',
    // 2.8 measured; 3.
    budget: 3.25,
  },
  // Tombstone cleanup: a tombstone's file folded into its catalog row (collections plan, C4.5–C4.6).
  // 3.0 with a sweep spanned and counted through the writer (review №6, E7; 2026-11-02). 3.25, raised by name.
  {
    label: 'cleanup — browser (@alexify/syncom/cleanup)',
    entry: 'src/cleanup/cleanup.js',
    platform: 'browser',
    budget: 3.25,
  },
];

// A browser entry has to be self-contained: no node builtins, and no packages
// either — esbuild resolves devDependencies happily, so a stray
// `require('metautil')` would be inlined into the bundle and only show up as a
// few extra KB. Failing at RESOLVE time names the offending import and its
// importer, which a substring search over the output cannot.
const selfContained = {
  name: 'self-contained',
  setup(build) {
    build.onResolve({ filter: /.*/ }, (args) => {
      if (args.kind === 'entry-point') return null;
      if (args.path.startsWith('.') || path.isAbsolute(args.path)) return null;
      const text = `browser bundle must not import '${args.path}' (from ${path.relative(ROOT, args.importer)})`;
      return { errors: [{ text }] };
    });
  },
};

async function bundle(entry, platform, minify) {
  const result = await esbuild.build({
    // A string entry is a file; an object is esbuild's stdin — a bundle of
    // several entries at once, the composite below.
    ...(typeof entry === 'string' ? { entryPoints: [path.join(ROOT, entry)] } : { stdin: entry }),
    bundle: true,
    minify,
    platform,
    conditions: platform === 'browser' ? ['browser'] : [],
    plugins: platform === 'browser' ? [selfContained] : [],
    write: false,
    logLevel: 'silent',
  });
  return Buffer.from(result.outputFiles[0].contents);
}

// The core and every block `/all` registers, bundled together as an app
// that imports each from its subpath: what `/all` is, built the other way.
// The two must weigh the same within a rounding — a module reached twice
// (a browser half under one path, the node half under another; a helper
// duplicated between a block and the core) would show as the difference.
const COMPOSITE = [
  'index.js',
  'src/text/text.js',
  'src/tree/tree.js',
  'src/signing/signing.js',
  'src/chain/chain.js',
  'src/encryption/encryption.js',
  'src/sync/sync.js',
  'src/schema/schema.js',
  'src/telemetry/telemetry.js',
  'src/query/query.js',
  'src/versions/versions.js',
  // The local plugin is registered by `/all` too (src/all/all.js PLUGINS); the other side stores
  // (state, dump, pipeline, cleanup) are functions over a database, not plugins, and `/all` ships none.
  'src/local/local.js',
  'src/memory/memory.js',
  'src/layered/layered.js',
];
const COMPOSITE_TOLERANCE_KB = 0.3;
const composite = () => ({
  contents: COMPOSITE.map((entry, i) => `import * as m${i} from './${entry}'; globalThis.m${i} = m${i};`).join('\n'),
  resolveDir: ROOT,
  sourcefile: 'composite.js',
});

function kb(bytes) {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

async function main() {
  const rows = [];
  const over = [];
  for (const { label, entry, platform, budget } of ENTRIES) {
    // The browser entry is bundled through the self-contained plugin, so an
    // import that does not belong fails the build here rather than inflating a
    // number nobody reads.
    const raw = await bundle(entry, platform, false);
    const min = await bundle(entry, platform, true);
    const gzip = gzipSync(min, { level: 9 }).length;
    if (budget !== undefined && gzip > budget * 1024) {
      over.push(`${entry}: ${kb(gzip)} min+gzip is over its ${budget} KB budget`);
    }
    rows.push({
      label,
      raw: kb(raw.length),
      min: kb(min.length),
      gzip: kb(gzip),
      budget: budget === undefined ? '—' : `${budget.toFixed(1)} KB`,
    });
  }

  // The composite against `/all`: nothing bundled twice.
  const allRow = rows.find((row) => row.label.startsWith('all — browser'));
  const whole = gzipSync(await bundle(composite(), 'browser', true), { level: 9 }).length;
  const allGzip = Number.parseFloat(allRow.gzip) * 1024;
  if (Math.abs(whole - allGzip) > COMPOSITE_TOLERANCE_KB * 1024) {
    over.push(
      `the core and every block together weigh ${kb(whole)}, /all ${allRow.gzip}: more than ${COMPOSITE_TOLERANCE_KB} KB apart — something is bundled twice`,
    );
  }
  rows.push({
    label: 'core + every block, in one bundle (= /all)',
    raw: '—',
    min: '—',
    gzip: kb(whole),
    budget: `${allRow.gzip} ± ${COMPOSITE_TOLERANCE_KB}`,
  });

  console.log('| Entry | raw | min | min+gzip | budget |');
  console.log('| ----- | ---:| ---:| --------:| ------:|');
  for (const row of rows) {
    console.log(`| ${row.label} | ${row.raw} | ${row.min} | ${row.gzip} | ${row.budget} |`);
  }

  // Reported after the table: seeing every number is what makes a budget
  // failure actionable.
  if (over.length > 0) throw new Error(`bundle size budget exceeded\n  ${over.join('\n  ')}`);
}

main().catch((error) => {
  // esbuild rejects with an object whose useful part is `errors[].text`; the
  // object itself prints as a wall of getters, which is how a clear "you
  // imported a package into the browser bundle" turns into noise.
  const reported = Array.isArray(error?.errors) ? error.errors : null;
  if (reported) for (const { text } of reported) console.error(text);
  else console.error(error);
  process.exitCode = 1;
});
