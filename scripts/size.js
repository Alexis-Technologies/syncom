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
  // raise to 27.5 KB.
  { label: 'main entry — browser (@alexify/syncom)', entry: 'browser.js', platform: 'browser', budget: 27.5 },
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
