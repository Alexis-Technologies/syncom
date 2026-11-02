# src/local/CLAUDE.md — Local documents

Values beside the records that never become an op. The rules of the core are in [src/CLAUDE.md](../CLAUDE.md); what holds for the whole repository is in [CLAUDE.md](../../CLAUDE.md).

## Layout

```
src/local/local.js        @alexify/syncom/local — the `local` plugin: setup hands the core `db.local` (the `local` hook), a LocalStore over
                          the `local` kv namespace; `collection.local` is `scoped(name)` — requires engine.js, hooks.js only
```

## Rules

- **A local document is never an op.** It lives in the `local` kv namespace (src/engine.js KV_NAMESPACES: swept by
  `engine.remove`, copied by `copyEngine`), is never logged, never in the catalog or a snapshot, never at a peer; the
  `local` event and `observe()` are this instance's. A key is a kv key (no `/`); a collection's keys are `<name>.<key>`.
