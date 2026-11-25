# src/undo/CLAUDE.md — Undo

The stack of inverse patches over the commit event. The rules of the core — the op model, the write paths, own keys, the log — are in [src/CLAUDE.md](../CLAUDE.md); what holds for the whole repository is in [CLAUDE.md](../../CLAUDE.md).

## Layout

```
src/undo/undo.js          the @alexify/syncom/undo subpath — the undo stack over the commit event; requires patch.js, emitter.js, symbols.js, paths.js and argument-errors.js only
```

## Rules

- **A step of the undo stack is a transaction's worth, with the app's meta.**
  `#commit` in src/undo/undo.js joins a commit to the top step when the open
  `group()` takes it, when its `txn` is the step's, or within `mergeInterval`;
  `trackedSources`/`records`/`paths` filter commits first (`reaches` reads
  the commit's `changes`; a whole-record change reaches no path). The step's
  `meta` object is handed out as it is (`stepView`) and copied by reference
  to the opposite stack's step on undo/redo — never cloned. Under `paths` the
  inverse is `scoped` to the tracked fields before the conflict check;
  `typesAround` counts a change at a prefix or under the field as the
  field's.
- **Undo is a subpath over `commit`, never inside the engine.** The model —
  steps of inverse patches, refuse-to-overwrite, the exact and the loose
  inversion — is the header of `src/undo/undo.js`. What crosses modules: the
  manager applies through `storage.applyPatches(id, kept, { source: token })`
  and tells its own commits by the token; every `remove` it makes is `own:
true`; conflicts are read from `log.entriesOf(id)` after the step's
  `lastSeq` (an `inc` or an `add`/`remove` by others commutes with the
  inverse, `conflicting`), so it `log.pin`s from its oldest step. `kindsOf`
  lives in ops.js (it needs the predicates) and `deepEqual` in shape.js, so
  patch.js and the subpath ship without the op model — keep it that way. The
  stack is memory only; a `purge` forgets the record on every step.
- **A step's two sides have each their own kinds.** `Kept` reads `kindsBefore` off the step's first commit (its
  `kinds`, with `was` where that op changed a kind) and `kindsAfter` off its last (`kinds`): a step may leave a
  field of another kind than it found it — an `unset`, then the field made again — and one map merged over the
  step read a register's value as a counter's sum (a TypeError from `realize`) or brought a counter back as a
  register. The way back of such a field is an `unset` and the field made again (src/patch.js), with no looser
  form: where others touched the field since, its patches are skipped TOGETHER (`reset` in `#apply`) — the
  made-again kind taken alone as the "loose" alternative lands on a field of the other kind and refuses the whole
  undo (`ALX_ERR_FIELD_KIND`).
