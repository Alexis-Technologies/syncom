# src/editor/CLAUDE.md — The editor binding

The binding over a text handle, what the adapters share and never do. The rules of the core — the op model, the write paths, own keys, the log — are in [src/CLAUDE.md](../CLAUDE.md); what holds for the whole repository is in [CLAUDE.md](../../CLAUDE.md).

## Layout

```
src/editor/editor.js      the @alexify/syncom/editor subpath — the editor-agnostic binding (over a text handle,
                          `openText`: edits at once, others' changes as deltas, reloads), delta compose/transform,
                          diffSpans/diffBlocks, spans↔blocks, selections as tokens, presence cursors, what an adapter
                          shares (createFit, undoSteps, failureReporter); requires text/myers.js and text/quill.js only
```

## Rules

- **An editor binding stands on a text handle.** `createTextBinding` opens `storage.openText(id, path,
{ source, window })` (src/text/handle.js) and loads the editor from its `spans()`; the handle's
  reading is what the editor shows, so an edit the adapter reports goes to `handle.applyDelta` at
  once — resolved and stamped over that reading, never STALE, never rebased — and every other
  writer's change comes from `handle.observe` as a delta in the editor's indices (`local` ones are the
  editor's own). A `reset` from the handle (a change no delta says, a flush not logged) reloads the
  editor from `handle.spans()`; an editor that throws on a change, or a delta the handle refuses,
  the same; `MAX_FAILURES` in a row stop the binding, which closes its handle (logging what waits)
  and hears nothing after. Never answer a change with an edit, and never write the field through
  the storage while the handle holds edits — its indices are the storage's reading, not the
  editor's. A storage's `applyDelta(…, { expect, revision })` (EDIT-4) is for a caller without a
  handle: a whole document's delta made over a reading it holds.
- **An editor adapter injects its editor and fits the field to its schema.** `/prosemirror`
  (and `/codemirror`) take the editor's modules as an argument and require nothing of them
  — the packages are devDependencies for skip-guarded tests and optional peerDependencies for
  their types. A ProseMirror document is a marker per block-level node in document order
  (`docToSpans`/`spansToDoc`); what the schema cannot hold is left out when it is read back.
  The adapter NEVER answers a peer's change with an edit: what the document differs from the
  field by (`unfit`, a `createFit` of src/editor/editor.js) is held and goes out composed with the
  editor's next edit (`fit.send`) — two editors that each fitted a merge sent the same structure twice, unfit again,
  and answered each other without end. Until then the adapter's `base` is the binding's view
  and every index crosses `unfit` (`toDoc`/`toField`: the selection, the cursors,
  `indexOf`/`posOf`) — a delta in the document's indices lands askew. `/codemirror` does
  the same for line breaks: `lineBreaks(text)` is the fit and its way back (an insert before
  a delete, so an index beside a break stays beside it — a Myers diff pairs it with another
  `\n`), and a peer's delta over a held fit lands as the field's text read again
  (`state.toText`, then the diff), never transformed over the fit: both would insert the `\n`. A send
  that fails other than STALE reloads the editor from the handle's reading at once and the
  binding stops after `MAX_FAILURES` in a row: never retry in a microtask loop (it starved the
  event loop for hours once).
