# docs/CLAUDE.md — Documentation

Examples run before they are written, the pages kept in step with the code, the matrices as data. what holds for the whole repository is in [CLAUDE.md](../CLAUDE.md).

## Layout

```
docs/comparison*.json     the feature matrices; scripts/comparison.js renders comparison.json into docs/guide/comparison.md,
                          comparison-rxdb.json into vs-rxdb.md, comparison-crdt.json into vs-crdt.md
docs/                     VitePress site
```

## Documentation

Document what the code does today. When adding docs, verify each example by
running it before writing it down — several examples inherited from the legacy
repo were wrong in exactly that way. A new page needs a sidebar entry in
`docs/.vitepress/config.mts`; `docs/guide/sync.md` and `docs/guide/wrpc.md`
are the two pages that describe the protocol — keep them in step with
`src/sync/manager.js` and `src/sync/hosting.js`, and `docs/reference/wire.md` is the
byte-level reference (slots, codes, payloads, the signed header, the log and record
files, the procedures, the bounds): a change to `packOps`, `wellFormed`, `signedMessage`,
a file format, a procedure or a bound lands with its row there — `docs/guide/hooks.md` with the hook and
event surface of `src/commit.js`, `src/apply.js`, `src/bootstrap.js`,
`src/storage.js` and `src/sync/manager.js`, `docs/guide/schema.md` with
`src/schema/` (metaschema is the first-class example there; zod/ajv/JSON
Schema are the alternatives), `docs/guide/query.md` with `src/query/cursor.js` and
`src/catalog.js`, `docs/guide/backends.md` with `src/backend.js`, `src/lock.js`
and the two `fsi` halves. The browser-only WebRTC recipes in
`docs/guide/webrtc.md` follow wrpc's documented API and the raw-channel
integration tests; they cannot be run here.

## Rules

- **The matrix is data.** Every cell of `docs/comparison.json`, `docs/comparison-rxdb.json` and
  `docs/comparison-crdt.json` keeps the `source` it was decided from (and a `detail` for a footnote left out of
  the table); `pnpm docs:comparison` renders them. A cell about another project is decided from its source and
  official docs, not its README — the CRDT page from the clones in `../../open-source/local-first-alternatives/`
  at the commits it names; the syncom column from this repository. Keep the prose of docs/guide/comparison.md,
  vs-rxdb.md, vs-crdt.md and why.md in step with the counts.
