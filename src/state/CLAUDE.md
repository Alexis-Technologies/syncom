# src/state/CLAUDE.md — Persistent app state

One object a node keeps by name, by path. The rules of the core are in [src/CLAUDE.md](../CLAUDE.md); what holds for the whole repository is in [CLAUDE.md](../../CLAUDE.md).

## Layout

```
src/state/state.js        @alexify/syncom/state — createState(db, name, { local }): get/set/delete/observe by path over the record
                          `state.<name>` (a path a register of its own) or the local document `state.<name>` — requires paths.js, shape.js, symbols.js and argument-errors.js only
```

## Rules

- **A path is a register.** Over a record, `set('a/b', v)` is `update(id, { 'a/b': v })`: two nodes writing different
  paths of one state both keep theirs, and a function (`set(path, fn)`) runs inside a transaction over the record as it
  is. Over a local document the whole object is written at once (one node's; no merge) — through the local store's
  `set(key, fn)`, one change of the document at a time, so sets made at once compose.
- **No path's write is a whole-record write.** The record is made by its first path's `set` — the transaction api's
  `update(id, delta, { [CREATE]: true })` (src/symbols.js `CREATE`, kept off the public surface): absent, a `set` that
  makes the record and keeps the paths another node made it with; deleted (a tombstone a `db.delete()` left), a
  `write`, the one op that revives. A `tx.set(id, { [path]: v })` there was a reset: a new device setting one path
  before its first sync wiped every path the others had set. `delete()` of the whole state writes the record empty
  (`tx.set(id, {})`), never a tombstone: delete wins over a field op, so a path set after it on any node must land
  on a live record. `set(object)` of the whole state is the one whole-record write, on purpose.
