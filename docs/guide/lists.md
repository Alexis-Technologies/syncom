# Lists, text and trees

A field can be a **list** — an array that nodes edit by position — or a
**text** — a string they type into — or a **tree** — nodes moved under one
another without ever forming a cycle ([Trees](#trees), below). Two nodes that insert at the same spot
both keep what they wrote, each writer's run whole, and a deleted element
keeps its place so the anchors into it still resolve. The merge rule is
Fugue (Weidner & Kleppmann, 2023), the one Loro and list-positions use; the
same engine, `src/sequence.js`, carries both kinds, and a record with a text
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
is a splice at the end. A live `Record` has the same two methods with its own
id. The first write decides the field's kind, and a call that only removes
takes it from the field.

Three things are refused (the same for `setAt()` and `move()`):

- **Past the end.** An index, or an index plus a count, beyond the field's
  length rejects with `code: 'OUT_OF_RANGE'` and `{ id, field, index, count,
  length }`. The check runs inside the mutation queue, against the field as
  it is at that moment — a concurrent peer's op cannot shift it between the
  check and the write.
- **Another kind.** A field is a register, a counter, a set, a list or a text,
  never two: `splice()` on a field a register holds throws `FIELD_KIND` with
  `kind: 'register'`, `update()` on a text throws with `kind: 'text'`, and a
  peer's op that breaks the rule is refused for that field (an `error` event,
  `OP_REFUSED`). A validator default for the field — `body: ''`, `items: []`
  — is folded into the write that creates the record and makes the field a
  register; leave list and text fields out of the defaults.
- **Arguments.** A non-string key, a negative index or count, content that is
  neither a string nor an array, an element JSON cannot carry, or a call that
  neither removes nor inserts are `TypeError`s.

## How it merges

Every element has one place in a tree, chosen by its writer and carried on
the op. A new run — the elements one `splice` inserted — is the right child
of the element before the insertion point when that element has no right
children (deleted elements included), otherwise the left child of the
leftmost descendant of its first right child. Siblings on one side are
ordered by origin. A run's own continuation is one of those right children,
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
  reset, at the start of the field.
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
- `setAt()` and `move()` are for lists; a text has neither.

## Rich text

A text carries **marks**: a style over a range, with a name and a value.
`mark(id, key, start, end, name, value)` sets one, `unmark` removes one,
and `spans(id, key)` reads the text as runs of equal style — what an editor
renders:

```js
await storage.updateText(id, 'body', 'hello world');
const bold = await storage.mark(id, 'body', 0, 5, 'bold', true);
await storage.spans(id, 'body');
// [{ text: 'hello', marks: { bold: true } }, { text: ' world', marks: {} }]

await storage.splice(id, 'body', 5, 0, '!');   // typed at the end of the range: bold
await storage.splice(id, 'body', 0, 0, '>');   // typed before it: not
// [{ text: '>', marks: {} }, { text: 'hello!', marks: { bold: true } }, { text: ' world', marks: {} }]

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
  reversed expand rule, so the removal grows where the style would not.
- **Many.** `{ many: true }` makes a mark stack with every other of its name
  instead of replacing it — comments, suggestions — and `spans` lists them
  as `[{ id, value }]`, oldest first. Such a mark goes only by its id:
  `unmark(id, key, markId)` with what `mark()` resolved to.
- The field still reads as the plain string; `spans` is raw — no lens, no
  read hooks. Blocks (paragraphs, headings) are records: a document is a
  list of block ids, each block a record with a text field.

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

## Trees

A field can be a **tree**: nodes with a parent and a place among their
siblings, put there by `treeMove(id, key, node, parent, { after, before })`
and taken out, with everything under them, by `treeRemove(id, key, node)`. A
node is a name — a record id, usually, so a node's own data lives in its
record and the tree record holds the shape alone:

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
- A move to where the node already is makes no op. A parent that is the node
  itself or hangs under it rejects with `CYCLE`; an `after`/`before` sibling
  not under the parent with `NOT_FOUND` — both decided inside the mutation
  queue, against the tree as it is, so a race with a peer's move surfaces as
  the error rather than a silent nothing.
- A reset (`write`, `delete`) drops the moves below it, and a node whose
  parent fell reads again once the parent is back. A tree is a tree:
  `update()`, `push()`, `add()`, `inc()` on the field are refused
  (`FIELD_KIND` with `kind: 'tree'`), and a merge lets every other kind win
  over it.

## What travels

A `tree` op carries `{ node, parent, fi }` — the node, its parent and its
fractional index. A `mark` op carries the two anchors, the name, the value and whether it
stacks — or the id of a mark to switch off. A `splice` op carries the cut ranges, `[run, offset, length]` per run, and
either the anchor of its new run (`at`: `^` the head, `>e` or `<e` the right
or left child of element `e`, named `ts:offset:origin`) or the writer's own
run to extend (`run`, `from`); `content` is the inserted string or array and,
empty, names the kind of a call that only removes. One call is one op, signed
and logged like any other — an editor that types a word sends one op per
keystroke unless it batches them (see below). A keystroke extending the
writer's run adds a few bytes of content to the record and nothing to its
metadata; a new run adds one key, about a hundred bytes.

```js
storage.on('change', (op) => {
  if (op.type === 'splice') console.log(op.key, op.value);
  // body { content: 'l', at: '<1792831354856:3:3oyEvh7q…' }
  // body { content: ' world', run: '1792831354856:3oyEvh7q…', from: 4 }
  // body { content: '', cut: [['1792831354856:3oyEvh7q…', 4, 6]] }
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
or a pause — so a burst of typing is one op rather than ten. Indices are UTF-16 code units, as
`String#slice` counts them; a splice that splits a surrogate pair is the
caller's to avoid.

## Costs and limits

- A record is read and written whole on every op, and a text lives three
  times on the node: as the field's string, as the runs in the record's
  metadata, and as the ops in the log. Keep a text to what a record is for —
  a note, a comment, a description, a block of a document — and make a long
  document a list of block records rather than one field.
- A `splice` larger than a host's `bytesPerPush` is refused for the whole
  page it rides in; a paste of megabytes belongs in several calls.
- A move adds a position run to the record's metadata — one key, about a
  hundred bytes — and the old slot stays as a tombstone: a list reordered
  thousands of times carries that history until a reset.
- A tree keeps every move of every node until a reset — a few dozen bytes
  each — and folds all of them on every op that touches the field. Keep a
  tree to the hundreds of nodes an outline or a folder pane shows, not the
  hundreds of thousands a file system holds.
- A tree reads 512 levels: a node that would hang deeper is folded but not
  shown, on every node alike, and `treeMove()` refuses a move that would reach
  there (`OUT_OF_RANGE` with `depth`). A place among siblings is a fractional
  index of at most 1 024 characters: after some thirty thousand inserts at
  one spot the next `treeMove()` there is `OUT_OF_RANGE` (`reason: 'fi'`) —
  move a sibling away, or reset the field. A peer's place that is not a
  fractional index is malformed and never lands.
- A run holds at most 1 048 576 slots and a field 4 194 304, tombstones
  included — the index allocates per slot, so this is what a peer can make a
  node allocate. Typing past a full run starts a new one and reads the same;
  a field at its bound takes nothing more until a reset (`set()` of the
  record, or `updateText()` after one).
- Pending work — a run whose anchor has not arrived, a cut or an extension
  of a run not here, a register for an element not here, a mark switched off
  before it arrived — is bounded per field by `sync.pendingMax` (4 096). Past
  it an op is refused for good on this node (`OP_REFUSED`, reason `bound`,
  with `detail`, `count` and `max`) and a snapshot block is not taken as
  state, so a mesh with several hosts, where a peer's ops can run far ahead
  of the runs they cut, raises the bound rather than lowers it.
- Queries see a list as the array it reads as: an index on the field posts
  every element (`select({ tags: 'bug' })` finds a list holding `'bug'`), an
  equality against a whole array compares it in order, and a unique key over
  a list changes when the list does.
