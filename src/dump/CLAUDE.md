# src/dump/CLAUDE.md — Dumps

A database as JSON and back. The rules of the core are in [src/CLAUDE.md](../CLAUDE.md); what holds for the whole repository is in [CLAUDE.md](../../CLAUDE.md).

## Layout

```
src/dump/dump.js          @alexify/syncom/dump — exportPages/exportJSON (snapshot pages: tombstones with their meta, or the live
                          data alone), importJSON (merge = mergeSnapshot, insert = plain writes under the same ids; SCHEMA_MISMATCH),
                          migrateStorage (copy = copyEngine, merge = export into another open database) — requires symbols.js,
                          shape.js, errors.js, the engines' copy.js only
```

## Rules

- **A merge is a bootstrap, an insert is a write.** `merge` joins records with their meta through `mergeSnapshot` — one
  `merge` op per record, this node's own, exact to the source; `insert` makes new ops with new stamps and takes a dump
  with no meta (another database's). A dump made under another schema hash is refused unless forced: a reader that
  lenses records by version would otherwise read them wrong.
