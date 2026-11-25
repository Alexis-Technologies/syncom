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
`node scripts/size.js`, `pnpm test:package` (`tests/package/*.test.js`)
and the whole suite with `node --test --test-timeout=120000 --test-force-exit` (never a run without
both: a test once hung for hours, and a file whose failed test left a message port open sat for eight
hours after its last test). Coverage —
`pnpm exec c8 --all --include 'src/**' --check-coverage --lines 95 --statements 95 --branches 90 --functions 95 node --test --test-timeout=120000 --test-force-exit`
— is enforced in CI; see [tests/CLAUDE.md](./tests/CLAUDE.md). `pnpm run prepublishOnly` runs them all, coverage
included; `pnpm docs:build` is the one gate it leaves to CI and the release.

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
- **Every error syncom throws on purpose has a `code`, and every code starts with `ALX_ERR_`.** `src/errors.js`:
  - a failure that can happen to correct calling code — given the data, the files or the peers — is
    `new SyncomError(code, message, { cause, ...fields })`, its code in the `SyncomErrorCode` union of `index.d.ts`;
    `HookError` and `ValidationError` extend it;
  - a wrong argument, option, definition or hook result is an `ArgumentError` (it extends `TypeError`; one code,
    `ALX_ERR_INVALID_ARGUMENT`), or an `ArgumentRangeError` (a `RangeError`, the same code) where the API always threw
    a `RangeError` (`src/order/order.js`). Never a bare `TypeError`, `RangeError` or `Error` for it;
  - a value that is data (`ALX_ERR_INVALID_ID`, `ALX_ERR_TYPE_IMMUTABLE`, `ALX_ERR_INVALID_VERSION`,
    `ALX_ERR_PRESENCE_SIZE`…) or configuration (`ALX_ERR_NO_CHAIN`, `ALX_ERR_PLUGIN_MISSING`) is
    `new DataError(code, message, details)` (a `TypeError`, one shape: `details` null where the code documents
    nothing) — the `DataErrorCode` union, never in `SyncomErrorCode`.

  `ErrorCode` is the union of all three, and the table of `docs/reference/api.md` has one row per code (who raises
  it, which fields ride on it); `tests/package/consistency.test.js` reads every code off `src/` and holds both unions
  and the table to it. **The wire is the exception:** a host's refusal (`coded` in `src/sync/rules.js`) keeps the
  numeric code wrpc carries and names the check in `reason` (`403` `READ_ONLY`, `404` `BLOB_NOT_FOUND`): that
  constant is the protocol's, not an error code, and keeps its name. Never `new Error(...)` for something a caller
  may handle, never invent a code without its row in the table and its union.
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
- **Lint.** oxlint over `src`, `tests`, `scripts`, `bench`, `examples` and `docs/examples` (`.oxlintrc.json`), the
  reference of alexiskills taken whole: `correctness` and `suspicious` as errors; `eqeqeq` always, `null` included;
  `func-style: expression`, `max-depth` 4, `no-nested-ternary`, `no-console`; in `src/**` every array iteration method
  (and `Array.from`) through `no-restricted-properties`, the unicorn rules and `max-lines-per-function` 80 as a
  warning. `pnpm lint` reports an unused disable comment as an error. Suppress a rule only for an intentional
  construct, with a targeted `// oxlint-disable-next-line <rule>` and the reason on the line above. Where syncom
  differs from the reference, on purpose:
  - `no-underscore-dangle` (a `suspicious` rule) is off: `_id`, `_rev`, `_deleted`, `_updated` and `_attachments`
    are the field names of the backends and protocols syncom speaks (MongoDB, CouchDB, RxDB's), not a naming choice;
  - `unicorn/prefer-add-event-listener` is off in `src/`: the event targets syncom drives are handed in and duck-typed
    — an `indexedDB` factory whose requests may have the `on…` properties alone (`tests/idb.test.js` hands in such
    a one), a BroadcastChannel- or MessagePort-shaped `channel` whose `onmessage` is its one handler and starts a
    port — so `onsuccess =` and `onmessage =` are the contract, not a style;
  - `no-console` is off where the repository prints on purpose: `scripts/`, `bench/`, `examples/`, `docs/examples/`
    (the pages show what an example prints) and `tests/smoke/` (CI reads its summary);
  - `import/no-unassigned-import` allows the side-effect imports that are one: `tests/utils/quiet-sqlite.js`,
    `fake-indexeddb/auto` and `@alexify/wrpc/sse`;
  - the stricter rules syncom had before stay: `preserve-caught-error`, the explicit rule list, `env.browser`.
- **`'use strict'` in every file of `src/`**, which alexiskills adds only where a project already does; CommonJS, no
  runtime dependency and no build are the rules above; a platform split is a `*.browser.js` file (src/CLAUDE.md).
- **Iteration in `src/` is stricter than alexiskills.** Besides every array iteration method, `Array.from` is banned
  (a loop, or `[...iterable]` for a plain copy); `T.find` and `SL.find` are the rope's and the plist's own functions,
  and the editor APIs named `map` (`RangeSet.map`, `DecorationSet.map`) carry a disable comment. One walk does what it
  can (never `filter().map()`, a count pass then a build pass, or the same `Object.keys(o)` twice); a membership test
  inside a loop is a `Set`, built once.
- **Never spread a data array into arguments, never `new Array(n)`.** `push(...items)`, `Math.max(...values)` and
  `fn(...array)` throw `RangeError` past ~130 000 elements, and a list run holds up to `MAX_RUN`. A new array is `[]`
  and `push`: `new Array(n)` filled by index stays holey for good, and a list's chunks built that way cost a text
  insert 8% (measured). A bulk copy stays native (`slice`, `concat`).
- **`await` `calculateHash`, `encrypt`, `decrypt`, `sign` and `verify` in shared code**: synchronous in Node.js,
  promise-returning in the browser.
- **The hot path** — applying and merging ops, `OpLog.append`, vector clocks, `packOps` — creates no closure or
  `RegExp` per call, keeps one object shape per kind of op and log entry, and has `try`/`catch` only around user code
  (hooks, listeners) and I/O. Run `pnpm bench` before and after touching it; a number that moved is a finding.
- **Errors** are the rule above. A module that throws only the TypeError family requires `src/argument-errors.js`,
  never `src/errors.js`: CommonJS is not tree-shaken, and a small subpath would carry every class.
- **Tests** are `describe` and `it('should …')` over `node:assert/strict`; `--test-force-exit` stays (CONTRIBUTING.md).

Where syncom keeps a way of its own, on purpose:

- **`delete` stays where the object is a dictionary or data whose missing key means something**, never on a record
  or an instance: the meta maps keyed by field, origin or stream (`clock`, `counters`, `sets`, `blocks`, `gone`), a
  record's data by field, a purged meta's `v`/`vs` (the same on every node), the `covered` side table of a changes
  array before it leaves `applyOp`, an op's `scope` and what `scrubOp` takes (an `undefined` would change the log
  line's rest), the vector, a run's `vals` and a payload's `content` (absent is a pure cut on the wire), the run-key
  and node-id dictionaries of the text and tree kinds, the style and attribute dictionaries of the editors, wrpc's
  per-client data bag (absent: not greeted), a span's attribute map and a copy of an app state's JSON.
- **`String(value)` stays where the value may be a symbol**: a thrown value turned into a message (`packError`, the
  manager's `lastError`, a connector's parked row, a validator's issue), a property key (the shared tabs' `tx[name]`,
  `collection[method]`), and a caller's value before `copyPayload` checks it. A template literal throws on a symbol.
- **`.bind(this)` stays in `src/document.js` and `src/collection.js`**, the metaprogramming of an ORM: the Document
  class is shared by every collection and a record's `$type` is known only once it loads, so a collection's `methods`
  are own non-enumerable properties defined at the load beside the fields' own accessors, and bound because the docs
  promise it (a method handed out on its own keeps its document); a Collection's `statics` the same, once per
  collection. Never in a hot path, never for a listener.
- **A database grows after its construction**: a collection is an own property (`db.Task`, RxDB's shape), made at the
  open and by `addCollections()`. `removeCollection()` sets it `undefined` and unlisted instead of deleting it, and
  keeps the name free for `addCollections()`.
- **`for…in` with `Object.hasOwn` in `hasAny` of `src/ops.js`**: whether a set field holds any element, stopped at the
  first own key — `Object.keys` built the array of 20 000 elements per op (the comment there).
- **`max-lines-per-function` warns 57 times in `src/`**: the sequential protocols (the open sequence, the write
  paths, the hosting procedures) stay long, as `js-conventions` allows; a new warning is a reason to look, not a
  failure.

## Release process

Manual, on purpose: no release workflow, no publish automation. The `npm-publish` skill of alexiskills walks through
it step by step; it runs only as `/npm-publish` (`disable-model-invocation: true`), and never publishes. The commands
are CONTRIBUTING.md's "Release checklist". What syncom adds to the steps of the skill:

- **Gates (its step 1).** `prepublishOnly`, then `pnpm docs:build` (a dead link fails it), which CI runs and
  `prepublishOnly` does not. A coverage threshold is never lowered and a size budget never raised to get green.
  `pnpm outdated` and `pnpm audit` are about the devDependencies alone.
- **Version (step 2).** The nav label of `docs/.vitepress/config.mts` is hand-synced with `package.json` (the
  consistency test). `0.0.1` is a placeholder until the first release, whose version is picked with the user (`0.1.0`
  usually); `package.json`, the nav label and the comparison matrix move together.
- **CHANGELOG (step 3).** On the first release the note that the package is unpublished leaves the top of the file,
  all of `[Unreleased]` lands in the version, and its link points to `releases/tag/v<version>`.
- **Typings (step 4).** `index.d.ts`, `browser.d.ts` (the crypto functions async in the browser) and each subpath's
  `.d.ts` with its `tests/<name>.test-d.ts`; the event maps and hook options match what the write paths emit and run.
- **Docs (step 5).** The README's size table from `pnpm size`, `docs/public/llms.txt` from `pnpm docs:llms`, the
  docs keywords from `package.json`, SECURITY.md's table on the first or a major release (docs/CLAUDE.md, the rest).
- **Package (step 6).** `files` is the allowlist, `!**/CLAUDE.md` included (`tests/package/pack.test.js`);
  `pnpm pack --dry-run`, then the tarball smoked from a scratch consumer, the one place `npm` and `npx` are used.
- **Publish.** `pnpm publish` from the tagged commit (`chore(release): X.Y.Z`, tag `vX.Y.Z`), by hand, gated by
  `prepublishOnly`.

## Skills

The skills are [alexiskills](https://alexiskills.vercel.app), `@alexify/metaskills` 1.1, a devDependency: its 37
skills, `.claude/skills` one symlink to `node_modules/@alexify/metaskills/skills` that the `prepare` script
(`alexiskills claude`) makes on every `pnpm install` and `.gitignore` leaves out. They are not edited here: a change
goes to `Alexis-Technologies/metaskills` and comes back with a release. What the six metarhia 1.0.5 skills kept here
until 2026-11-25 said of syncom alone is in "Conventions" and "Release process". **This file wins** if a skill and it
ever disagree.
