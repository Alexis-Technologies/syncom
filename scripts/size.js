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
  // marks, spans() — the raise to 51.5 KB (51.4 measured).
  { label: 'main entry — browser (@alexify/syncom)', entry: 'browser.js', platform: 'browser', budget: 51.5 },
  { label: 'main entry — node (@alexify/syncom)', entry: 'index.js', platform: 'node' },
  // Platform-neutral (no node builtins, no browser-only globals): one file
  // serves both, bundled as a browser entry so the self-contained check
  // guards it too.
  { label: 'wrpc adapter — browser (@alexify/syncom/wrpc)', entry: 'wrpc.js', platform: 'browser', budget: 2 },
  // Smart contracts: off the main entry on purpose (a `new Function` over
  // chain data), so a node that never imports the subpath never pays for it
  // — in bytes or in attack surface.
  { label: 'contracts — browser (@alexify/syncom/contracts)', entry: 'contracts.js', platform: 'browser', budget: 1 },
  // The IndexedDB backend: browser-only by nature, its own row so the main
  // entry pays nothing for it.
  { label: 'idb backend — browser (@alexify/syncom/idb)', entry: 'idb.js', platform: 'browser', budget: 2 },
  // The trigram text index behind `$text`: platform-neutral, off the main
  // entry so a node that never searches pays nothing for it.
  { label: 'search — browser (@alexify/syncom/search)', entry: 'search.js', platform: 'browser', budget: 2 },
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
    entryPoints: [path.join(ROOT, entry)],
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
