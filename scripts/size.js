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
  // injected OpenTelemetry writer (src/telemetry.js and its call sites in
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
  // (src/digest.js) — and came down to 52 KB (51.4 measured). The rule
  // stays: a raise names its feature here.
  { label: 'main entry — browser (@alexify/syncom)', entry: 'browser.js', platform: 'browser', budget: 52 },
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
  { label: 'idb backend — browser (@alexify/syncom/idb)', entry: 'src/idb/idb.js', platform: 'browser', budget: 2 },
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
    budget: 4.5,
  },
  // Presence: the emitter, the bounds, the signed entries; the identity comes from the storage.
  {
    label: 'presence — browser (@alexify/syncom/presence)',
    entry: 'src/presence/presence.js',
    platform: 'browser',
    // 3.8 measured: shape.js (the canonical JSON, the stream and key checks) comes with the emitter.
    budget: 4.5,
  },
  // The editor binding: deltas composed and transformed, the diff between two readings (the text plugin's Myers
  // comes along, and the vector keys), the binding itself, selections and presence cursors. The plan said 4; the
  // transform and the diff are what an editor needs, so 6, raised by name (4.9 measured).
  {
    label: 'editor — browser (@alexify/syncom/editor)',
    entry: 'src/editor/editor.js',
    platform: 'browser',
    budget: 6,
  },
  // The CodeMirror adapter: the editor binding it stands on (4.9), a ChangeSet as a delta and back, the cursors'
  // decorations, the undo commands. CodeMirror itself is injected, never bundled. The plan said 3; the binding
  // under it is most of it, so 7, raised by name (6.6 measured).
  {
    label: 'codemirror — browser (@alexify/syncom/codemirror)',
    entry: 'src/codemirror/codemirror.js',
    platform: 'browser',
    budget: 7.5,
  },
  // The ProseMirror adapter: the editor binding it stands on (4.9) and the document as one text with block
  // markers, the replace step, the cursors' decorations, the undo commands. ProseMirror itself is injected, never
  // bundled. The plan said 6; the binding under it is most of it, so 8, raised by name (7.5 measured).
  {
    label: 'prosemirror — browser (@alexify/syncom/prosemirror)',
    entry: 'src/prosemirror/prosemirror.js',
    platform: 'browser',
    budget: 8.5,
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
    budget: 5,
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
  { label: 'all — browser (@alexify/syncom/all)', entry: 'src/all/all.js', platform: 'browser', budget: 107 },
  // The list and text kinds alone: the sequence engine over its rope
  // (src/text/btree.js, pmap.js, plist.js), its patches and its methods;
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
  { label: 'text — browser (@alexify/syncom/text)', entry: 'src/text/text.js', platform: 'browser', budget: 31.5 },
  // The tree kind alone, with the fractional indexes a place is made of and
  // the argument checks it shares with the core (5.1 measured).
  // 5.5 with the field-name check unset shares with it (src/args.js).
  // 5.9 with the field-path check (src/paths.js).
  // 6.1 with a node's data (the members' seam).
  // 6.3 with the change reports (treeChanges: the placements before and after).
  // 6.8 with src/ in procedural loops (no array callbacks — a loop is longer than a callback; 2026-10-26).
  { label: 'tree — browser (@alexify/syncom/tree)', entry: 'src/tree/tree.js', platform: 'browser', budget: 7.5 },
  // The security blocks, each measured ALONE — with the shape checks, the
  // PEM pair, the backend contract and the errors it shares with the core,
  // which an app bundle holds once (4.2 / 2.0 / 3.6 measured; what each
  // adds to the core is the difference `/all` shows).
  // Signed ops: the Ed25519 half, the canonical form and the verdict.
  // 4.5 with src/ in procedural loops (no array callbacks — a loop is longer than a callback; 2026-10-26) (a hex table in the browser half).
  // 5.1 with the keys no one holds refused (the points of small order, a y past the prime).
  {
    label: 'signing — browser (@alexify/syncom/signing)',
    entry: 'src/signing/signing.js',
    platform: 'browser',
    budget: 5.5,
  },
  // The chain: the blocks, SHA-256 through Web Crypto, the plugin.
  { label: 'chain — browser (@alexify/syncom/chain)', entry: 'src/chain/chain.js', platform: 'browser', budget: 2.5 },
  // Sealed records (the RSA half) and the at-rest wrapper (AES-GCM, PBKDF2).
  {
    label: 'encryption — browser (@alexify/syncom/encryption)',
    entry: 'src/encryption/encryption.js',
    platform: 'browser',
    budget: 4,
  },
  // The backends as blocks: the Map in memory; the multi-level cache over
  // several (with the contract check it shares with the core).
  {
    label: 'memory — browser (@alexify/syncom/memory)',
    entry: 'src/memory/memory.js',
    platform: 'browser',
    budget: 0.75,
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
  { label: 'sync — browser (@alexify/syncom/sync)', entry: 'src/sync/sync.js', platform: 'browser', budget: 22.5 },
  // The schema: the definitions read once, the validator adapters, the lens.
  // 4.3 with a set folded back by path (src/entity.js over src/paths.js).
  {
    label: 'schema — browser (@alexify/syncom/schema)',
    entry: 'src/schema/schema.js',
    platform: 'browser',
    // 4.6 with the canonical JSON in shape.js.
    budget: 5,
  },
  // The OpenTelemetry adapter: the tracer and meter resolved, the instruments, the gauges.
  {
    label: 'telemetry — browser (@alexify/syncom/telemetry)',
    entry: 'src/telemetry/telemetry.js',
    platform: 'browser',
    budget: 4,
  },
  // Queries: the predicate, the planner and the cursor, measured ALONE with
  // the catalog's value keys it shares with the core.
  // 6.0 with src/ in procedural loops (no array callbacks — a loop is longer than a callback; 2026-10-26).
  { label: 'query — browser (@alexify/syncom/query)', entry: 'src/query/query.js', platform: 'browser', budget: 6.5 },
  // Versions: the fold of the log, the tags, the view at a tag — measured
  // ALONE with the write path, the snapshot pages and the patches it shares
  // with the core.
  {
    label: 'versions — browser (@alexify/syncom/versions)',
    entry: 'src/versions/versions.js',
    platform: 'browser',
    budget: 32,
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
