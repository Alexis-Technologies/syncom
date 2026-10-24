# Lists, text and trees

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
  `setAt()` on a text too. From a peer the kinds' precedence decides —
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
  reversed expand rule — `both` and `none` swap, `before` and `after` stay —
  so removing a link (`none`) grows at both edges, where the link would not.
- **Many.** `{ many: true }` makes a mark stack with every other of its name
  instead of replacing it — comments, suggestions — and `spans` lists them
  as `[{ id, value }]`, oldest first. Such a mark is switched off by its id:
  `unmarkById(id, key, markId)` with what `mark()` resolved to (a `mark` op
  that carries the id alone). An `unmark()` of the name is a null mark like
  any other: it reads as none over its range, the stacked marks under it
  included. Keep a name either stacking or not; the two are not meant to
  mix.
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
value }`, a `move` op `{ elem, cut, at, value }` — the element's name, the
slot it showed at, the anchor of its new place and its value. A `splice` op carries the cut ranges, `[run, offset, length]` per run, and
either the anchor of its new run (`at`: `^` the head, `>e` or `<e` the right
or left child of element `e`, named `ts:offset:origin`) or the writer's own
run to extend (`run`, `from`); `content` is the inserted string or array and,
empty, names the kind of a call that only removes. One call is one op, signed
and logged like any other — an editor that types a word sends one op per
keystroke unless it batches them (see below). A keystroke extending the
writer's run adds its characters to the run and no key to the record's
metadata; a new run adds one key, a little over a hundred bytes.

The first example of this page, with a listener attached before it:

```js
storage.on('change', (op) => {
  if (op.type === 'splice') console.log(op.key, op.value);
  // body { content: 'helo', at: '^' }
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
or a pause — so a burst of typing is one op rather than ten; where you
cannot, `open({ defer: 50 })` lets a record's file lag the log by that many
milliseconds, so the keystrokes of one burst are one file write and one chain
block (the log is durable at once, and every read sees every write — see
[Storage](./storage)). Indices are UTF-16 code units, as
`String#slice` counts them; a splice that splits a surrogate pair is the
caller's to avoid.

## Costs and limits

- A record is read and written whole on every op, and a text lives three
  times on the node: as the field's string, as the runs in the record's
  metadata, and as the ops in the log. Keep a text to what a record is for —
  a note, a comment, a description, a block of a document — and make a long
  document a list of block records rather than one field. A keystroke that
  extends the newest run at the end of the field — typing on at the end of
  what you just typed — carries the field's index and reading over instead
  of rebuilding them; any other edit (an insert elsewhere, a cut, a peer's
  run) rebuilds them, once per op.
- A `splice` larger than a host's `bytesPerPush` is refused for the whole
  page it rides in; a paste of megabytes belongs in several calls.
- A move adds a position run to the record's metadata — one key, some two
  hundred bytes, twice that for an element's first move, which also starts
  its position register — and the old slot stays as a tombstone: a list
  reordered thousands of times carries that history until a reset.
- A tree keeps every move of every node until a reset — some eighty bytes
  each — and folds all of them once per op that changes the field. Keep a
  tree to the hundreds of nodes an outline or a folder pane shows, not the
  hundreds of thousands a file system holds.
- [`compact(id)`](./versions#costs) is the reset that keeps what the fields
  read as: it rewrites the record as a `write` of its registers and one op
  per field of another kind — a text or a list as one run, a tree as one move per node —
  so the tombstones, the runs and the move logs under it go, here and on
  every peer. What it does not keep: a text's marks (`spans()` reads plain
  afterwards), the cursors into its texts and lists (they read `null`), and
  fields that read empty (see [Costs](./versions#costs)).
- A tree reads 512 levels: a node that would hang deeper is folded but not
  shown, on every node alike, and `treeMove()` refuses a move that would reach
  there (`OUT_OF_RANGE` with `node`, `depth` and `max`). A place among
  siblings is a fractional index of at most 1 024 characters: after some
  thirty thousand inserts at one spot — the end of a parent's children
  included — the next `treeMove()` there is `OUT_OF_RANGE` (`reason: 'fi'`,
  `length`, `max`) — move a sibling away, or reset the field. A peer's place
  that is not a fractional index is malformed and never lands.
- A run holds at most 1 048 576 slots and a field 4 194 304, tombstones
  included — the index allocates per slot, so this is what a peer can make a
  node allocate. One `splice()` inserts at most a run's worth; typing past a
  full run starts a new one and reads the same; a field at its bound takes
  nothing more until a reset — `set()` of the record, or `compact(id)`,
  which writes the field again as one run without its tombstones. Locally
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
  is held to 4 096 pending items whatever `sync.pendingMax` says: one past
  that is not taken as state, even on a node that raised the bound.
- Queries see a list as the array it reads as: an index on the field posts
  every element (`select({ tags: 'bug' })` finds a list holding `'bug'`), an
  equality against a whole array compares it in order, and a unique key over
  a list changes when the list does.
