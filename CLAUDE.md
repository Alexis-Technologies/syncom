# CLAUDE.md

Repo-specific notes for agents working on `@alexify/syncom`. Read
[CONTRIBUTING.md](./CONTRIBUTING.md) too — these notes only add what is easy to
get wrong.

The notes are split by where they bite. This file holds what applies to the
whole repository; a folder with a CLAUDE.md of its own holds the rules of the
code in it — Claude Code reads one when it reads a file of that folder. A rule
lives in ONE file: the folder of the module it is about, or the nearest folder
above every module it spans (`src/` for the core). The nearest CLAUDE.md wins
if two ever seem to disagree; fix the one that is wrong.

| File | What it holds |
| --- | --- |
| [src/CLAUDE.md](./src/CLAUDE.md) | The core: every top-level module of `src/` and the rules that span the core: plugins and the seam of the api plugins, ids, a peer's op, own keys, the op model and its kinds, paths, the three write paths, the log, stamps, the hash chain, purge, the catalog, locks, fsi, hooks and events |
| [src/text/CLAUDE.md](./src/text/CLAUDE.md) | The list and text kinds: the sequence engine and its rope, embeds, marks, what an op may never read whole |
| [src/tree/CLAUDE.md](./src/tree/CLAUDE.md) | The tree kind: the movable tree and its kept fold |
| [src/sync/CLAUDE.md](./src/sync/CLAUDE.md) | Replication: the dialing side and the host: scopes, the feed's cursor, failed pages, reconnects, the registry |
| [src/versions/CLAUDE.md](./src/versions/CLAUDE.md) | Versions and tags: the past folded out of the log, tags copy-on-write, patches |
| [src/editor/CLAUDE.md](./src/editor/CLAUDE.md) | The editor binding: one delta at a time with `expect`, the rebase, what the adapters share and never do |
| [src/prosemirror/CLAUDE.md](./src/prosemirror/CLAUDE.md) | The ProseMirror adapter: the document as one text with block markers |
| [src/codemirror/CLAUDE.md](./src/codemirror/CLAUDE.md) | The CodeMirror adapter: a ChangeSet as a delta, line breaks fitted |
| [src/undo/CLAUDE.md](./src/undo/CLAUDE.md) | Undo: the stack of inverse patches over the commit event |
| [src/signing/CLAUDE.md](./src/signing/CLAUDE.md) | Signing: the node id as the key, what a signature covers, the async halves |
| [src/telemetry/CLAUDE.md](./src/telemetry/CLAUDE.md) | Telemetry: the injected writer and its contract |
| [src/presence/CLAUDE.md](./src/presence/CLAUDE.md) | Presence: never logged; what a host relays |
| [src/branch/CLAUDE.md](./src/branch/CLAUDE.md) | Branches: a fork opened through the parent's constructor, a merge as a push |
| [src/search/CLAUDE.md](./src/search/CLAUDE.md) | Full-text search: `$text` as the catalog's |
| [src/query/CLAUDE.md](./src/query/CLAUDE.md) | Queries: the cursor over `storage[SOURCE]` |
| [src/schema/CLAUDE.md](./src/schema/CLAUDE.md) | Schemas: the validator after `applyOp`, the lens |
| [src/wrpc/CLAUDE.md](./src/wrpc/CLAUDE.md) | The wrpc adapter: WebRTC and wrpc are wrpc's, injected |
| [src/encryption/CLAUDE.md](./src/encryption/CLAUDE.md) | Encryption: encrypted records are local |
| [tests/CLAUDE.md](./tests/CLAUDE.md) | Tests: the suites run twice, the mesh, coverage, INVARIANTS.md |
| [bench/CLAUDE.md](./bench/CLAUDE.md) | Benchmarks: the comparison's own package, the generated charts |
| [docs/CLAUDE.md](./docs/CLAUDE.md) | Documentation: examples run before they are written, the pages kept in step with the code, the matrices as data |

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
index.d.ts                the Node type surface (hand-written)
browser.d.ts              re-exports index.d.ts (the files layer differs; the crypto halves' types are the subpaths' *.browser.d.ts)
THIRD_PARTY_NOTICES.md    the MIT notices of the algorithms adapted (Fugue, Yjs, list-positions…) and the files that carry them
scripts/size.js           bundle-size report with browser budgets
```

The file-by-file layout is in [src/CLAUDE.md](./src/CLAUDE.md) and in each
folder's CLAUDE.md.

## Gates

Before every commit: `pnpm lint`, `pnpm format:check`, `pnpm test:types`,
`node scripts/size.js`, `node --test --test-timeout=120000 tests/package/*.test.js`
and the whole suite with `node --test --test-timeout=120000` (never a run without
`--test-timeout`: one once hung for hours). Coverage —
`npx c8 --all --include 'src/**' --check-coverage --lines 95 --statements 95 --branches 90 --functions 95 node --test --test-timeout=120000`
— is enforced in CI; see [tests/CLAUDE.md](./tests/CLAUDE.md).

## Rules for the whole repository

- **An adapted algorithm brings its notice.** Code or a rule taken from an MIT or BSD project is named in
  `THIRD_PARTY_NOTICES.md` (project, commit, the syncom files that carry it) with the upstream notice.
  Nothing is copied from json-joy (AGPL-3.0), Collabs or `fugue/fugue` (Apache-2.0) — those are read
  as specifications only; the clones live in `../../open-source/local-first-alternatives/`.
- **CommonJS everywhere in `src/`.** No `import`, no `type: module`, no build.
- **No runtime dependencies.** Helpers go in `src/utils.js`. `scripts/size.js`
  fails at resolve time on any bare import reaching a browser bundle, so a
  stray `require('some-pkg')` in shared code breaks `pnpm size`, not just the
  dependency count.
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
- **A `.d.ts` change and its `tsd` test land together** (`tests/*.test-d.ts`).
- **Record types are phantom.** `Schema<Shapes>` (`shapes?`) and a Standard Schema's
  `~standard.types` are read by `index.d.ts` alone — `Collections<S>` maps them to
  `SyncomCollection<R, I>` — and nothing at run time reads `shapes`; `RecordData` is the
  type wherever the schema says no more. A reader of a record takes `R` (`get<R>`,
  `record<R>`) rather than returning `unknown`; a new one does the same.
- **`tests/package/docs-paths.test.js` guards the guides.** Every `src/…` path CLAUDE.md, CONTRIBUTING.md, a skill or a
  comment in `src/` names exists, and every "no requires" / "requires X only" of a layout line above is what the
  file requires — move a file or add a require and the line moves with it.
- **`tests/package/consistency.test.js` guards the metadata.** If it goes red
  after you add an entry point, update `exports`, `files`, the `browser` map,
  `scripts/size.js` `ENTRIES` and the docs keywords — the test is right.
- **Constructors that return promises.** `Storage`, `Blockchain` and
  `SyncManager` all `return this.#init()` from the constructor, so they are
  used as `await new Blockchain(path)`. The types model this; keep it that way.

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

Keep the two adapted skills in sync with these notes and CONTRIBUTING.md. **The nearest CLAUDE.md wins** if
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
