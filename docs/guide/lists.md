# Lists, text and trees

::: tip The kinds on this page are plugins
Lists and texts are the `text` plugin (`@alexify/syncom/text`), trees the
`tree` plugin (`/tree`): `open({ plugins: [text, tree] })`, or open through
`@alexify/syncom/all`, which has both. See [Entry points](/guide/entry-points).
:::

A field can be a **list** — an array that nodes edit by position — or a
**text** — a string they type into — or a **tree** — nodes moved under one
another without ever forming a cycle ([Trees](#trees), below). Two nodes that insert at the same spot
both keep what they wrote, each writer's run whole, and a deleted element
keeps its place so the anchors into it still resolve. The merge rule is
Fugue (Weidner & Kleppmann, 2023), the one Loro and list-positions use; one
engine, `src/sequence.js`, carries lists and texts, and a record with a text
field is still a record: it has a schema, it is queried, indexed and
searched like any other, and its ops travel in the same signed log.

```js
const id = await storage.insert({ title: 'Notes' });

await storage.splice(id, 'body', 0, 0, 'helo');   // a text field: insert at 0
await storage.splice(id, 'body', 3, 0, 'l');      // insert inside
await storage.push(id, 'body', ' world');         // append
await storage.splice(id, 'body', 5, 6);           // remove 6 from index 5
await storage.get(id);                            // { title: 'Notes', body: 'hello' }

await storage.push(id, 'items', [{ n: 1 }, 'two']); // a list field holds JSON values
await storage.splice(id, 'items', 1, 1, [2, 3]);    // replace 'two' with 2, 3
await storage.get(id);                              // { …, items: [{ n: 1 }, 2, 3] }
```

`splice(id, key, index, count, content)` removes `count` elements at `index`
and inserts `content` there — a string for a text, an array for a list; `push`
is a splice at the end. A live `Record` has every method of this page with its
own id (`record.splice(key, index, count, content)`). The first write decides
the field's kind, and a call that only removes takes it from the field.

Three things are refused (the same for `setAt()`, `move()`, `mark()` and
`unmark()`):

- **Past the end.** An index, or an index plus a count, beyond the field's
  length rejects with `code: 'OUT_OF_RANGE'` and `{ id, field, index, count,
  length }`. The check runs inside the mutation queue, against the field as
  it is at that moment — a concurrent peer's op cannot shift it between the
  check and the write.
- **Another kind.** A field is a register, a counter, a set, a list, a text or
  a tree, never two: `splice()` on a field a register holds throws `FIELD_KIND`
  with `kind: 'register'`, `update()` on a text throws with `kind: 'text'`,
  `setAt()` on a text too, and so does content of the other kind — an array
  spliced into a text, a string into a list — before anything is stamped. From a peer the kinds' precedence decides —
  register, counter, set, list, text, tree, on the op path as in a snapshot
  merge (see [the sync guide](./sync#registers-counters-sets-lists-and-text)):
  a peer's op of a kind that outranks the field's takes the field and drops
  what the other kind held, so a list made concurrently with a text on one
  field leaves the list on every node; an op the field's kind outranks is
  refused for that field — an `error` event, `OP_REFUSED`, its `rejected`
  naming the field and, as `reason`, the kind that holds it — and is still
  logged and relayed. A validator default for the field — `body: ''`,
  `items: []` — is folded into the write that creates the record and makes the
  field a register; leave list and text fields out of the defaults.
- **Arguments.** A non-string key, an index or a count that is not a
  non-negative integer, content that is neither a string nor an array, an
  element JSON cannot carry, or a call that neither removes nor inserts are
  `TypeError`s.

## How it merges

Every element has one place in a tree, chosen by its writer and carried on
the op. A new run — the elements one `splice` inserted — is the right child
of the element before the insertion point when that element has no right
children (deleted elements included), otherwise the left child of the
leftmost descendant of its first right child. Siblings on one side are
ordered by origin, then by stamp. A run's own continuation is one of those right children,
so a writer typing on at the end of its run extends the run instead of
anchoring a new one: a keystroke costs no new key in the record. The reading
is the walk of that tree — left children, the element if alive, right
children — and the tree is a function of the *set* of runs, never of their
order of arrival. A run whose anchor has not arrived yet stays out of the
walk, with everything anchored on it, until the anchor lands; a cut is a
union of ranges per run, held the same way for a run not yet here; both are
bounded (`sync.pendingMax`, 4096 per field) against hostile input, and so are
a register for an element not here and a mark switched off before it arrived.
Deleted content is dropped and its place kept, as a length.

What that gives you, concretely:

- Two nodes typing at one spot both keep their text; the runs come out one
  after the other, ordered by the writers' ids, never letter by letter.
- A node that deletes a range while another types inside it keeps the typed
  text; the deletion takes only what it named.
- A reset — `set()` or `delete()` on the record — drops every run stamped
  below it. A run stamped above the reset but anchored on an element the
  reset dropped reads from the head: concurrent typing survives a concurrent
  reset, at the start of the field. Text written at the head after the reset
  — the resetting node typing into the field again, a `compact()` or a
  `restore()` making it anew — is a run from the head too, and runs from the
  head order by their writers' ids like any siblings: the surviving typing
  reads before that text or after it, the same on every node.
- A list or a text touched after a `delete()` revives the record, like a set
  or a counter would.

The one case Fugue orders differently from FugueMax: when two writers insert
right after the same element while each sees a different element following
it, their two runs may come out in either order. The letters of a run never
mix with another's.

## Moving and assigning

A list's elements keep their names: `setAt(id, key, index, value)` gives the
element at `index` a new value, `move(id, key, from, to)` puts the element
at `from` where it reads as `to` once it is out. Both are registers per
element — last writer wins, by stamp — so the merge keeps the element once:

```js
await storage.push(id, 'todo', ['write', 'test', 'ship']);
await storage.setAt(id, 'todo', 1, 'test it');     // ['write', 'test it', 'ship']
await storage.move(id, 'todo', 2, 0);              // ['ship', 'write', 'test it']
```

- Two nodes that move the same element concurrently leave it at the newer
  move's place, not twice: the element shows where its position register
  points. A move is a cut of the slot it showed at and a new one-element
  position run that names it, so every node keeps every position and shows
  the element at the one the register names.
- A move concurrent with a removal of the element brings it back at the new
  place — the removal took the old slot, the move made a new one. A removal
  made after the move takes the element away.
- A value set with `setAt()` follows the element through a concurrent move;
  a value set concurrently by two nodes resolves by stamp.
- `setAt()` and `move()` are for lists; a text has neither. A `move()` to
  where the element already is (`from === to`) makes no op.

## Children of elements and nodes

A list's element and a tree's node can carry fields of their own, named by
a [path](./storage#paths) through the element's name or the node's id:
`items/<name>/body`, `outline/<node>/title`. Such a field is a field like
any other — a register, a counter, a set, a text, a list in its turn — and
merges on its own; a read composes it into the element (over the element's
value, which must be an object to keep it; a scalar gives way) or into the
node's `data`:

```js
await storage.push(id, 'items', [{ kind: 'note' }, 'plain']);
const [first] = await storage.elements(id, 'items');     // the elements' names, in order
await storage.push(id, `items/${first}/body`, 'hello');  // a text inside the first element
await storage.inc(id, `items/${first}/hits`, 1);
(await storage.get(id)).items;  // [{ kind: 'note', body: 'hello', hits: 1 }, 'plain']

await storage.treeMove(id, 'outline', 'a', 'r');
await storage.update(id, { 'outline/a/title': 'Intro' });
(await storage.get(id)).outline; // [{ id: 'r', children: [{ id: 'a', children: [], data: { title: 'Intro' } }] }]
```

`elementAt(id, key, index)` names the element at an index and `elements(id,
key)` all of them; an element keeps its name across moves, so a path under
it holds. A write under an element or a node that is not there is refused
before anything is stamped (`NOT_FOUND` with `field` the list or tree and
`elem` the name); from a peer such a field lands and waits. A field under an
element that was removed, or a node under the trash, is *unreachable*: not
read, not in a diff, kept in the record until [`compact()`](./storage#compact)
rewrites it without. A text's characters carry nothing: a path under a text
is `FIELD_KIND`. A `setAt()` of the element's value and the children under
it are apart: the value is one register, the children theirs.

## Rich text

A text carries **marks**: a style over a range, with a name and a value.
`mark(id, key, start, end, name, value)` sets one, `unmark` removes one,
and `spans(id, key)` reads the text as runs of equal style — what an editor
renders:

```js
await storage.updateText(id, 'body', 'hello world');
const bold = await storage.mark(id, 'body', 0, 5, 'bold', true);
await storage.spans(id, 'body');
// [{ type: 'text', text: 'hello', marks: { bold: true } }, { type: 'text', text: ' world', marks: {} }]

await storage.splice(id, 'body', 5, 0, '!');   // typed at the end of the range: bold
await storage.splice(id, 'body', 0, 0, '>');   // typed before it: not
// [{ type: 'text', text: '>', marks: {} }, { type: 'text', text: 'hello!', marks: { bold: true } },
//  { type: 'text', text: ' world', marks: {} }]

await storage.mark(id, 'body', 8, 13, 'link', 'https://x', { expand: 'none' });
await storage.unmark(id, 'body', 0, 7, 'bold');
```

- **Expand.** `expand` says whether text typed at the range's edges takes the
  style: `'after'` (the default — bold grows as you type on), `'before'`,
  `'both'`, `'none'` (a link does not grow). A mark is two anchors, each an
  element and a side, and the rule picks the sides; a character typed after
  an element is its right child in the tree, before it its left child, so the
  same rule that places the text decides whether it is inside the mark —
  concurrently or not.
- **Resolution.** Per name, the newest mark covering a character wins and a
  null value is none; `unmark` over a range is a null mark under the
  reversed expand rule — `both` and `none` swap, `before` and `after` stay —
  so removing a link (`none`) grows at both edges, where the link would not.
- **Many.** `{ many: true }` makes a mark stack with every other of its name
  instead of replacing it — comments, suggestions — and `spans` lists them
  as `[{ id, value }]`, oldest first. Such a mark is switched off by its id:
  `unmarkById(id, key, markId)` with what `mark()` resolved to (a `mark` op
  that carries the id alone). On one name the two mix in stamp order: a
  plain mark — an `unmark()` too, a null mark like any other — takes the
  place of what is there, the stacked marks under it included, and a
  stacking mark newer than it starts a stack over it.
- The field still reads as the plain string; `spans` is raw — no lens, no
  read hooks. Every span carries a `type`: `'text'` here, `'embed'` and
  `'block'` for what the next section adds.

## Embeds and blocks

A document is one text. What is not a character in it — an image, a
mention, the start of a paragraph or a heading — is an **embed slot**: one
position holding U+FFFC, the object replacement character, whose value is a
**marker** `{ type, parents, attrs, isEmbed }`, a register of the slot like
a list element's value (Automerge's model). `isEmbed: false` is a **block
marker**: it starts a block, the text after it up to the next marker is the
block's content, `parents` the block types it nests under (a list item's
`['ordered-list']`), `attrs` what the type needs (a heading's level). `isEmbed:
true` is an **inline embed**, a character wide, with marks like any character.

```js
await storage.updateText(id, 'body', 'Title\nFirst paragraph.');
await storage.splitBlock(id, 'body', 0, { type: 'heading', attrs: { level: 1 } });
await storage.splitBlock(id, 'body', 7, { type: 'paragraph' });
await storage.insertEmbed(id, 'body', 14, { type: 'image', attrs: { src: 'a.png' } });

(await storage.get(id)).body;      // '\uFFFCTitle\n\uFFFCFirst \uFFFCparagraph.' — the slots read as the character
await storage.block(id, 'body', 0); // { type: 'heading', parents: [], attrs: { level: 1 }, isEmbed: false }
await storage.spans(id, 'body');
// [{ type: 'block', value: { type: 'heading', parents: [], attrs: { level: 1 }, isEmbed: false } },
//  { type: 'text', text: 'Title\n', marks: {} },
//  { type: 'block', value: { type: 'paragraph', parents: [], attrs: {}, isEmbed: false } },
//  { type: 'text', text: 'First ', marks: {} },
//  { type: 'embed', value: { type: 'image', parents: [], attrs: { src: 'a.png' }, isEmbed: true }, marks: {} },
//  { type: 'text', text: 'paragraph.', marks: {} }]
await storage.blocks(id, 'body');  // per marker: { index, type, parents, attrs, spans } — the spans up to the next

await storage.updateBlock(id, 'body', 7, { type: 'paragraph', parents: ['blockquote'] });
await storage.joinBlock(id, 'body', 7); // the paragraph joins the heading's block
```

- **One tree.** A slot is an element of the text's Fugue tree like a
  character: the merge rules, the marks, the cursors and `index()` count it,
  and a concurrent insert beside it lands as beside any character. Its marker
  travels with the `splice` that inserts the slot (`vals`, each at its offset
  in the content) and changes by an `assign` — `updateBlock`, or `setAt` on a
  text — last writer wins, as a list element's value.
- **Through the string.** `get()` reads the slots as U+FFFC; `updateText`
  keeps the ones its text keeps, markers and all, and refuses a text that
  adds one (a `TypeError` — a slot enters with its marker, through
  `insertEmbed` or `splitBlock`), as `splice()` and `push()` do. A cut takes
  a slot like any character: `splice(id, key, index, 1)` removes an embed,
  `joinBlock` is the same cut checked against a marker (`NOT_FOUND` for a
  slot that holds none). A text before its first marker is a block of type
  null in `blocks()`.
- **Patches and versions.** `diff()` hands a splice patch its `vals`, a
  changed marker a `setAt` patch, and `restore()`, `compact()` and an undo
  lay the markers again with the slots; a `commit` event carries the markers
  of each side as `embeds` beside the readings, which show the slots alone.
- A slot a peer inserted without a marker — a hand-made op — reads as an
  embed of value `null`; a marker of another shape than the API writes reads
  as none.

## Cursors

A cursor is a place in a list or a text that survives edits around it — a
selection, a caret, a bookmark, a string you can keep or send to a peer:

```js
const caret = await storage.cursor(id, 'body', 6);          // before the element at 6
await storage.splice(id, 'body', 0, 0, '>> ');
await storage.index(id, 'body', caret);                     // 9
```

`side: 'before'` (the default) keeps the cursor before the element at
`index`, so text typed at the cursor pushes it right; `side: 'after'` keeps
it after the element before, so typed text lands after it. A cursor into a
deleted element reads at the next visible one; one into a field a reset
emptied reads `null`. In a list a cursor anchors the slot, not the element:
a move takes the element elsewhere and leaves the cursor at the slot.
`cursor()` is `null` for an index past the end and for a field that is not a
list or a text; like `spans()`, it reads the record raw.

## Trees

A field can be a **tree**: nodes with a parent and a place among their
siblings, put there by `treeMove(id, key, node, parent, { after, before })`
and taken out, with everything under them, by `treeRemove(id, key, node)`. A
node is a name — a record id, usually, so a node's own data lives in its
record and the tree record holds the shape alone; any non-empty string of at
most 128 characters without control characters will do, except `'$trash'`
and `'__proto__'`:

```js
const id = await storage.insert({ title: 'Outline' });
await storage.treeMove(id, 'nodes', 'intro');                       // a root
await storage.treeMove(id, 'nodes', 'scope', 'intro');              // under intro, last
await storage.treeMove(id, 'nodes', 'why', 'intro', { before: 'scope' });
await storage.treeMove(id, 'nodes', 'scope', null, { after: 'intro' }); // out, after intro
await storage.treeRemove(id, 'nodes', 'why');                       // with its subtree
(await storage.get(id)).nodes;
// [{ id: 'intro', children: [] }, { id: 'scope', children: [] }]
```

The field reads as the roots and their children, nested — `[{ id,
children }]` — in sibling order. The merge rule is Kleppmann, Mulligan,
Beresford and Gomes's (2021), the one Loro's movable tree follows:

- A `tree` op is one move: the node, its new parent (`null` a root,
  `'$trash'` removed) and its place among the siblings — a fractional index
  ([`@alexify/syncom/order`](./query#ordering-records)) between
  the neighbours it was put among. The record keeps, per node, every move
  made of it, stamped.
- The tree is the fold of every move in stamp order, and a move whose target,
  at that point of the fold, is the node itself or hangs under it does
  nothing. Two nodes that move concurrently so that each would hang under
  the other therefore agree, on every node, that the older move stands and
  the newer one lost. The lost move is kept: a later move of either node can
  make it count, or make it moot.
- A removal is a move under the trash: what hangs under a removed node goes
  with it and comes back with it when it is moved out again, and a move into
  a subtree removed concurrently is hidden with it.
- Siblings that share an index order by stamp, and a node put after one of
  them lands after all of them.
- A move to where the node already is makes no op, and neither does a
  removal of a node already removed. A parent that hangs under the node
  rejects with `CYCLE` (`{ id, field, node, parent }`), an `after`/`before`
  sibling not under the parent with `NOT_FOUND` (`{ id, field, node }`, the
  sibling) — both decided inside the mutation queue, against the tree as it
  is, so a race with a peer's move surfaces as the error rather than a silent
  nothing. The node as its own parent or sibling, or both `after` and
  `before`, are `TypeError`s.
- A reset (`write`, `delete`) drops the moves below it, and a node whose
  parent fell reads again once the parent is back. A tree is a tree:
  `update()`, `push()`, `add()`, `inc()` on the field are refused
  (`FIELD_KIND` with `kind: 'tree'`), and the tree ranks last: a peer's op of
  any other kind on the field takes it, and a peer's `tree` op on a field of
  another kind is refused (`OP_REFUSED`).

## What travels

A `tree` op carries `{ node, parent, fi }` — the node, its parent and its
fractional index. A `mark` op carries the two anchors, the name, the value and whether it
stacks — or the id of a mark to switch off. An `assign` op carries `{ elem,
value }` — and `k: 't'` when the element is a text's embed slot, so the op
ranks as a text's — a `move` op `{ elem, cut, at, value }` — the element's
name, the slot it showed at, the anchor of its new place and its value. A `splice` op carries the cut ranges, `[run, offset, length]` per run, and
either the anchor of its new run (`at`: `^` the head, `>e` or `<e` the right
or left child of element `e`, named `ts:offset:origin`) or the writer's own
run to extend (`run`, `from` — never a move's position run, which holds its
element alone: a peer's extension of one is malformed); `content` is the inserted string or array and,
empty, names the kind of a call that only removes; `vals`, when the content
holds embed slots, their markers at their offsets. What is the writer's own
is named without its origin, which the op's header carries already: a run by
its stamp (a number), an element as `ts:offset` — `run: 1792831354856`,
`at: '<1792831354856:3'` — and every node reads it under the op's origin, so
a short name never names another writer's run. One call is one op, signed
and logged like any other — except where keystrokes continue each other
(typed on at the end of their run, or a chain of cuts): sent without waiting,
typed through a transaction or through a [text handle](./editors#a-text-handle),
they are one op; a handle folds a word typed backward too. A keystroke
extending the writer's run adds its characters to the run and no key to the
record's metadata; a new run adds one key, a little over a hundred bytes. A
run grows while it is of its field's newest piece (the runs named last, 512
at most): typing on after one's own older text begins a run there, so a large
text's file, written a piece at a time, changes its newest piece a keystroke.

The first example of this page, with a listener attached before it:

```js
storage.on('change', (op) => {
  if (op.type === 'splice') console.log(op.key, op.value);
  // body { content: 'helo', at: '^' }
  // body { content: 'l', at: '<1792831354856:3' }
  // body { content: ' world', run: 1792831354856, from: 4 }
  // body { content: '', cut: [[1792831354856, 4, 6]] }
});
```

## Binding an editor

An editor holds its own string; syncom holds the record's. Hand the whole
new string over with `updateText()` and re-read the record on every
`change` of it:

```js
await storage.updateText(id, 'body', 'the quick brown fox'); // 1 — one op created the field
await storage.updateText(id, 'body', 'the slow brown dog');  // 3 — one op per hunk
await storage.updateText(id, 'body', 'the slow brown dog');  // 0 — nothing to do
```

`updateText` diffs the field against the new string *inside the mutation
queue* — Myers' algorithm over UTF-16 units, after the common prefix and
suffix are set aside — and sends one `splice` per hunk, last first, in one
turn of the queue, so a peer's op cannot land between the diff and the
splices. It resolves to how many ops it took; a difference deeper than a
thousand edit steps (a paste that replaces most of the text) is one op that
replaces the middle. Batch keystrokes into one call where you can — a word,
or a pause — so a burst of typing is one op rather than ten; where you
cannot, `open({ defer: 50 })` lets a record's file lag the log by that many
milliseconds, so the keystrokes of one burst are one file write and one chain
block (the log is durable at once, and every read sees every write — see
[Storage](./storage)). Indices are UTF-16 code units, as
`String#slice` counts them, and a surrogate pair — a character outside the
BMP, an emoji — is never split: `splice()`, `mark()`, `unmark()` and
`cursor()` refuse an index between its halves with `SURROGATE` (`id`,
`field`, `index`), `updateText()` diffs by code points where one is about,
so its edits go around it, and a string with a lone half is a `TypeError`.

The other way, from the storage to the editor, every op — a peer's as much
as a local one — reports what the reading shows of it, in the reading's
indices (see [Changes](./versions#changes)), and `observe(id, 'body',
listener)` hands a binding one record's changes a turn at a time:

```js
const stop = storage.observe(id, 'body', (changes) => {
  const delta = storage.toDelta(changes, 'body');
  if (delta === null) return editor.setContents(await storage.get(id));  // a reset: read it again
  editor.updateContents(delta, 'silent');                                  // Quill's form
});
await storage.applyDelta(id, 'body', editor.getContents().ops);          // the other way: one transaction
const caret = await storage.cursor(id, 'body', editor.getSelection().index);
await storage.position(id, 'body', caret);                               // { index, side } after edits around it
```

`toDelta()` composes the changes into one delta — `[{ retain, attributes? },
{ insert, attributes? }, { delete }]` — a splice as a delete and an insert
(the insert with the marks it reads with as attributes), a mark as
attributes over its range (`null` removes one), an embed slot as
`{ insert: { embed: marker } }`; `applyDelta()` makes a delta the field's
edits as one transaction, so a peer sees them land together — an insert's
attributes are exactly its marks, a mark that would have grown over it is
taken off it — and with
`expect`, the text the delta was made over, refuses with `STALE` when the
field moved under it, before any op. `@alexify/syncom/editor` does all of
this for an editor — see [Editors](./editors). A change a
delta cannot say — a reset, an unset — makes it `null`: read the field again.
`position()` restores a selection from the cursors kept across edits, and
`positions()` several at once.

## Costs and limits

- A record is read and written whole on every op, and a text lives three
  times on the node: as the field's string, as the runs in the record's
  metadata, and as the ops in the log. Keep a text to what a record is for —
  a note, a comment, a description, a document with its block markers — and
  split what a record is not for across records. The field itself
  is a rope: every edit — a keystroke at the end of what you just typed, an
  insert anywhere, a cut, a peer's run with what hangs under it — lands in
  O(log n) and leaves the reading cached, so what an op costs the engine does
  not grow with the text (`bench/sequence.js`: some 60 000 to 90 000
  inserts a second into a 100 KB text of 10 000 runs, 390 000 appends). What
  grows is around it: the record file written after the op, and the load of
  the field from its JSON once per open (a 100 KB text of one run in under
  a tenth of a millisecond, 10 000 runs in some 20 ms).
- A `splice` larger than a host's `bytesPerPush` is refused for the whole
  page it rides in; a paste of megabytes belongs in several calls.
- A move adds a position run to the record's metadata — one key, some two
  hundred bytes, twice that for an element's first move, which also starts
  its position register — and the old slot stays as a tombstone: a list
  reordered thousands of times carries that history until a reset.
- A tree keeps every move of every node until a reset — some eighty bytes
  each — and keeps its fold with the field: a move — a local one, a peer's
  arriving in stamp order, each move of an outline built in one transaction
  — is one step of the fold (its walk up from the parent, the siblings it
  leaves and joins), and the reading is made anew only along its path, so
  what a move costs does not grow with the tree (`bench/tree.js`: some
  16 000 `treeMove()` calls a second through the storage at 2 000 nodes as
  at 32 000; an outline of 8 000 nodes built in one transaction in a quarter
  of a second). A peer's move stamped before others undoes and redoes those.
  A field read from its JSON — a record loaded from its file, a snapshot, a
  merge — is folded whole once: some 1 ms at 5 000 moves; at the bound 25 ms
  under one root, 50 ms in a random tree, 100 ms in the worst shape. A field
  holds 65 536 moves, every node's together: past them `treeMove()` and
  `treeRemove()` reject with `FIELD_KIND`, `kind: 'bound'`,
  `detail: 'moves'`, a peer's move is refused (`OP_REFUSED`) and a snapshot
  block holding more is not taken — `compact(id)` (below) writes the field
  again as one move per node.
- [`compact(id)`](./versions#costs) is the reset that keeps what the fields
  read as: it rewrites the record as a `write` of its registers and one op
  per field of another kind — a text or a list as one run, a tree as one move per node —
  so the tombstones, the runs and the move logs under it go, here and on
  every peer. It lays a text's marks again and a field longer than a run in
  several runs; what it cannot keep is the names of the elements — the
  cursors into its texts and lists read `null`, a stacking mark has a new id
  — and fields that read empty (see [Costs](./versions#costs)).
- A tree reads 512 levels: a node that would hang deeper is folded but not
  shown, on every node alike, and `treeMove()` refuses a move that would reach
  there (`OUT_OF_RANGE` with `node`, `depth` and `max`). The fold's cycle check
  walks 512 ancestors up from a move's parent at most: a peer's move under a
  node deeper than that is moot, like a move that would make a cycle, the same
  on every node — so a chain of thousands of nodes costs an op no more than a
  tree 512 levels deep. A place among
  siblings is a fractional index of at most 1 024 characters: after some
  thirty thousand inserts at one spot — the end of a parent's children
  included — the next `treeMove()` there is `OUT_OF_RANGE` (`reason: 'fi'`,
  `length`, `max`) — move a sibling away, or reset the field. A peer's place
  that is not a fractional index is malformed and never lands.
- A run holds at most 1 048 576 slots and a field 4 194 304, tombstones
  included — the bound on what a peer can make a node hold and walk. One `splice()` inserts at most a run's worth; typing past a
  full run starts a new one and reads the same; a field at its bound takes
  nothing more until a reset — `set()` of the record, or `compact(id)`,
  which writes the field again without its tombstones. Locally
  a call past a bound rejects with `FIELD_KIND`, `kind: 'bound'`, `detail`
  (`'run'`, `'field'` or `'pending'`), `count` and `max`.
- Pending work — a run whose anchor has not arrived, a cut or an extension
  of a run not here, a register for an element not here, a mark switched off
  before it arrived — is bounded per field by `sync.pendingMax` (4 096;
  `Infinity` disables it). Past it a peer's op is refused for good on this
  node (`OP_REFUSED`, its `rejected` naming the field with `reason: 'bound'`,
  `detail`, `count` and `max`), so a mesh with several hosts, where a peer's
  ops can run far ahead of the runs they cut, raises the bound rather than
  lowers it. A block that arrives as state — a snapshot page, a `merge` op —
  is held to the same bound: one past it is not taken as state.
- Queries see a list as the array it reads as: an index on the field posts
  every element (`select({ tags: 'bug' })` finds a list holding `'bug'`), an
  equality against a whole array compares it in order, and a unique key over
  a list changes when the list does.
