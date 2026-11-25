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
| [src/files/CLAUDE.md](./src/files/CLAUDE.md) | The files engine: today's layout byte for byte, the order of a write set |
| [src/memory/CLAUDE.md](./src/memory/CLAUDE.md) | The backend and the engine in memory: objects, not texts; a path outlives its instance |
| [src/idb/CLAUDE.md](./src/idb/CLAUDE.md) | IndexedDB: the file store and the engine over object stores — a key range, a transaction per write set |
| [src/sqlite/CLAUDE.md](./src/sqlite/CLAUDE.md) | SQLite: the engine over one file, node:sqlite or a driver — one lane, a transaction per write set |
| [src/mongodb/CLAUDE.md](./src/mongodb/CLAUDE.md) | MongoDB: the engine over the driver injected — upserts in order or one transaction, change streams by token |
| [src/engines/CLAUDE.md](./src/engines/CLAUDE.md) | Engines served over a port (remoteEngine) and copied between (copyEngine): only bytes cross, a copy is the node |
| [src/text/CLAUDE.md](./src/text/CLAUDE.md) | The list and text kinds: the sequence engine and its rope, embeds, marks, what an op may never read whole |
| [src/tree/CLAUDE.md](./src/tree/CLAUDE.md) | The tree kind: the movable tree and its kept fold |
| [src/sync/CLAUDE.md](./src/sync/CLAUDE.md) | Replication: the dialing side and the host: scopes, the feed's cursor, failed pages, reconnects, the registry |
| [src/versions/CLAUDE.md](./src/versions/CLAUDE.md) | Versions and tags: the past folded out of the log, tags copy-on-write, patches |
| [src/editor/CLAUDE.md](./src/editor/CLAUDE.md) | The editor binding: over a text handle, what the adapters share and never do |
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
| [src/local/CLAUDE.md](./src/local/CLAUDE.md) | Local documents: never an op |
| [src/state/CLAUDE.md](./src/state/CLAUDE.md) | App state: by name and path, a path a register |
| [src/dump/CLAUDE.md](./src/dump/CLAUDE.md) | Dumps: a merge is a bootstrap, an insert is a write |
| [src/pipeline/CLAUDE.md](./src/pipeline/CLAUDE.md) | Pipelines: once, in order, checkpointed after the write |
| [src/attachments/CLAUDE.md](./src/attachments/CLAUDE.md) | Attachments: bytes in the engine's blobs store by digest, a register on the record, fetched from a peer on demand |
| [src/testing/CLAUDE.md](./src/testing/CLAUDE.md) | Testing: the in-process link with a transport's hazards, the mesh, `settle()` — the one copy the repository's suite runs on |
| [src/mcp/CLAUDE.md](./src/mcp/CLAUDE.md) | Agent tools: the Model Context Protocol tool definitions over a database, the schema checked at the door |
| [src/shared/CLAUDE.md](./src/shared/CLAUDE.md) | Several tabs: the leader and the followers over one engine, the election, the channel, the failover |
| [src/connector/CLAUDE.md](./src/connector/CLAUDE.md) | Connectors: a collection and a backend kept in step — pulls land as writes, pushes follow the turns, the backend wins a conflict |
| [src/cleanup/CLAUDE.md](./src/cleanup/CLAUDE.md) | Tombstone cleanup: a folded tombstone still wins |
| [tests/CLAUDE.md](./tests/CLAUDE.md) | Tests: the suites run twice, the mesh, coverage, INVARIANTS.md |
| [bench/CLAUDE.md](./bench/CLAUDE.md) | Benchmarks: the comparison's own package, the generated charts |
| [docs/CLAUDE.md](./docs/CLAUDE.md) | Documentation: the guide teaches and the reference records, the page templates, every example a file the suite runs, the RxDB page map, figures and live demos, the matrices as data |

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
`node scripts/size.js`, `node --test --test-timeout=120000 --test-force-exit tests/package/*.test.js`
and the whole suite with `node --test --test-timeout=120000 --test-force-exit` (never a run without
both: a test once hung for hours, and a file whose failed test left a message port open sat for eight
hours after its last test). Coverage —
`pnpm exec c8 --all --include 'src/**' --check-coverage --lines 95 --statements 95 --branches 90 --functions 95 node --test --test-timeout=120000 --test-force-exit`
— is enforced in CI; see [tests/CLAUDE.md](./tests/CLAUDE.md).

## Rules for the whole repository

- **An adapted algorithm brings its notice.** Code or a rule taken from an MIT or BSD project is named in
  `THIRD_PARTY_NOTICES.md` (project, commit, the syncom files that carry it) with the upstream notice.
  Nothing is copied from json-joy (AGPL-3.0), Collabs or `fugue/fugue` (Apache-2.0), nor from RxDB (Apache-2.0)
  and its event-reduce-js (MIT) — those are read as specifications only (the live query of `src/query/live.js` is
  the event-reduce idea written anew); the clones live in `../../open-source/local-first-alternatives/`.
- **CommonJS everywhere in `src/`.** No `import`, no `type: module`, no build. `package.json` says
  `"type": "commonjs"` and keeps saying it: Deno reads a `.js` file as an ES module without it (the `smoke-deno` job).
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
- **`tests/package/docs-paths.test.js` guards the guides.** Every `src/…` path CLAUDE.md, CONTRIBUTING.md or a
  comment in `src/` names exists, and every "no requires" / "requires X only" of a layout line above is what the
  file requires — move a file or add a require and the line moves with it.
- **`tests/package/consistency.test.js` guards the metadata.** If it goes red
  after you add an entry point, update `exports`, `files`, the `browser` map,
  `scripts/size.js` `ENTRIES` and the docs keywords — the test is right.
- **These notes never ship.** `src/` is published whole, and a CLAUDE.md lives in almost every folder of it:
  `package.json#files` takes them back out (`!**/CLAUDE.md`), and `tests/package/pack.test.js` asks npm what the
  tarball holds — no CLAUDE.md, nothing of `.claude/`, and under `src/` only `.js` and `.d.ts`. A notes file under
  another name, or any other file that is not code or types, does not belong in `src/`.
- **Constructors that return promises.** `Database`, `Blockchain` and
  `SyncManager` all `return this.#init()` from the constructor, so they are
  used as `await new Blockchain(path)`. The types model this; keep it that way.
- **Nothing is published: every stored format is its first version, and nothing reads an older one.** A format's
  number — `FORMAT`, `VERSION`, `PROTOCOL`, an IndexedDB database's version, a header's — stays `1` until the first
  release, whatever changes before it: no bump, and no reader, upgrade or fallback for what an earlier build wrote
  (a development database is deleted, not migrated). The same holds for names: an API renamed before the first
  release keeps no alias and nothing is `@deprecated`. `tests/package/formats.test.js` holds every such constant in
  `src/` to 1 and the sources free of `@deprecated`; the rules for after the publication are "Compatibility" in
  `docs/reference/wire.md`.

## Conventions

The style is `js-conventions` of alexiskills, its Library profile (CommonJS, hand-written `.d.ts`, `node:test` with
c8, no runtime dependency). This section is what syncom adds to it or does otherwise, and **this file wins** where the
two differ; a folder's own CLAUDE.md wins over this one for the code of that folder.

- **Formatting.** oxfmt: 2 spaces, single quotes, semicolons, trailing commas, LF, and **120 columns** (`printWidth`
  in `.oxfmtrc.json`). Run `pnpm format` before committing; CI runs `format:check`.
- **Lint.** oxlint over `src`, `tests`, `scripts`, `bench`, `examples` and `docs/examples` (`.oxlintrc.json`). Suppress
  a rule only for an intentional construct, with a targeted `// oxlint-disable-next-line <rule>`.
- **`'use strict'` in every file of `src/`.** alexiskills adds it only where a project already does; syncom does,
  everywhere, and keeps it.
- **No runtime dependencies, and no build.** The only bare `require` in `src/` is a `node:` built-in, and none at all
  in a file that reaches a browser bundle; a helper goes in `src/utils.js`. `node:` prefix and `.js` in every relative
  require.
- **A platform split is a `*.browser.js` file** (dot, not dash), wired through `package.json#browser` and
  `src/index.browser.js` (src/CLAUDE.md has the three edits it needs). `env.browser` stays on in the lint: the
  shared modules run in both.
- **Iteration in `src/` is stricter than alexiskills.** Besides every array iteration method, `Array.from` is banned
  (a loop, or `[...iterable]` for a plain copy); `T.find` and `SL.find` are the rope's and the plist's own functions,
  and the editor APIs named `map` (`RangeSet.map`, `DecorationSet.map`) carry a disable comment. One walk does what it
  can (never `filter().map()`, a count pass then a build pass, or the same `Object.keys(o)` twice); a membership test
  inside a loop is a `Set`, built once.
- **Never spread a data array into arguments, never `new Array(n)`.** `push(...items)`, `Math.max(...values)` and
  `fn(...array)` throw `RangeError` past ~130 000 elements, and a list run holds up to `MAX_RUN`. A new array is `[]`
  and `push`: `new Array(n)` filled by index stays holey for good, and a list's chunks built that way cost a text
  insert 8% (measured). A bulk copy stays native (`slice`, `concat`).
- **Events leave through `notify()`** and never fail the operation they observe; a hook may fail it.
- **`await` `calculateHash`, `encrypt`, `decrypt`, `sign` and `verify` in shared code**: synchronous in Node.js,
  promise-returning in the browser.
- **The hot path** — applying and merging ops, `OpLog.append`, vector clocks, `packOps` — creates no closure or
  `RegExp` per call, keeps one object shape per kind of op and log entry, and has `try`/`catch` only around user code
  (hooks, listeners) and I/O. Run `pnpm bench` before and after touching it; a number that moved is a finding.

## Release process

Manual, on purpose: no release workflow, no publish automation. The `npm-publish` skill of alexiskills walks through
it step by step; it runs only as `/npm-publish` (`disable-model-invocation: true`), and never publishes. The commands
are CONTRIBUTING.md's "Release checklist". What syncom adds to the steps of the skill:

- **Gates (its step 1).** `prepublishOnly`, then `pnpm docs:build` (a dead link fails it), which CI runs and
  `prepublishOnly` does not. A coverage threshold is never lowered and a size budget never raised to get green.
  `pnpm outdated` and `pnpm audit` are about the devDependencies alone.
- **Version (step 2).** The nav label of `docs/.vitepress/config.mts` (`text: 'v<version>'`) is hand-synced with
  `package.json`; `tests/package/consistency.test.js` fails when they differ. **The first release:** `0.0.1` is the
  placeholder the repository carries until the package meets its goals. The first version is picked with the user
  (`0.1.0` is the usual choice for an API that may still change), and `package.json`, the nav label and the comparison
  matrix move together.
- **CHANGELOG (step 3).** On the first release the note that the package is unpublished leaves the top of the file,
  all of `[Unreleased]` lands in the version, and its link points to `releases/tag/v<version>`.
- **Typings (step 4).** `index.d.ts` is the Node surface; `browser.d.ts` re-exports it and overrides the crypto
  functions that are async in the browser; every subpath has its `.d.ts` and `tests/<name>.test-d.ts`. The event maps
  and the hook option types match what `src/commit.js`, `src/apply.js`, `src/bootstrap.js`, `src/database.js` and
  `src/sync/manager.js` emit and run.
- **Docs (step 5).** The README's bundle-size table comes from `pnpm size`; the replication pages agree with
  `src/sync/manager.js` and `src/sync/hosting.js`, the hooks and events pages with the files above;
  `docs/public/llms.txt` is regenerated (`pnpm docs:llms`, `tests/package/docs-map.test.js`); the docs keywords
  mirror `package.json#keywords`; SECURITY.md's table changes on a major (or the first) release.
- **Package (step 6).** `files` is the allowlist (no `.npmignore`, no `dependencies`), `!**/CLAUDE.md` keeps the notes
  out and `tests/package/pack.test.js` holds it. `pnpm pack --dry-run`, then the tarball smoked from a scratch consumer
  (the one place `npm` and `npx` are used): `require()` it from a CJS file, and typecheck it with
  `npx tsc --moduleResolution bundler --module esnext --noEmit`.
- **Publish.** `pnpm publish` from the tagged commit (`chore(release): X.Y.Z`, tag `vX.Y.Z`), by hand, gated by
  `prepublishOnly`.

## Skills

The skills are [alexiskills](https://alexiskills.vercel.app), `@alexify/metaskills` 1.1, a devDependency: all 37
skills of its seven packs. `.claude/skills` is one symlink to `node_modules/@alexify/metaskills/skills`, made by the
`prepare` script (`alexiskills claude`) on every `pnpm install`, a worktree's included, and left out by `.gitignore`.
Until 2026-11-25 the directory held six skills of metarhia/metaskills 1.0.5, `js-conventions` and `npm-publish` adapted
to this repository; what they said of syncom alone is in "Conventions" and "Release process" above.

- **The skills are not edited here.** A change to one goes to `Alexis-Technologies/metaskills` and comes back with a
  release of the package. A skill of this repository's own beside them would turn the symlink into a directory of
  links, and one named like a skill of the package hides that skill.
- **`js-conventions` and `npm-publish` are the Alexis ones, for every library.** What syncom does differently or adds
  is here.

**This file wins** if a skill and this file ever disagree.
