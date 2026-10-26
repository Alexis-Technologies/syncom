# Editors

An editor holds its own document; syncom holds the field. `@alexify/syncom/editor`
keeps the two the same: the editor's edits reach the field as one
transaction each, a peer's edits reach the editor as deltas, and an edit the
field moved under is refused and sent again rebased, so nothing is lost and
nothing lands twice. It is the binding every editor adapter builds on, and
it asks three functions of the editor.

```js
const { open } = require('@alexify/syncom/all');
const { createTextBinding } = require('@alexify/syncom/editor');

const storage = await open({ path: 'data' });
const binding = createTextBinding(storage, id, 'body', adapter);
await binding.ready; // the editor holds the field
// … type …
await binding.flush(); // every edit reported so far has landed
binding.stop();
```

## The adapter

```ts
interface EditorAdapter {
  setContents(ops: DeltaOp[]): void; // the document replaced whole
  updateContents(delta: DeltaOp[]): void; // a delta applied, not reported back
  onChange(listener: (delta: DeltaOp[]) => void): () => void; // the editor's own edits, as deltas
}
```

A delta is Quill's form — `[{ retain, attributes? }, { insert, attributes? },
{ delete }]` — over the document as it was; an embed slot or a block marker
travels as `{ insert: { embed: marker } }`, a marker changed as `{ retain:
1, attributes: { embed: marker } }`, a mark as attributes over its range
(`null` takes one off). For Quill itself the adapter is nearly the editor
(shaped after its API; the repository's tests run a fake editor of the same
shape, `tests/suites/editor.js`):

```js
const adapter = {
  setContents: (ops) => quill.setContents(ops, 'silent'),
  updateContents: (delta) => quill.updateContents(delta, 'silent'),
  onChange: (listener) => {
    const handler = (delta, _old, source) => source === 'user' && listener(delta.ops);
    quill.on('text-change', handler);
    return () => quill.off('text-change', handler);
  },
};
```

An editor that reports its edits as deltas is bound as it is; one that
holds a document of blocks hands over the whole document and lets
`diffBlocks()` find the delta — see [Whole documents](#whole-documents).

## What the binding does

The binding keeps a **shadow**: the field's text as the storage reads it
(U+FFFC for an embed slot) after every change it has processed. The editor
holds the shadow plus its own edits not yet landed — one delta **in
flight**, and what was typed since, **pending**.

- **Editor → field.** An edit reported is composed into `pending`; one
  delta at a time goes to `applyDelta(id, path, delta, { expect })` with
  `expect` the shadow it was made over — one transaction, one log append,
  `source` the binding's. Its own `transaction` event moves the shadow on
  and frees the next send.
- **Field → editor.** `observe(id, path)` hands the field's changes a turn
  at a time — a local write, a peer's page, a joined snapshot — and
  `toDelta` composes them into one delta over the shadow. A peer's delta is
  rebased over what the editor holds beyond the shadow (the in-flight
  delta, then the pending one) and handed to `updateContents`; the editor
  never sees it in the shadow's indices.
- **The race.** A peer's edit may land in the field between the shadow the
  binding read and the delta it sent. Inside the mutation queue,
  `applyDelta` compares the field's text with `expect` and refuses with
  `STALE` before any op; the binding has rebased the refused delta over the
  peer's by the time that delta reached the editor — the peer's insert first
  where both inserted at one index, the order the storage holds them in —
  and sends it again. Two editors on one storage, or on two nodes, converge
  on the field whatever the interleaving.
- **A reset.** A change no delta can say — the record written whole, the
  field unset, the record deleted or purged — reloads the editor from the
  field and drops what was not sent; `onReset` hears it.

`binding.pending` says whether an edit is on its way, `binding.shadow` what
the field reads as, `flush()` resolves once every edit reported so far has
landed. An insert's attributes are exactly its marks: a mark that would
have grown over text typed at its end is taken off that text, and a splice
change reports the marks its content reads with, so both sides agree
without reading the field. A `many` mark (several of one name over a range)
is not a delta's: it reads as a list in `spans()` and is left as it is.

## Whole documents

An editor whose document is a tree of blocks — paragraphs, headings, list
items — maps to one text with block markers (see
[Embeds and blocks](./lists#embeds-and-blocks)). The pure helpers turn a
reading into blocks and back, and a new reading into the delta that makes
it:

```js
const { spansToBlocks, blocksToSpans, diffBlocks, spansToDelta } = require('@alexify/syncom/editor');

const before = await storage.blocks(id, 'body'); // [{ index, type, parents, attrs, spans }]
const after = structuredClone(before);
after[0].attrs = { level: 2 }; // the heading's level
after[1].spans = [{ type: 'text', text: 'First paragraph.', marks: {} }];
const delta = diffBlocks(before, after); // cuts and inserts, markers changed, marks changed
await storage.applyDelta(id, 'body', delta, { expect: binding.shadow });
```

`diffSpans(before, after)` is the same over typed spans; `spansToDelta()`
and `deltaToSpans()` turn a reading into a document delta and back. The
delta is in the write API's terms, so `applyDelta` applies it as one
transaction and a peer sees the edit land whole — and under `expect` it is
refused rather than misplaced when the field moved meanwhile.

## Selections

A selection kept as indices is wrong after the next edit around it; kept as
[cursor tokens](./lists#cursors) it survives them:

```js
const { selectionToTokens, tokensToSelection, transformIndex } = require('@alexify/syncom/editor');

const tokens = await selectionToTokens(storage, id, 'body', { anchor: 6, head: 11 }); // { id, field, anchor, head }
// … edits land around it …
await tokensToSelection(storage, tokens); // { anchor: 12, head: 17 }, or null once a place is gone
transformIndex(3, [{ retain: 3 }, { insert: 'ab' }]); // 5: where an index is once a delta applied
```

`transformIndex(index, delta, priority)` moves an index through a delta
synchronously — for an adapter whose editor does not move its own
selection on `updateContents`; with `priority`, an insert at the index
itself stays behind it.

## Presence

A selection as tokens is what a presence state carries, and a presence
room's cursors resolve to indices on the node that renders them:

```js
const { createPresence } = require('@alexify/syncom/presence');
const { presenceCursors } = require('@alexify/syncom/editor');

const presence = createPresence(storage);
storage.sync.presence(presence);
await presence.set({ name: 'ada', cursor: await selectionToTokens(storage, id, 'body', { anchor: 3 }) });
await presenceCursors(presence, storage, id, 'body'); // [{ node, state, anchor, head }] — the states whose `cursor` is on this field
```

See [Presence](./presence) for the room and its bounds.

## Deltas

The helpers the binding is built from are exported: `compose(a, b)` is the
delta that does `a` then `b`; `transform(a, b, priority)` is `b` rewritten
to apply after `a`, the two made over one base — applying both ends the
same whichever came first, `a`'s insert first at a tie when `priority`;
`applyToText(text, delta)` is a text once a delta applied. They are what
Quill's `Delta` does, written here so the subpath needs no dependency.

## Limits

- The binding is for a **text** field; a list is read and written through
  the [list API](./lists) directly.
- A reset drops what was not sent. An editor that must keep it reads
  `binding.shadow` in `onReset` and decides.
- `applyDelta` makes one op per insert, cut and mark; a delta of many
  pieces is many ops in one transaction, signed and logged like any other.
  Batch keystrokes where you can.
- The record's other fields, and a record's `delete`, are the storage's as
  ever — the binding touches one field.
