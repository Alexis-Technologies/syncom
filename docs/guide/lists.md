---
title: Lists
description: Keep an array that several nodes edit by position, insert, remove, move and assign elements, and see how concurrent inserts come out.
---

# Lists

A list is a field that holds an array your nodes edit by position: insert at an index, remove a range, move
an element, give one a new value. Two nodes that insert at the same spot while apart both keep what they
wrote, each insert whole, and every node ends up with the same order. A checklist on a task, the cards of a
column or the slides of a deck are lists.

Lists come with the `text` plugin, which `@alexify/syncom/all` registers; with the lean core, pass
`plugins: [text]` from `@alexify/syncom/text` ([Plugins](./plugins)).

## Add and remove elements

<<< @/examples/lists.mjs#edit

`splice(id, key, index, count, content)` removes `count` elements at `index` and inserts the array `content`
there, and `push(id, key, content)` is a splice at the end. Elements are any JSON values. The first write
that names a field decides what it is, so the first `push` above made `checklist` a list, and the record
reads it back as a plain array.

A [document](./document) has the same methods with its own id:

<<< @/examples/lists.mjs#document

## Insert at the same spot on two nodes

The laptop and the phone hold the same checklist, go offline, and each inserts two steps between `write` and
`ship`. To try it in one process, the [testing kit](./testing) wires three databases with in-memory links:

<<< @/examples/lists.mjs#mesh

<<< @/examples/lists.mjs#concurrent

Both inserts survive, and each stays in one piece: `review, fix` and `test, docs` never interleave element
by element. Which run comes first is decided by the writers' node ids, so it looks arbitrary, but it is the
same on every node whatever order the ops arrived in. That is the guarantee you build on: nodes agree on
one order without a server deciding it.

<FigFugue />

How it works: every element has a place in a tree, chosen by the node that inserted it and carried in the op.
A new run of elements hangs off the element before the insertion point, and runs that hang off the same
element are ordered by their writer, then by stamp. The list reads as a walk of that tree. Because the tree
depends only on which runs exist, never on when they arrived, every node that holds the same runs reads the
same list. The rule is Fugue (Weidner and Kleppmann, 2023), the one Loro and list-positions use.

A few consequences you can rely on:

- A node that removes a range while another inserts inside it keeps the inserted elements: a removal takes
  only the elements it named.
- A removed element leaves its place behind as a tombstone, so an insert anchored next to it still lands
  where its writer meant.
- Elements a node appends right after its own last insert extend that run instead of starting a new one,
  so pushing one element at a time costs about as much metadata as pushing them together.

## Move an element or give it a new value

<<< @/examples/lists.mjs#move

`setAt(id, key, index, value)` replaces the element at `index`, and `move(id, key, from, to)` puts the
element at `from` where it reads as `to` once it is out of the way. Use them instead of a remove and an
insert: an element moved this way keeps its identity, so a concurrent edit of it follows it to its new
place instead of leaving a copy behind.

When two nodes move the same element at once, it ends up once, where the move with the later stamp put it:

<<< @/examples/lists.mjs#concurrent-move

A move that races with a removal of the same element brings the element back at the new place: the removal
took the old slot, the move made a new one. A removal made after the move, on a node that has seen it,
takes the element away. A value set with `setAt()` on one node follows the element through a move made on
another, and two values set at once resolve by stamp, last writer wins.

<<< @/examples/lists.mjs#move-remove

## Give elements fields of their own

An element can carry fields that merge on their own, named by a [path](./fields) through the element's name.
`elements(id, key)` lists the names in order and `elementAt(id, key, index)` names one:

<<< @/examples/lists.mjs#children

`checklist/<name>/done` is a register and `checklist/<name>/votes` a counter, so two nodes that tick the
box and vote on the same step at the same time both get their way. A read folds such fields into the
element's value, which must be an object to keep them. The name stays with the element across moves, so a
path under it keeps pointing at the same step. A write under an element that is not there is refused with
`ALX_ERR_NOT_FOUND`.

## Keep a place in a list

An index is only right until the next edit around it. A cursor is a place that survives edits:
`cursor(id, key, index)` hands you a string you can store or send, and `index(id, key, cursor)` tells you
where it is now. In a list a cursor anchors the slot, not the element, so a move takes the element away and
leaves the cursor where it was. Cursors matter most for text; [Text and rich text](./text#keep-a-caret-where-it-belongs)
shows them in full.

## When a write is refused

<<< @/examples/lists.mjs#errors

An index past the end rejects with `ALX_ERR_OUT_OF_RANGE`, checked against the list as it is when the write runs,
so a peer's op that lands in between cannot shift it. A field is one kind for good: `splice()` on a field
that holds a plain value, or `update()` on a list, rejects with `ALX_ERR_FIELD_KIND` and names the kind the field
holds in `kind`. When ops of two kinds meet on one field from different nodes, the kinds' precedence decides
on every node alike, which [Fields that merge](./fields) explains.

One trap: a schema default for a list field (`checklist: []`) is written as a plain value with the record,
which makes the field a register. Leave list and text fields out of the defaults and let the first
`push()` create them.

## Costs and limits

- A record is read and written whole on every op, and a list keeps its tombstones and the history of its
  moves in the record's metadata. Keep a list to what one record is for; a list of thousands of items that
  each change on their own is better as a collection of records with an
  [`@alexify/syncom/order`](../reference/api#order-subpath) key in a field you sort by.
- A move adds a little metadata each time and leaves the old slot as a tombstone, so a list reordered
  thousands of times carries that history until the record is rewritten.
  [`compact(id)`](./health#rewrite-a-record-that-has-grown) rewrites it as it reads today, on every node.
- Queries see a list as the array it reads as: an index on the field posts every element, so
  `select({ checklist: 'ship' })` finds a task whose checklist holds `'ship'`.
- A run holds at most 2²⁰ elements and a field 2²² slots, tombstones included; the full list of bounds is
  in the [wire reference](../reference/wire#bounds).

## Coming from RxDB

An RxDB document stores an array as one value: two clients that each insert into it produce a conflict, and
the conflict handler picks a side or merges the two arrays by hand. RxDB's CRDT plugin replays update
operators such as `$push` and `$pop` in a fixed order, which keeps concurrent appends, but it has no insert
at an index and no move. A syncom list merges by position, so inserts, removals and moves from every node
are kept without a handler.
