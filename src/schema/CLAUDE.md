# src/schema/CLAUDE.md — Schemas

The validator after `applyOp`, the lens. The rules of the core — the op model, the write paths, own keys, the log — are in [src/CLAUDE.md](../CLAUDE.md); what holds for the whole repository is in [CLAUDE.md](../../CLAUDE.md).

## Layout

```
src/schema/schema.js      @alexify/syncom/schema — the schema plugin: setup(ctx) hands the core the definitions and the lens (`schema` hook)
src/schema/define.js      entity definitions, the injected validator (Standard Schema / ajv / compile) — normalizeSchema; requires errors.js only
src/schema/lens.js        createLens — how an older record reads under this version (migrations, then the validator)
src/schema/api.js         what the plugin does over the lent core: loadVersion (schema.json, at open), migrate() and check()
```

## Rules

- **Validation is after `applyOp`, before `#log.append`.** An entity's
  validator (adapted in `src/schema/define.js`, the schema plugin's; the core
  only applies what the plugin's `schema` hook handed it, through
  `src/entity.js`) sees
  the record as the op leaves it, under `idField` and without `$type`, and
  for a local `write`/`set` what it returns is folded back INTO the op
  (defaults, aliases, stripped keys), so peers receive the validated record;
  a `set` keeps only its own keys plus the ones the record lacked and is
  never promoted to a `write`. A peer's op is never rewritten: the verdict
  alone decides, and a failing op is skipped exactly like a `beforeApply`
  false (`skipped: true`, vector moves, relayed, `error` event). `$type` is
  immutable on the local path and restored after every fold. Validators are
  `~standard`, a function, or `validator.compile` — do not add a fourth
  duck-type.
