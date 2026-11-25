---
title: Trees
description: Keep a movable tree in one field, move nodes and their subtrees from several nodes at once, and see why concurrent moves never make a cycle.
---

# Trees

A tree field holds nodes that each have a parent and a place among their siblings: an outline, a folder
hierarchy, nested tasks, the layers of a drawing. Nodes move with everything under them, and several nodes
of your app can move them at the same time while apart. When two moves would make a cycle, every node agrees
on which one counts, so the field always reads as a tree.

Trees come with the `tree` plugin, which `@alexify/syncom/all` registers; with the lean core, pass
`plugins: [tree]` from `@alexify/syncom/tree`.

## Build a tree

<<< @/examples/trees.mjs#build

`treeMove(id, key, node, parent, { after, before })` puts `node` under `parent` (`null` or left out for a
root), after or before a sibling, or last. It creates the node, the field and the record when they are not
there, and a move to where the node already is makes no op. The field reads as the roots and their children,
nested, each node as `{ id, children }` in sibling order.

A node is a name: any non-empty string of up to 128 characters without control characters. A record id is
the usual choice, so a node's own data lives in its record and the tree holds only the shape. When the data
is small, keep it on the node itself:

<<< @/examples/trees.mjs#data

`outline/intro/title` is a field of the node `intro`, a register that merges on its own; a read puts the
node's fields under `data`. A write under a node that is not there is refused with `ALX_ERR_NOT_FOUND`.

## Remove a subtree and bring it back

<<< @/examples/trees.mjs#remove

`treeRemove(id, key, node)` takes the node out with everything under it. A removal is a move under a hidden
trash node, so the subtree comes back whole when you move the node out again, and a node that another
node moves into the removed subtree at the same time is hidden with it.

## Move nodes on two nodes at once

The laptop puts `guide` under `reference` while the phone, a moment later and offline, puts `reference`
under `guide`. Applied together, the two moves would make each the other's parent:

<<< @/examples/trees.mjs#concurrent

Every node ends with `guide` under `reference`: the older move stands and the newer one lost. Nobody is
asked, and no node holds a different tree.

<FigTreeMoves />

How it works: the field keeps every move of every node, stamped. The tree you read is the fold of all those
moves in stamp order, and a move that would put a node under itself at that point of the fold does nothing.
Because the fold depends only on the set of moves, never on the order they arrived in, every node computes
the same tree. The losing move is kept, not deleted: a later move of either node can make it count again, or
make it moot. The rule is the one Kleppmann, Mulligan, Beresford and Gomes published in 2021 and Loro's
movable tree follows.

A few more things follow from the fold. Siblings that land at the same place order by stamp, the same
everywhere. A reset of the record (`set()`, `delete()`) drops the moves stamped before it, and a node whose
parent fell reads again once the parent is back.

## When a move is refused

<<< @/examples/trees.mjs#errors

Locally, a move that would put a node under one of its own descendants rejects with `ALX_ERR_CYCLE`, and an
`after` or `before` sibling that is not under the parent rejects with `ALX_ERR_NOT_FOUND`. Both are decided against
the tree as it is when the write runs, so a race with a peer's move surfaces as the error rather than as a
move that silently does nothing. A field is a tree for good: `update()`, `push()`, `add()` or `inc()` on it
rejects with `ALX_ERR_FIELD_KIND`.

## Costs and limits

- A tree keeps every move of every node until the record is reset, a few dozen bytes each, and keeps its fold
  with the field, so a move costs the same in a large tree as in a small one. A field holds 65 536 moves in
  all; past them `treeMove()` rejects with `ALX_ERR_FIELD_KIND` and `kind: 'bound'`.
  [`compact(id)`](./health#rewrite-a-record-that-has-grown) rewrites the field as one move per node.
- A tree reads 512 levels deep; a move that would reach deeper rejects with `ALX_ERR_OUT_OF_RANGE`.
- A place among siblings is a fractional index of at most 1 024 characters. After tens of thousands of
  inserts at one spot the next move there rejects with `ALX_ERR_OUT_OF_RANGE`; move a sibling away or compact the
  record.
- The bounds a peer is held to are in the [wire reference](../reference/wire#bounds), and measured costs on
  the [benchmarks](./benchmarks) page.

## Coming from RxDB

RxDB has no tree type. A hierarchy there is usually a `parentId` field on each document, and two clients that
move nodes at once can leave a cycle or an orphan that the application has to detect and repair. A syncom
tree field cannot hold a cycle: concurrent moves are folded the same way on every node. When you prefer a
`parentId` per record, that works in syncom too, with the same risk; the tree field is there for when the
shape must stay a tree.
