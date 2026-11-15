# src/schema/CLAUDE.md — Schemas

The validator after `applyOp`, the lens. The rules of the core — the op model, the write paths, own keys, the log — are in [src/CLAUDE.md](../CLAUDE.md); what holds for the whole repository is in [CLAUDE.md](../../CLAUDE.md).

## Layout

```
src/schema/schema.js      @alexify/syncom/schema — the schema plugin: setup(ctx) hands the core the definitions and the lens (`schema` hook)
src/schema/define.js      entity definitions, the injected validator (Standard Schema / ajv / compile) — normalizeSchema; requires errors.js only
src/schema/lens.js        createLens — how an older record reads under this version (migrations, then the validator)
src/schema/api.js         what the plugin does over the lent core: loadVersion (schema.json, at open), migrate() and check(),
                          migrateRecord (one record, migrate()'s and a local write's first step)
src/schema/entity.js      project / unproject / foldSet — the record as its validator sees it, the validated value as the op carries it;
                          the core's side of the schema (commit.js and database.js require it), shared with the lens — requires shape.js,
                          paths.js only
```

## Rules

- **Validation is after `applyOp`, before `#log.append`.** An entity's
  validator (adapted in `src/schema/define.js`, the schema plugin's; the core
  only applies what the plugin's `schema` hook handed it, through
  `src/schema/entity.js`) sees
  the record as the op leaves it, under `idField` and without `$type`, and
  for a local `write`/`set` what it returns is folded back INTO the op
  (defaults, aliases, stripped keys), so peers receive the validated record;
  a `set` keeps only its own keys plus the ones the record lacked. A local
  field op (`set`, `unset`, `inc`, `add`, `remove`, a plugin kind's) on a live
  record whose `meta.v` is below this version MIGRATES IT FIRST, in one
  transaction with the op: `migrateRecord` (api.js, the core's `upgrade`) lays
  the view as a whole-record `write` at this version, its counters, sets and
  blocks again, then the op — `commit` routes such an op through `transact`,
  and `commitIn` migrates before it prepares. Left at its version, the record
  would be lensed with the op's fields in it and `up` would read them over
  (`name: title` over the new `name`). The migration's ops are `UNCHECKED` (the
  validator sees the op after them, over the record as both leave it); an op
  that makes nothing throws the transaction away; a handle's resolved edits
  (`commitResolved`) never migrate. A peer's op is never rewritten: the verdict
  alone decides, and a failing op is skipped exactly like a `beforeApply`
  false (`skipped: true`, vector moves, relayed, `error` event). `$type` is
  immutable on the local path and restored after every fold. Validators are
  `~standard`, a function, or `validator.compile` — do not add a fourth
  duck-type.
