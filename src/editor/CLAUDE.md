# src/editor/CLAUDE.md — The editor binding

One delta at a time with `expect`, the rebase, what the adapters share and never do. The rules of the core — the op model, the write paths, own keys, the log — are in [src/CLAUDE.md](../CLAUDE.md); what holds for the whole repository is in [CLAUDE.md](../../CLAUDE.md).

## Layout

```
src/editor/editor.js      the @alexify/syncom/editor subpath — the editor-agnostic binding (shadow, one delta in
                          flight, STALE and the rebase), delta compose/transform, diffSpans/diffBlocks, spans↔blocks,
                          selections as tokens, presence cursors, what an adapter shares (createFit, undoSteps,
                          failureReporter); requires text/myers.js, vector.js and delta.js only
```

## Rules

- **An editor binding sends one delta at a time, with `expect`.** `applyDelta(id, key,
delta, { expect })` compares the field's text inside the queue and refuses `STALE` before
  any op; `src/editor/editor.js` keeps a shadow of the field, rebases a refused delta over
  the peer's (`transform`, the peer's insert first at a tie — the storage's order) and
  sends it again, and rebases a peer's delta over what the editor holds beyond the shadow
  before handing it over. A binding or adapter that resolves an editor's indices against
  the storage without `expect` races a peer's edit; a nested `transact` (a plugin method
  inside a transaction) runs within the enclosing one. `expect` compares text alone: a peer's
  change made of the characters it replaced passes it, and the delta lands by index over the new
  ones — so a binding that rebased its delta in flight (`rebased`) reads its own event against
  the rebased delta and reloads where they differ. A send that failed holds every later send until
  its reload (`reloading`), and `load()` drops `pending` before `setContents`: what was typed
  over the old contents is never sent over the new.
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
  that fails other than STALE reloads the editor after a growing pause and the binding stops
  after `MAX_FAILURES` in a row: never retry in a microtask loop (it starved the event loop
  for hours once).
