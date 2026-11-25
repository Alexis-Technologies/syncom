---
title: Branches
description: Fork a database into a draft, edit it apart from the main one, merge either way as ops, and fork from a tag or from any past version.
---

# Branches

A branch is a copy of a database you can change without touching the original: a draft of a big edit, a
what-if, a review copy. It is a full database of its own, with its own node id and log, standing where the
parent stood when you forked it. When the draft is ready you merge it back, and the edits arrive the way a
peer's would, merging with whatever the parent wrote meanwhile.

Branches are `@alexify/syncom/branch`. A branch opens with the parent's plugins unless you pass your own, and
forking from a past version needs the [`versions`](./versions) plugin, which `@alexify/syncom/all` registers.

## Fork, edit, merge

<<< @/examples/branches.mjs#branch

`branch(parent, { path, ...options })` creates a database in a new directory and copies the parent's
records into it, then catches up on what the parent wrote while the copy ran, so the branch stands at one
point of the parent's history. It takes the options of `createDatabase()` (the schema, hooks, a logger),
and opens on the parent's storage unless you name another.

`merge(source, { into })` hands `into` every op `source` has that `into` lacks, through the same path a
peer's push takes. Concurrent edits of one record converge by the usual rules (here the branch's title and
the parent's vote are both kept), and a second merge finds nothing to hand over. It works either way: merge
the parent into the branch to bring the draft up to date before you merge it back.

The ops keep their origin. Once merged, the branch's edits are ops of the branch's node id, and a parent
that syncs with peers relays them like any other node's. A parent running with
[`signatures: 'require'`](./signing) accepts them, because the branch signs its own ops.

## Fork from the past

<<< @/examples/branches.mjs#from

`from: { tag }` forks at a [tag](./versions#name-the-whole-database-with-a-tag), and `from: { at }` at any
version the log can still give exactly: an event id, a stamp or `{ vector }`. A version the log no longer
holds what it needs for rejects with `ALX_ERR_HISTORY_GONE`, and an unknown tag with `ALX_ERR_TAG_NOT_FOUND`.

## See what a branch is, and throw it away

<<< @/examples/branches.mjs#info

`branchInfo(db)` reads `branch.json` in the branch's directory: the parent's node id and where the fork
stood. It answers `null` for a database that is no branch. `drop(branch)` closes the branch and removes
its files. It is the one call here that deletes data, so it only takes what `branch()` made: a database
without `branch.json` is refused with a `TypeError` and keeps its files.

## What to know

- `branch()` only creates: a path that already holds files is refused with `ALX_ERR_BRANCH_EXISTS`, so it never
  takes over another database. A fork that fails halfway leaves nothing behind.
- A branch keeps every op for the merge back (its sync retention is `{ ops: 0 }`, nothing dropped) and does
  not dial any peer until you start its sync.
- When the source's log no longer holds what the other side needs, `merge()` joins the source's state as a
  snapshot instead and reports `joined: true`; it never reports success over a gap.
- A branch is a branch only on this node. Nothing about it replicates as such: peers see merged ops like
  any other.

## Coming from RxDB

RxDB has no branches. The closest you get is a second database you copy into and replicate back by hand. A
syncom branch is that, with the bookkeeping done: where it forked, the merge as ops in both directions, and
a drop that removes only what the fork created.
