# src/schema/CLAUDE.md — Schemas

The validator after `applyOp`, the lens. The rules of the core — the op model, the write paths, own keys, the log — are in [src/CLAUDE.md](../CLAUDE.md); what holds for the whole repository is in [CLAUDE.md](../../CLAUDE.md).

## Layout

```
src/schema/schema.js      @alexify/syncom/schema — the schema plugin: setup(ctx) hands the core the definitions and the lens (`schema` hook)
src/schema/define.js      entity definitions, the injected validator (Standard Schema / ajv / compile) — normalizeSchema; requires errors.js only
src/schema/lens.js        createLens — how an older record reads under this version (migrations, then the validator)
src/schema/api.js         what the plugin does over the lent core: loadVersion (schema.json, at open), migrate() and check(),
                          migrateRecord (one record, migrate()'s and a local write's first step: what the lens changed, as one
                          `version` op) — requires errors.js, shape.js, compose.js, entity.js only
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
  transaction with the op: `migrateRecord` (api.js, the core's `upgrade`),
  then the op — `commit` routes such an op through `transact`,
  and `commitIn` migrates before it prepares. Left at its version, the record
  would be lensed with the op's fields in it and `up` would read them over
  (`name: title` over the new `name`). The migration's ops are `UNCHECKED` (the
  validator sees the op after them, over the record as they leave it); an op
  that makes nothing throws the transaction away; a handle's resolved edits
  (`commitResolved`) never migrate. A peer's op is never rewritten: the verdict
  alone decides, and a failing op is skipped exactly like a `beforeApply`
  false (`skipped: true`, vector moves, relayed, `error` event). `$type` is
  immutable on the local path and restored after every fold. Validators are
  `~standard`, a function, or `validator.compile` — do not add a fourth
  duck-type.
- **A record's version is a register of its own, and two ops say it.** `meta.v` with `meta.vs`, the stamp of the
  op that decided it: last writer wins (`moveVersion` in src/ops.js) among a whole-record `write` and a `version`
  op, each by its own stamp and its own `v`, WHATEVER THE BASE IS — a `delete` moves the base and no version, a
  `write` stale under the base still says one — so the pair is the same in every order of arrival, on the op path
  and in `mergeEntry` (the pair of the newer `vs`) alike: a `write` of an older version stamped above a migration
  makes the record that version again (it is in that shape), one stamped below it does not. `normalizeMeta` keeps
  both or neither, `latestClock` reads `vs`, a purge takes the pair, a `write` without a `v` says none. A field op
  never moves it, the one that makes the record neither: a version read off "the first op the record saw"
  differed with the order — a local `set` that makes a record goes as a `version` carrying its fields where the
  node's version is above 1 (`opOf` in src/commit.js; a record no op gave a version reads as 1). A `version` op is
  `{ v, value?, data? }`: the names it removes (an `unset`'s rule), then the registers it sets (a `set`'s), at
  ONE stamp, nothing else reset; it reports the `unset`s and `put`s it made, is `VALIDATED` on both paths like a
  `set` (never a door around a validator), is not among `WHOLE`, and travels as code `v` (src/sync/wire.js). Do not add a third op that says a version, nor a rule that reads one off the order of arrival.
- **A migration writes what the lens changed, never the record.** `migrateRecord` compares the record as it reads,
  name by name (a top-level name with everything under it: `compose` of the entry against `core.view`), and makes
  ONE `version` op (src/CLAUDE.md: the record's version is a register of its own, moved by a `write` or a
  `version`): the names the lens removed (`value`), the registers it wrote (`data`). A name the lens left as it
  read is not written, whatever its kind — its block, slots, tags and stamps stay, and a peer's concurrent op on
  it lands — which is the point: a whole-record `write` here was a reset, and one keystroke into an old record
  flattened its text and dropped every edit stamped below it. A counter, a set, a list, a text or a tree the lens
  DID change is unset in the `version` op and laid again after it, by the kind's own `migrate` (one `inc`, one
  `add`, one run, one move per node): in place where the new value `fits` the kind, under a new name where that
  name reads exactly as a removed one did (a rename is told by the value, nothing else says it; the kind is handed
  `from`, the entry and the old name, so a text's marks and embed values come along); as a register
  where the type changed or something hangs under the name (`parents`: a path, a member's field — the composed
  reading is one value there); left out where it reads empty (no op makes an empty set, list, text or tree, and a
  register in its place would refuse the kind's next op on that record alone). The unset is what keeps two
  migrations from laying a field twice (the later watermark takes the earlier lay; two that interleave within
  the same milliseconds both stay — documented). `migrate()` runs one record a transaction (`core.transact`),
  read again inside the queue, and counts per kind the fields laid again. Never bring the whole-record write back
  to "simplify" this, and never lay a field the lens did not change.
