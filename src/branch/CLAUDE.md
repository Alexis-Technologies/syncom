# src/branch/CLAUDE.md — Branches

A fork opened through the parent's constructor, a merge as a push. The rules of the core — the op model, the write paths, own keys, the log — are in [src/CLAUDE.md](../CLAUDE.md); what holds for the whole repository is in [CLAUDE.md](../../CLAUDE.md).

## Layout

```
src/branch/branch.js      the @alexify/syncom/branch subpath — fork a storage, merge either way; never requires storage.js
```

## Rules

- **A branch is a storage; a merge is a push.** `src/branch/branch.js` opens the
  fork through `parent.constructor` (the subpath bundles no engine), never
  copies the directory (a copied identity is `SELF`/`REWOUND`), gives it
  `retention: { ops: 0 }` + `autoStart: false`, joins the parent's (or the
  tag's) snapshot pages and adopts the vector. `merge` = `outbound(source.log,
{ exclude: into.nodeId, vector: into.vector, own: source.nodeId,
allStreams: true })` → `into.applyRemote(page, { via: { url: null, node },
adoptFrom: source })` — the one selection `#pushFromLog` uses too
  (`src/outbound.js`; change one, change both: a push asks `first` of the
  sender's own streams, a merge of EVERY stream, and joins as state when one
  is out of reach). No-echo is `exclude` on `origin`/`from` plus `vectorHas`;
  never add a third filter. `drop()` refuses a storage without `branch.json`
  (`sweep` is the shared remover, used by a failed `branch()` too), and
  `branch()` refuses a path that holds files: another storage is never taken
  over.
