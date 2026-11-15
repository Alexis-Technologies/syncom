---
title: Lists, text and trees
description: "The rules of the list, text and tree kinds: how runs merge, moves, marks, embeds, cursors, the movable tree, the text handle, what travels and every bound."
---

# Lists, text and trees

The specification of the `list` and `text` kinds (the `text` plugin, `src/text/`) and the `tree` kind (the
`tree` plugin, `src/tree/`). The guide's [Lists](../guide/lists), [Text](../guide/text),
[Trees](../guide/trees) and [Editors](../guide/editors) pages teach them; this page records what each call
does, how two nodes' edits merge, what an op carries and where the bounds are. The methods themselves are in
the [API reference](./api#database), the bytes of the ops in [Wire format](./wire#types-and-payloads), and
registers, counters and sets in [Field kinds and paths](./api#field-kinds-and-paths).

A field is a **list** (an array that nodes edit by position), a **text** (a string they type into) or a
**tree** (nodes moved under one another without ever forming a cycle). One engine, `src/text/sequence.js`,
carries lists and texts; a record with such a field is still a record — it has a schema, is queried, indexed
and searched like any other, and its ops travel in the same signed log.

## A field is one kind

`splice(id, key, index, count, content)` removes `count` elements at `index` and inserts `content` there — a
string for a text, an array for a list; `push` is a splice at the end. The first write decides the field's
kind, and a call that only removes takes it from the field. A live `Document` has every method of the kinds
with its own id. Three things are refused locally, before anything is stamped (the same for `setAt()`,
`move()`, `mark()` and `unmark()`):

- **Past the end.** An index, or an index plus a count, beyond the field's length rejects with
  `OUT_OF_RANGE` and `{ id, field, index, count, length }`. The check runs inside the mutation queue, against
  the field as it is then: a concurrent peer's op cannot shift it between the check and the write.
- **Another kind.** A register, a counter, a set, a list, a text or a tree, never two: `splice()` on a field a
  register holds is `FIELD_KIND` with `kind: 'register'`, `update()` on a text `kind: 'text'`, `setAt()` on a
  text too, and so is content of the other kind — an array spliced into a text, a string into a list.
- **Arguments.** A non-string key, an index or a count that is not a non-negative integer, content that is
  neither a string nor an array, an element JSON cannot carry, or a call that neither removes nor inserts is
  a `TypeError`.

From a peer the kinds' **precedence** decides instead — register, counter, set, list, text, tree, the
registry's ranks (`createPlugins`: register 0, counter 1, set 2, the plugins' kinds after), the same on the op
path and in a snapshot merge. A peer's op of a kind that outranks the field's takes the field and drops what
the other kind held, so a list made concurrently with a text on one field leaves the list on every node; an op
the field's kind outranks is refused for that field and still logged and relayed. The rule reads kinds alone,
never stamps, which is what makes it commute. A validator default for the field — `body: ''`, `items: []` —
is folded into the write that creates the record and makes the field a register: leave list, text and tree
fields out of the defaults.

## When a peer's op is refused

An op the engine will not apply for a field is still logged and relayed — the vector moves past it, so it is
never a gap — and is reported through the database's `error` event as `OP_REFUSED`, with `op` and `rejected`,
one entry per field refused, `{ field, reason, … }`:

| `reason` | Why | More fields |
| --- | --- | --- |
| a kind name (`'register'`, `'counter'`, `'set'`, `'list'`, `'text'`, `'tree'`) | The field — or a prefix above it (`prefix`) — is held by a kind that outranks the op's | `prefix` where the holder is above the field |
| `'bound'` | Past a bound of the field (see [Costs and limits](#costs-and-limits)) | `detail` (`'pending'`, `'run'`, `'field'`, `'cuts'`, `'marks'`, `'moves'`, `'counter'`, `'paths'`), `count`, `max` |
| `'malformed'` | A payload the engine does not admit (`field` null when the op names none) | — |
| `'kind'` | A field of a kind this node runs no plugin for | `kind` (the block code) |

A refusal of any reason but `'kind'` is one `error` event per op (`sync.op.rejected` at warn). A `'kind'`
refusal is reported once per page — a hub without the text plugin refuses every keystroke it relays — with the
first op, its `rejected`, the `count` of ops refused that way and the `kinds`; a snapshot block of such a kind
is left out of the join (`sync.record.kind`). Every refused op is counted in `syncom.ops.rejected` by its
reason. A refusal is final on this node: the op is never taken again, and each node it reaches decides by its
own bounds and plugins. Locally the same conditions are `FIELD_KIND` (a kind, or `kind: 'bound'` with the same
`detail`, `count` and `max`), and a malformed payload a local call could not have made is a `TypeError`.

## How a list or text merges

Every element has one place in a tree, chosen by its writer and carried on the op — Fugue (Weidner and
Kleppmann, 2023), the rule Loro and list-positions use. A **run** is the elements one `splice` inserted, in
order. A new run is the right child of the element before the insertion point when that element has no right
children (deleted elements included), otherwise the left child of the leftmost descendant of its first right
child. Siblings on one side are ordered by origin, then by stamp. A run's own continuation is one of those
right children, so a writer typing on at the end of its run **extends** the run (`{ run, from }`) instead of
anchoring a new one: a keystroke costs no new key in the record. The reading is the walk of that tree — left
children, the element if alive, right children — and the tree is a function of the *set* of runs, never of
their order of arrival.

A run whose anchor has not arrived yet stays out of the walk, with everything anchored on it, until the anchor
lands; a cut is a union of ranges per run, held the same way for a run not here yet; an extension ahead of its
run's length waits too. All of it is pending work, bounded by `sync.pendingMax` per field, and so are a
register for an element not here and a mark switched off before it arrived. Deleted content is dropped and its
place kept, as a length, so an anchor, a mark or a cursor into a deleted element still resolves. A run is
extended by its origin alone: another origin's `{ run, from }` is malformed.

What follows, the same on every node:

- Two nodes typing at one spot both keep their text; the runs come out one after the other, ordered by the
  writers' ids, never letter by letter.
- A node that deletes a range while another types inside it keeps the typed text: the deletion takes only
  what it named.
- A reset — `set()` or `delete()` on the record — drops every run stamped below it (a run is as old as its
  first element). A run stamped above the reset but anchored on an element the reset dropped reads from the
  head: concurrent typing survives a concurrent reset, at the start of the field. Text written at the head
  after the reset — the resetting node typing into the field again, a `compact()` or a `restore()` making it
  anew — is a run from the head too, and runs from the head order by their writers' ids like any siblings.
- A list or a text touched after a `delete()` revives the record, as a set or a counter would.

The one case Fugue orders differently from FugueMax: two writers inserting right after the same element
while each sees a different element following it (right siblings with different right origins) may have
their two runs come out in either order. The letters of a run never mix with another's. Adding FugueMax's
`rightOrigin` would change the merge rule for new runs, and is a protocol version once the package is
published.

## Moving and assigning

A list's elements keep their names. `setAt(id, key, index, value)` gives the element at `index` a new value;
`move(id, key, from, to)` puts the element at `from` where it reads as `to` once it is out. Every element has,
beside its place in the tree, two registers keyed by its name — `pos`, the position it shows at, and `vals`,
its value — each last writer wins by stamp (Kleppmann et al., 2020; Loro's MovableList). A move cuts the slot
the element showed at and adds a one-element **position run** that names it; the `pos` register then points at
that run. A position run holds its element alone: nothing extends it, and an extension of one is malformed. A
slot shows when it is alive and is the position its element's register names (its own slot, when no move has
named one). So:

- Two nodes that move one element concurrently leave it at the newer move's place, once.
- A move concurrent with a removal of the element brings it back at the new place — the removal took the old
  slot, the move made a new one. A removal made after the move takes the element away.
- A value set with `setAt()` follows the element through a concurrent move; two values set concurrently
  resolve by stamp. A cut element keeps neither register.
- `move()` is for lists alone; `setAt()` on a text sets an embed slot's marker. A `move()` to where the element
  already is (`from === to`) makes no op.

## Children of elements and nodes

A list's element and a tree's node can carry fields of their own, named by a [path](./api#field-kinds-and-paths)
through the element's name or the node's id: `items/<name>/body`, `outline/<node>/title`. Such a field is a
field like any other — a register, a counter, a set, a list or a text in its turn — and merges on its own; a
read composes it into the element (over the element's value, which must be an object to keep it: a scalar
gives way) or into the node's `data`. `elementAt(id, key, index)` names the element at an index and
`elements(id, key)` all of them, in order; an element keeps its name across moves, so a path under it holds.

A write under an element or a node that is not there is refused before anything is stamped (`NOT_FOUND`, with
`field` the list or tree and `elem` the name); from a peer such a field lands and waits. A field under an
element that was removed, or a node under the trash, is **unreachable**: not read, not in a diff, kept in the
record until [`compact()`](./versions#compact) rewrites it without. A text's characters carry nothing: a path
under a text is `FIELD_KIND`. A `setAt()` of the element's value and the children under it are apart: the value
is one register, the children theirs.

## Marks

A text carries **marks**: a style over a range, with a name and a value (Peritext, Litt et al. 2022; Loro's rich
text). `mark(id, key, start, end, name, value, { expand, many })` sets one and resolves to its id, `unmark()`
removes one, `unmarkById()` switches one off by its id, and `spans(id, key)` reads the text as runs of equal
style.

- **Expand.** A mark is two anchors, each an element and a side (`<e`, `>e`), or the head `^` or the end `$`.
  `expand` picks the sides: `'after'` (the default — bold grows as you type on), `'before'`, `'both'`, `'none'`
  (a link does not grow). A character typed after an element is its right child in the tree, before it its left
  child, so the rule that places the text decides whether it is inside the mark, concurrently or not.
- **Resolution.** Per name, the newest mark covering a character wins, and a null value is none. `unmark()` over a
  range is a null mark under the reversed expand rule — `'both'` and `'none'` swap, `'before'` and `'after'`
  stay — so removing a link (`'none'`) grows at both edges, where the link would not.
- **Many.** `{ many: true }` makes a mark stack with every other of its name instead of replacing it — comments,
  suggestions — and `spans()` lists them as `[{ id, value }]`, oldest first. Such a mark goes only by its id
  (`unmarkById()`, a `mark` op carrying `off`). On one name the two mix in stamp order: a plain mark (an
  `unmark()` too) takes the place of what is there, a stack included, and a stacking mark newer than it starts a
  stack over it.
- The field still reads as the plain string. `spans()` is raw — no lens, no read hooks — and every span carries
  a `type`: `'text'`, `'embed'`, `'block'`.

## Embeds and blocks

What is not a character in a text — an image, a mention, the start of a paragraph — is an **embed slot**: one
position holding U+FFFC whose value is a **marker** `{ type, parents, attrs, isEmbed }`, a register of the slot
like a list element's value. `isEmbed: false` is a **block marker**: it starts a block, the text after it up to
the next marker is the block's content, `parents` the block types it nests under (outermost first), `attrs` what
the type needs. `isEmbed: true` is an **inline embed**, a character wide, with marks like any character.

- **One tree.** A slot is an element of the text's Fugue tree like a character: the merge rules, the marks, the
  cursors and `index()` count it, and a concurrent insert beside it lands as beside any character. Its marker
  travels with the `splice` that inserts the slot (`vals`, each at its offset in the content) and changes by an
  `assign` carrying `k: 't'` — `updateBlock()`, or `setAt()` on a text — last writer wins whichever of the two
  arrives first.
- **Through the string.** `get()` reads the slots as U+FFFC. `updateText()` keeps the slots its text keeps,
  markers and all, and refuses a text that adds one (a `TypeError`: a slot enters with its marker, through
  `insertEmbed()` or `splitBlock()`), as `splice()` and `push()` do. A cut takes a slot like any character;
  `joinBlock()` is that cut checked against a marker (`NOT_FOUND` for a slot that holds none). Text before the
  first marker is a block of type `null` in `blocks()`.
- **Patches and versions.** `diff()` hands a splice patch its `vals` and a changed marker a `setAt` patch;
  `restore()`, `compact()` and an undo lay the markers again with the slots; a `commit` event carries the
  markers of each side as `embeds` beside the readings, which show the slots alone.
- A slot a peer inserted without a marker reads as an embed of value `null`; a marker of another shape than the
  API writes reads as none.

## Cursors

A cursor is a place in a list or a text that survives edits around it, as a string a node can keep or send.
`cursor(id, key, index, { side })` with `side: 'before'` (the default) keeps it before the element at `index`,
so text typed at the cursor pushes it right; `'after'` keeps it after the element before, so typed text lands
after it. `index()` reads where it is now and `position()` also which side it keeps to (`positions()` several in
one read). A cursor into a deleted element reads at the next visible one; one into a field a reset emptied reads
`null`. In a list a cursor anchors the slot, not the element: a move takes the element elsewhere and leaves the
cursor at the slot. `cursor()` is `null` for an index past the end and for a field that is not a list or a text;
like `spans()`, it reads the record raw. `compact()` names every element anew, so the cursors into a compacted
field read `null`.

## Trees

A tree field is nodes with a parent and a place among their siblings, put there by `treeMove(id, key, node,
parent, { after, before })` and taken out, with everything under them, by `treeRemove(id, key, node)`. A node
is a name — a record id, usually, so its data lives in its record and the tree holds the shape alone: any
non-empty string of at most 128 characters without control characters, except `'$trash'` and `'__proto__'`.
The field reads as the roots and their children, nested — `[{ id, children, data? }]` — in sibling order. The
merge rule is Kleppmann, Mulligan, Beresford and Gomes's (2021), the one Loro's movable tree follows:

- A `tree` op is one move: the node, its new parent (`null` a root, `'$trash'` removed) and its place among the
  siblings — a fractional index ([`@alexify/syncom/order`](./api#order-subpath)) between the neighbours it was
  put among. The record keeps, per node, every move made of it, stamped.
- The tree is the fold of every move in stamp order, and a move whose target, at that point of the fold, is the
  node itself or hangs under it does nothing. Two nodes that move concurrently so that each would hang under the
  other agree, on every node, that the older move stands and the newer one lost. The lost move is kept: a later
  move of either node can make it count, or make it moot.
- A removal is a move under the trash: what hangs under a removed node goes with it and comes back with it when
  it is moved out again, and a move into a subtree removed concurrently is hidden with it. A node not known here
  is created there by `treeRemove()`, so a concurrent creation lands removed; a second removal is nothing.
- Siblings that share an index order by stamp, and a node put after one of them lands after all of them.
- A move to where the node already is makes no op. A parent that hangs under the node rejects with `CYCLE`
  (`{ id, field, node, parent }`), an `after`/`before` sibling not under the parent with `NOT_FOUND`
  (`{ id, field, node }`, the sibling) — both decided inside the mutation queue, against the tree as it is, so
  a race with a peer's move surfaces as the error. The node as its own parent or sibling, or both `after` and
  `before`, are `TypeError`s.
- A reset (`write`, `delete`) drops the moves below it, and a node whose parent fell reads again once the
  parent is back. `update()`, `push()`, `add()`, `inc()` on the field are `FIELD_KIND` with `kind: 'tree'`;
  the tree ranks last, so a peer's op of any other kind on the field takes it, and a peer's `tree` op on a field
  of another kind is refused.

## What travels

The payloads, byte by byte, are in [Types and payloads](./wire#types-and-payloads). A `splice` carries the cut
ranges, `[run, offset, length]` per run, and either the anchor of its new run (`at`: `^` the head, `>e` or `<e`
the right or left child of element `e`, named `ts:offset:origin`) or the writer's own run to extend (`run`,
`from` — never a move's position run); `content` is the inserted string or array and, empty, names the kind of
a call that only removes; `vals`, when the content holds embed slots, their markers at their offsets. A `mark`
carries the two anchors, the name, the value and whether it stacks, or the id of a mark to switch off. An
`assign` carries `{ elem, value }`, and `k: 't'` on a text's embed slot so the op ranks as a text's; a `move`
`{ elem, cut, at, value }`; a `tree` `{ node, parent, fi }`. What is the writer's own is named without its
origin, which the header carries already — a run by its stamp, an element as `ts:offset` — and every node reads
it under the op's origin, so a short name never names another writer's run.

One call is one op, signed and logged like any other, except where keystrokes continue each other — typed on
at the end of their run, or a chain of cuts: sent without waiting, typed through a transaction or through a
[text handle](#the-text-handle), they are one op, and a handle folds a word typed backward too. A keystroke
extending the writer's run adds its characters to the run and no key to the record's metadata; a new run adds
one key, a little over a hundred bytes.

A list or a text of 1 024 runs or more keeps its runs in **pieces** of 512 beside its record (the engine's
`pieces` store, `<id>~<n>.json` on the files engine), by the numbers the runs were given; a piece is written
again when one of its runs reads otherwise, and only then. A run grows while it is of its field's newest piece:
typing on after one's own older text begins a run there, so a keystroke anywhere in a large text changes the
newest piece and no other.

## The text handle

`openText(id, key, { window, actor, source })` is a handle that edits a text at once, with no promise per
keystroke — what an editor binding stands on.

- **What it reads.** The field as the storage announced it, with what was typed here on top. An edit is
  resolved and stamped over that reading and applied to it at once; one the field refuses (`OUT_OF_RANGE`, a
  lone surrogate) throws and changes nothing.
- **When it is logged.** `window` ms later (the storage's `defer` by default; `0` for the end of the turn), as
  one transaction: keystrokes that continue each other — typed on at the end of their run, a chain of cuts, or a
  word typed backward (each keystroke right before the one typed last, 256 characters an op at most) — are one
  op. Until then nothing reaches a file, `get()` or a peer. `flushed` settles once every edit so far is logged
  and landed; the storage's `flush()`, `tag()` and `close()` flush open handles first. A pending op is
  rewritten only before its flush, and never after another writer's turn reached the handle.
- **Another writer's edits** — a peer's, or a write through the storage — reach the handle once they are
  announced, as a delta in its indices (`observe()`, `local: false`). A write through the storage to the same
  field resolves its indices against the storage's reading, not the handle's: flush first to write by the
  handle's.
- **A flush that cannot be logged** — the append failed, a hook or a validator refused — drops what was not
  logged: its edits, the flushes taken behind it (they may anchor in what was dropped) and what was typed
  since. `flushed` rejects with `UNLOGGED` (the handle's `error` event too), the handle reads the field as
  announced again, its observers hear `reset`, and the storage logs `handle.unlogged`. A step that fails after
  the append (an `afterWrite` hook) is that error, not `UNLOGGED`: the edits are logged and kept. The
  storage's `flush()` and `tag()` reject with one `UNLOGGED` for every handle that could not be flushed
  (`handles`, `edits`); `close()` closes and logs `edits.unlogged`. Once `close()` is called, an edit is
  `CLOSED`.
- **Several writers of one node** — handles, and the storage itself — each over its own reading, never grow one
  run from two readings: while a handle is open every extension of a run reserves its next offset, and a writer
  whose reading is behind it begins a run of its own. Nothing typed by any of them is lost.
- `format(index, count, attributes)` styles a range (an `embed` attribute sets every embed slot's marker),
  `insertEmbed(index, marker)` inserts a slot, and `applyDelta(delta)` is the storage's `applyDelta()`, at once;
  `spans()` reads the handle's reading as `storage.spans()` would. A hook sees a handle's edit resolved
  ([`ctx.resolved`](./events#the-write-context)).

The editor binding (`createTextBinding`, `@alexify/syncom/editor`) loads the editor from the handle's reading,
applies every edit the editor reports to the handle at once (so it is never refused as stale, never rebased),
hands every other writer's change to the editor as a delta in its indices, reloads the editor on a change no
delta can say (the record written whole, the field unset, the record deleted or purged; `onReset`) or on a flush
not logged, and stops after five failures in a row (`onStop`). An insert's attributes are exactly its marks: a
mark that would have grown over text typed at its end is taken off that text. A `many` mark is not a delta's: it
reads as a list in `spans()` and is left as it is.

## Diffs and deltas

`updateText(id, key, text)` diffs the field against the new string inside the mutation queue — Myers' algorithm
over UTF-16 units, after the common prefix and suffix are set aside — and sends one `splice` per hunk, last
first, in one turn of the queue, so a peer's op cannot land between the diff and the splices. It resolves to how
many ops it took; a difference deeper than a thousand edit steps is one op replacing the middle. Indices are
UTF-16 code units, as `String#slice` counts them, and a surrogate pair is never split: `splice()`, `mark()`,
`unmark()` and `cursor()` refuse an index between its halves with `SURROGATE` (`id`, `field`, `index`),
`updateText()` diffs by code points where one is about, and a string with a lone half is a `TypeError`.

`toDelta(changes, field)` composes a turn's [changes](./events#changes) into one delta in Quill's form —
`[{ retain, attributes? }, { insert, attributes? }, { delete }]` — a splice as a delete and an insert (the insert
with the marks it reads with as attributes), a mark as attributes over its range (`null` removes one), an embed
slot as `{ insert: { embed: marker } }`, a marker changed as `{ retain: 1, attributes: { embed } }`; `null` for a
change no delta can say. `applyDelta(id, key, delta, { expect, revision })` makes a delta the field's edits as
one transaction, so a peer sees them land together: an insert's attributes are exactly its marks (every mark it
lays has `expand: 'none'`), and with `expect`, the text the delta was made over, it refuses with `STALE` when
the field moved under it, before any op; `revision` spares comparing the text while the field is still at that
revision.

## Costs and limits

- A record is read and written whole on every op, and a text lives three times on a node: as the field's
  string, as the runs in the record's metadata, and as the ops in the log. The field itself is a rope: every
  edit — a keystroke at the end of what was just typed, an insert anywhere, a cut, a peer's run with what hangs
  under it — lands in O(log n) and leaves the reading cached, so what an op costs the engine does not grow with
  the text. What grows is around it: the record file written after the op, and the load of the field from its
  JSON once per open. The measured numbers are on [Benchmarks](../guide/benchmarks).
- A `splice` larger than a host's `bytesPerPush` is refused for the whole page it rides in; a paste of megabytes
  belongs in several calls.
- A move adds a position run to the record's metadata — one key, some two hundred bytes, twice that for an
  element's first move, which also starts its position register — and the old slot stays as a tombstone: a list
  reordered thousands of times carries that history until a reset.
- A tree keeps every move of every node until a reset, some eighty bytes each, and keeps its fold with the
  field: a move — a local one, a peer's arriving in stamp order — is one step of the fold, and the reading is
  made anew only along its path, so what a move costs does not grow with the tree. A peer's move stamped before
  others undoes and redoes those. A field read from its JSON — a record loaded from its file, a snapshot, a
  merge — is folded whole once.
- A tree field holds 65 536 moves (`MAX_MOVES`), every node's together: past them `treeMove()` and
  `treeRemove()` reject with `FIELD_KIND`, `kind: 'bound'`, `detail: 'moves'`, a peer's move is refused and a
  snapshot block holding more is not taken (a join keeps the oldest in the fold's order).
- A tree reads 512 levels: a node that would hang deeper is folded but not shown, on every node alike, and
  `treeMove()` refuses a move that would reach there (`OUT_OF_RANGE` with `node`, `depth` and `max`). The fold's
  cycle check walks 512 ancestors up from a move's parent at most (`MAX_WALK`): a peer's move under a node deeper
  than that is moot, like a move that would make a cycle, the same on every node. A place among siblings is a
  fractional index of at most 1 024 characters: after some thirty thousand inserts at one spot the next
  `treeMove()` there is `OUT_OF_RANGE` (`reason: 'fi'`, `length`, `max`) — move a sibling away, or reset the
  field. A peer's place that is not a fractional index is malformed and never lands.
- A run holds at most 1 048 576 slots (`MAX_RUN`) and a field 4 194 304 (`MAX_FIELD`), tombstones included. One
  `splice()` inserts at most a run's worth; typing past a full run starts a new one and reads the same; a field
  at its bound takes nothing more until a reset — `set()` of the record, or `compact(id)`, which writes the field
  again without its tombstones. A splice cuts at most 65 536 ranges (`MAX_CUTS`; overlapping ranges of one run
  read as one for the change report), a text holds at most 65 536 marks (`MAX_MARKS`), and an extension that
  arrives ahead of its run counts against `MAX_RUN` and the field's slots where it arrives, never only where it
  lands. Locally a call past a bound rejects with `FIELD_KIND`, `kind: 'bound'`, `detail`, `count` and `max`.
- Pending work — a run whose anchor has not arrived, a cut or an extension of a run not here, a register for an
  element not here, a mark switched off before it arrived — is bounded per field by `sync.pendingMax` (4 096;
  `Infinity` disables it). Past it a peer's op is refused for good on this node (`reason: 'bound'`,
  `detail: 'pending'`), so a mesh with several hosts, where a peer's ops can run far ahead of the runs they cut,
  raises the bound rather than lowers it. A block that arrives as state — a snapshot page, a `merge` op — is
  held to the same bounds: one past them is not taken as state.
- [`compact(id)`](./versions#compact) is the reset that keeps what the fields read as: a text or a list as one
  run (several past `MAX_RUN`), a tree as one move per node, a text's marks laid again — so the tombstones, the
  runs and the move logs under it go, here and on every peer.
- Queries see a list as the array it reads as: an index on the field posts every element, an equality against
  a whole array compares it in order, and a unique key over a list changes when the list does.
