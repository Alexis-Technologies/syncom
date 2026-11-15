# docs/CLAUDE.md — Documentation

The guide teaches, the reference records: examples run before they are written, the pages kept in step with the code, the matrices as data. what holds for the whole repository is in [CLAUDE.md](../CLAUDE.md).

## Layout

```
docs/guide/               the guide: one page per task or concept, written for a developer using syncom
docs/reference/           the specification: api.md, wire.md and the spec pages the guide links into
docs/examples/            every code block a page shows, as a file tests/package/docs-examples.test.js runs
docs/examples/rxdb/       RxDB's side of a "Coming from RxDB" code group, run by `pnpm docs:examples:rxdb`
docs/rxdb-map.json        every page of RxDB's sidebar, the syncom page that answers it and the verdict
docs/comparison*.json     the feature matrices; scripts/comparison.js renders comparison.json into docs/guide/comparison.md,
                          comparison-rxdb.json into vs-rxdb.md, comparison-crdt.json into vs-crdt.md
docs/.vitepress/sidebar/  the guide's sidebar, one JSON file per group, read in file-name order
docs/.vitepress/theme/    the brand (custom.css) and the components a page uses without importing them
docs/                     VitePress site
```

## The guide and the reference

A guide page teaches one task or one concept to a developer who has not read the code. The reference is the
specification: every option, bound, invariant, error code, event payload and byte. When a guide page needs a
rule only for completeness, the rule goes to the reference and the page links to its anchor. `reference/api.md`
and `reference/wire.md` stay specifications; `reference/events.md` (events and hooks), `reference/engines.md`
(the engine and backend contracts), `reference/entry-points.md` (the subpaths) and `reference/telemetry.md`
(spans, metrics, log events) hold the tables the guide used to carry. The error-code table stays in `api.md`
(`tests/package/consistency.test.js` reads it there), the telemetry tables in `reference/telemetry.md`
(`tests/package/telemetry-events.test.js`).

## Writing a guide page

- **Voice.** Second person ("you"), present tense, imperative in steps. US English. Plain words; the same
  term for the same thing every time ("database", "node", "op"). No marketing, no "simply", no "just".
- **Headings name tasks or questions**: "Open a database in the browser", "Edit the same field on two nodes",
  "Why there is no revision field". Not "The checkpoint", not the name of an option.
- **Example first, then why.** Show the smallest code that does the task, then explain what happened and when
  you would do it differently. Introduce a concept through what the reader can see before how it works inside.
- **Prose, not rule lists.** Paragraphs of two to four sentences. A list where the items are truly parallel,
  never a page of bullets. A table only for a real comparison. At most a couple of em dashes per page.
- **Internals only when they explain behaviour.** If the reader cannot predict what happens without knowing a
  mechanism, explain the mechanism (with a figure when it moves); otherwise leave it to the reference.
- **Error codes** appear where the reader handles them ("a second open rejects with `LOCKED`"), never as a
  catalogue. The catalogue is `reference/api.md#syncomerror`.
- **Be honest about trade-offs.** A "Limitations" or "When not to use this" section is welcome. Never claim a
  number nobody measured; link `/guide/benchmarks` for measured ones.
- **Link densely**: the first mention of a concept that has a page links to it (`[scopes](./partial-sync)`).
- **Frontmatter**: every page has `title` (the name the sidebar shows, or a longer one) and `description` (one
  sentence, 80 to 160 characters, what the reader learns). `<DocsOverview>` and `scripts/llms.js` read them.
- **Length**: as long as the task needs. A concept page is rarely past 300 lines; split before it is.

### The running example

The Core and Replication pages build one app: a shared task board. A `Task` collection with `title` and
`done` (registers), `votes` (a counter, born with `inc()`), `tags` (a set, born with `add()`) and `notes`
(a text, with the `text` plugin). Nodes are named after where they run: `server`, `laptop`, `phone`. Use the
example where it fits; a page about something else (a connector, a storage) may use its own small data.

### Page templates

- **Entity** (Database, Collection, Document, Query, Schema): what it is and why (2 to 4 sentences) → the
  minimal example → one section per common task, each an example then the why → Limitations → FAQ if there
  are real questions → `## Coming from RxDB` → a line linking the reference section.
- **Concept** (Sync engine, Transactions and conflicts, Partial sync, Leader election, How syncom works):
  the problem in a concrete scenario → the figure or live demo → the idea in prose → the code → trade-offs
  → `## Coming from RxDB`.
- **Recipe** (connectors, transports, storages): when to choose it (one paragraph) → steps in
  `<div class="sc-steps">` (each step a `###` heading, a sentence, a code block) → the options that matter
  (the rest is the reference) → Limitations → `## Coming from RxDB`.
- **Not in syncom** (an RxDB feature with verdict `absent`; under 60 lines): `<NotInSyncom page="…" />`
  right under the H1 → what the RxDB feature does, in your own words → why syncom does not have it (the
  design reason, linked) → how to get the same result in syncom, with a running example when one exists →
  `## Coming from RxDB`.
- **Hub** (Overview, Storage overview): recommendations by situation, then links or cards.

### Coming from RxDB

Every page named in `docs/rxdb-map.json` ends with `## Coming from RxDB`, under which:

1. one or two sentences on what an RxDB user should expect to work differently;
2. where it helps, a `::: code-group` with a `syncom` tab and an `RxDB` tab doing the same task — both
   included from files (`<<< @/examples/<page>.mjs#<region> [syncom]`, `<<< @/examples/rxdb/<page>.mjs#<region> [RxDB]`);
3. `<FromRxdb page="<rxdb id>" :rows="['<row id>', …]" />` — the verdict, RxDB's page and the rows of
   `docs/comparison-rxdb.json` this page is about (list the ids with
   `node -e "for (const g of require('./docs/comparison-rxdb.json').groups) for (const r of g.rows) console.log(r.id, '|', r.title)"`).

RxDB's pages and code are a specification of the topic only (Apache-2.0): never copy their prose, examples or
structure, and never use their branding, colours or illustration motifs. Write RxDB's side of a code group
anew from the types of rxdb 17.6.0 (`../../open-source/local-first-alternatives/rxdb/rxdb-17.6.0/`), and say
what RxDB does well where it does.

### Examples

Every code block of syncom code on a page is a region of a file in `docs/examples/`, included with
`<<< @/examples/<file>.mjs#<region>` (the region between `// #region <name>` and `// #endregion <name>`).
The file is ESM, imports by package name (`@alexify/syncom`, `@alexify/syncom/all`, …), and asserts what the
page claims with `node:assert/strict` outside the regions, so the page shows only the code a reader would
write. `tests/package/docs-examples.test.js` runs every file from an empty temporary directory (so a
`path` it opens is gone after) and checks every region a page names exists. Name a file after its page
(`quickstart.mjs`, `partial-sync.mjs`, several as `partial-sync-host.mjs`). Prefer the memory engine or a
`path` under the temporary working directory; close every database and server so the process exits.
A file that needs what Node lacks (OPFS, a SharedWorker, WebRTC, a real cloud service) starts with
`// docs-examples: browser-only (<reason>)` and is only parsed — keep those few, and run its logic in Node
where a stand-in exists (`fake-indexeddb`, the memory engine, `@alexify/syncom/testing`'s link). Shell
commands, JSON and type-only snippets stay inline.

### Figures and live demos

A mechanism that moves (ops travelling, a log growing, a leader changing) gets a figure:
`<SyncFigure>` components in `docs/.vitepress/theme/components/figures/`, each naming in its header comment
the `src/` files it depicts; a live demo (`components/live/`) runs real syncom in the page and reads only its
public events. Until a figure exists, a page marks its place with `<!-- figure: <name> — <what it shows> -->`.

### Components

Registered globally (no import): `<FromRxdb>`, `<NotInSyncom>`, `<DocsOverview>`; figures and demos as
they land. A page that uses a one-off component imports it in `<script setup>`.

## Documentation rules

Document what the code does today, and run each example before writing it down. A new page needs an entry in
a `docs/.vitepress/sidebar/*.json` file; `tests/package/docs-map.test.js` holds every guide page to one entry
and every entry of `docs/rxdb-map.json` to a page that has its `<FromRxdb>`. `docs/public/llms.txt` is
generated (`pnpm docs:llms`) from the sidebar and the frontmatter — never edited by hand.

Pages that describe a contract keep in step with its code: `docs/guide/replication.md`,
`docs/guide/sync-protocol.md` and `docs/guide/replication-websocket.md` with `src/sync/manager.js` and
`src/sync/hosting.js`; `docs/reference/wire.md` is the byte-level reference (slots, codes, payloads, the
signed header, the log and record files, the procedures, the bounds): a change to `packOps`, `wellFormed`,
`signedMessage`, a file format, a procedure or a bound lands with its row there — `docs/reference/events.md`
and `docs/guide/hooks.md` with the hook and event surface of `src/commit.js`, `src/apply.js`,
`src/bootstrap.js`, `src/database.js` and `src/sync/manager.js`, `docs/guide/schema.md` with `src/schema/`
(metaschema is the first-class example there; zod/ajv/JSON Schema are the alternatives), `docs/guide/query.md`
with `src/query/cursor.js` and `src/catalog.js`, `docs/reference/engines.md` and `docs/guide/storage.md` with
`src/engine.js`, `src/files/files.js`, `src/backend.js`, `src/lock.js`, the two `fsi` halves and the engines
(`src/memory/engine.js`, `src/idb/engine.js`, `src/sqlite/sqlite.js`, `src/mongodb/mongodb.js`). The
browser-only WebRTC recipes in `docs/guide/replication-webrtc.md` follow wrpc's documented API and the
raw-channel integration tests; they cannot be run here.

- **The matrix is data.** Every cell of `docs/comparison.json`, `docs/comparison-rxdb.json` and
  `docs/comparison-crdt.json` keeps the `source` it was decided from (and a `detail` for a footnote left out of
  the table); `pnpm docs:comparison` renders them, and the "Page by page" table of vs-rxdb.md from
  `docs/rxdb-map.json`. A cell about another project is decided from its source and official docs, not its
  README — the CRDT page from the clones in `../../open-source/local-first-alternatives/` at the commits it
  names; the syncom column from this repository. Keep the prose of docs/guide/comparison.md, vs-rxdb.md,
  vs-crdt.md and why.md in step with the counts.
