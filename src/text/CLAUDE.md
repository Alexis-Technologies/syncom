# src/text/CLAUDE.md — The list and text kinds

The sequence engine and its rope, embeds, marks, what an op may never read whole. The rules of the core — the op model, the write paths, own keys, the log — are in [src/CLAUDE.md](../CLAUDE.md); what holds for the whole repository is in [CLAUDE.md](../../CLAUDE.md).

## Layout

```
src/text/text.js          @alexify/syncom/text — the list and text kinds as a plugin: the plugin object over the four modules below
src/text/kind.js          what the core calls of the kinds: codes and ranks, apply/join/prune/render/resolve and the change an op
                          reports, the index resolved into what travels, a list's members' seam, the embed markers
src/text/diffs.js         the kinds' patches: the diff of two readings as splices (src/text/myers.js), realize, recreate, migrate,
                          compact, who wrote the field (editors), what it holds beside its reading (values)
src/text/methods.js       the storage methods of the kinds (splice, push, updateText, mark, spans, cursors, blocks, setAt, move…)
                          over the lent core
src/text/deltas.js        toDelta and applyDelta: a turn's changes as a Quill delta, a delta as one transaction (src/text/quill.js)
src/text/handle.js        openText, TextHandle — a synchronous editor's handle: edits made over its overlay (the field as announced,
                          its edits on top) through the lent `core.editing`, coalesced, logged as one transaction a window later
                          (`tx.commitResolved`); the base follows the `transaction` events; what the editor binding stands on
src/text/quill.js         Quill-form deltas and their algebra, once — compose, transform, transformIndex (quill-delta's rules): the
                          plugin's toDelta and the editor binding (src/editor/editor.js) both stand on it — no requires
src/text/rle.js           run-length content: a run's pieces and gaps, cut, append, merge, the canonical form under MAX_RUN —
                          no requires; sequence.js is the caller and re-exports what the tests read
src/text/btree.js         the rope: a persistent B+-tree over a block's segments and fences with two measures (slots, visible),
                          path copying, hints tagged by lineage, a text cache per node — no requires
src/text/pmap.js          a persistent hash map (HAMT): the run records of a block, one changed per keystroke — no requires
src/text/plist.js         a persistent sorted list in chunks: a placed run's segments, the children at its offsets — no requires
src/text/sequence.js      the sequence engine behind the list and text kinds: its design (the header) and its public names, over the
                          five modules below — the one file the rest of syncom requires of the engine
src/text/keys.js          the engine's names: run and element keys, anchors, the checks a peer's block is read through, the refusals
                          an op reports, a mark's flags — requires vector.js only
src/text/state.js         a block's engine state (the WeakMap beside the plain object), a plain block's JSON made whole and hydrated
                          into the rope (indexOf: once per plain block), every reading — elements, values, positions, cursors, what waits
src/text/splice.js        what an op does: the draft, a run placed with what hangs under it (walkSubtree, placeRun), cuts and
                          extensions, pending ops, a splice; the pos/vals registers — assign and move
src/text/marks.js         marks: the anchors of a range, a mark applied or switched off, the index of the marks in force (styleAt)
src/text/join.js          a block as a snapshot carries it: a peer's block normalized under the bounds, prune (the reset rule), join
```

## Rules

- **An embed is a character with a value.** A text's embed slot is U+FFFC in
  the content (`EMBED` in `src/args.js`) and its marker `{ type, parents,
attrs, isEmbed }` an entry of the block's `vals` (as a list element's
  value): a `splice` payload carries `vals: [[offset, marker]]` for the
  slots its content holds and `applySplice` lands them with the slots; an
  `assign` lands on a text's slot too, carrying `k: 't'` (`kindOfOp` reads
  the op alone — a kind read from the held block would not commute — so a
  text's assign ranks as a text and an unmarked one as a list). `spliceArgs`
  refuses U+FFFC in plain content unless `{ embeds: true }` — only
  `insertEmbed`/`splitBlock` and a patch with `vals` pass it — and
  `updateText` refuses a hunk that inserts one. The engine knows no marker:
  `S.valueAt` hands back what the slot holds, `markerOf` in
  src/text/kind.js normalizes it (another shape reads as none), `spans()`
  types every span (`text`/`embed`/`block`). A diff needs what the reading
  leaves out: `diffViews(..., { context: { from, to } })` hands the plugin
  the entries (versions, compact) or the `embeds` a `commit` event carries
  (undo; built by the plugin's `values(entry, field)` in `announce`) — a
  splice patch gets `vals`, a changed marker a `setAt` patch (b-side index,
  after the splices). Never diff a text without the context where a slot may
  be: the inverse would lay a bare slot.
- **While a handle is open, a run grows from one reading at a time.** A handle and the storage
  are writers of one origin, each over its own reading, and the engine takes an extension at an
  offset the run holds as a duplicate — dropped. So `resolveSplice` (src/text/kind.js `extendsRun`)
  reserves a run's next offset in `core.editing.extents` for every extension while a handle is
  open, and a writer whose reading is behind it anchors a run of its own after the run's last
  element (HANDLE-4); the last handle closed clears the map, a rehearsal reserves nothing. A new
  local writer of a text resolves through `resolveSplice` with the storage's core, or loses
  characters.
- **An op's own references are short; the engine reads full names alone.** `resolve` (src/text/kind.js)
  names what is the op's own origin's without it — `run`, a cut's run and a mark's `off` by the stamp (a
  number), an element as `ts:offset`, an anchor `<ts:offset`/`>ts:offset` — and `fullRefs` lays
  `op.origin` back in `apply`, before the engine, copying only what it changes; a short name is never
  another origin's (LIST-7). `coalesce` compares both forms. A new reader of an op's payload goes through
  `fullRefs`, never `S.parseRun` on the raw value.
- **A block IS the index, and it is never mutated in place.** A block of
  `src/text/sequence.js` is a plain object — `k`, `ts`, the maps, and `runs`
  as a getter that serializes the rope in walk order once per version — whose
  engine state is in a WeakMap of src/text/state.js (the engine's modules alone read it): the rope (`src/text/btree.js`),
  the run records (`src/text/pmap.js`; a placed record's segments and the
  children at its offsets in `src/text/plist.js`), what waits, the counts the
  bounds read. Nothing else is on the object (`lengthOf`, `totalOf`, `render`
  are the engine's). Every op goes through `draft`/`finish`: a new block, the
  structures path-copied, the block before reading as it did; `indexOf(entry,
field)` hydrates plain JSON once (a WeakMap keyed by the plain block, under the field's floor:
  the reading before an op and the op share it) and hands an engine block back as it is. A
  marks index (anchors in walk order) rides in the engine state across every op that leaves the
  marks; a body grows by `SEG_MAX` slots at most; a list's reading is made when it is read
  (`lazy: { list: true }` → src/lazy.js), derived from the one before where that one was read
  (`deriveLater`: one reading kept, never a chain of versions), else whole. Hints — an item's leaf, a node's parent — are right
  for the HEAD of a lineage only: an edit, a position or a neighbour asked of
  an older block forks it into a lineage of its own (`ensureHead`,
  `stats().rebuilds`) and the tree re-hints itself once (`T.stats().rehints`);
  a top-down reading never reads a hint. A text's reading is the rope's
  cache per node (`T.text`): after one op it costs the path the op copied,
  never the text. A run is placed whole with what hangs under it
  (`walkSubtree`, `placeRun`; a run under a parent not here yet is attached
  to it, `attachChild`, and walked when the parent lands); a stretch of a run
  with no child at it is emitted piece by piece (`emitPieces`), never slot by
  slot. `prune` is O(1) through `oldest`/`oldestAnchor` and rebuilds from
  JSON only under a base it has not seen. `latestClock(meta, true)` is the
  trusted path for an entry this node holds — a peer's raw meta takes the
  untrusted one, which normalizes first.
- **Nothing on an op's path reads the whole text or walks the whole cache.** A change report,
  a check or a resolve reads the rope: `S.spansOf`/`S.spanOf` for a run's stretches, `S.styleAt`
  for the marks at one index, `S.heldAt` for a unit — never `S.render(...)` sliced or `S.spans`
  (a fresh reading is a V8 rope, and a slice or a `charCodeAt` flattens it), and the rope's
  leaves concatenate their bodies, never `join` (src/text/btree.js `textOf`). `EntryStore.remember`
  looks at `EVICT_SCAN` of the oldest entries at most, and the deferred window lands by count as
  well as by time (`DEFER_RECORDS`, `DEFER_POSITIONS`): an await loop over `memory()` never lets
  a timer fire. Each of these was once O(n) per op and took a typing rate from tens of thousands
  to a few thousand; `bench/compare` (fresh process, thousands of awaited ops) is what shows it —
  a short microbenchmark inside one deferred window does not.
