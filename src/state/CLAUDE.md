# src/state/CLAUDE.md — Persistent app state

One object a node keeps by name, by path. The rules of the core are in [src/CLAUDE.md](../CLAUDE.md); what holds for the whole repository is in [CLAUDE.md](../../CLAUDE.md).

## Layout

```
src/state/state.js        @alexify/syncom/state — createState(db, name, { local }): get/set/delete/observe by path over the record
                          `state.<name>` (a path a register of its own) or the local document `state.<name>` — requires paths.js, shape.js only
```

## Rules

- **A path is a register.** Over a record, `set('a/b', v)` is `update(id, { 'a/b': v })`: two nodes writing different
  paths of one state both keep theirs, and a function (`set(path, fn)`) runs inside a transaction over the record as it
  is. Over a local document the whole object is written at once (one node's; no merge) — through the local store's
  `set(key, fn)`, one change of the document at a time, so sets made at once compose.
