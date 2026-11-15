---
title: Hooks and events
description: Run your code inside a write, a read or a peer's batch with hooks, watch what happened with events, and know which of the two to reach for.
---

# Hooks and events

syncom gives you two ways to attach code to what a database does. A **hook** runs inside the operation:
syncom awaits it where the operation happens, so it can change what is written, refuse it, or skip an op
that came from another node. An **event** fires after the fact: any number of listeners hear it, and none
of them can change the outcome.

If your code should be able to change what happens, write a hook. If it only watches (metrics, an audit
trail, a UI that redraws), listen to an event.

## Check and stamp every write

Hooks go in the `hooks` option of `createDatabase()`, one function per name. This `beforeWrite` refuses a
task without a title and stamps every task it lets through:

<<< @/examples/hooks.mjs#before-write

`beforeWrite` runs for every local write, once per [op](./operation-log) the write makes: an `insert()` is
a `write`, an `update()` a `set`, an `inc()` an `inc`, and so on. It receives the op's `type`, the fields
the caller passed (`data`), the record as it is now (`current`, `null` for a new record) and a few more
facts about the write. Returning a plain object replaces the fields of a `write` or a `set`; returning
nothing lets the write go as it is. Returning an object for any other type of op is a `TypeError`,
because an `inc` or an `add` has no fields to replace.

The hook names are checked when the database opens. An unknown name or a value that is not a function is
a `TypeError` from `createDatabase()`, so a misspelled hook fails loudly instead of never running. The
[events and hooks reference](../reference/events#database-hooks) lists every field of the context.

## Handle a hook that throws

<<< @/examples/hooks.mjs#hook-error

The operation rejects with a `HookError`: its `code` is `HOOK_FAILED`, `hook` names the hook and `cause`
is what your function threw. A hook's error is never swallowed. When a `before` hook throws, nothing was
stamped, logged or written. When an `after` hook throws, the write already happened and is announced to
listeners and peers like any other; only the promise of the call rejects. [Errors](./errors) covers the
other errors syncom raises.

## Keep hooks quick, and never write from one

Every local write and every batch from a peer goes through one queue, and the write and apply hooks run
inside it. A hook that awaits something slow holds every other write for that long. A hook that writes
would wait for the queue, which waits for the hook, so syncom refuses such a write with a `SyncomError`
whose code is `IN_HOOK` instead of letting it deadlock. Reads (`get()`, `has()`) are fine from any hook.

<FigWriteHooks />

Inside the queue a write runs `beforeWrite`, gets its stamp, is applied and validated, and is appended to
the log. The queue moves on to the next write there. The rest follows outside the queue, in log order,
once the op is durable in the log: `afterWrite` runs, and then the events fire. If you need to write in
response to a write, listen to an event: a listener that writes queues behind the write it heard about.

## Shape what `get()` returns

`beforeRead` and `afterRead` wrap `get()`. Whatever `afterRead` returns, other than `undefined`, is what
the caller sees, so it can redact a field:

<<< @/examples/hooks.mjs#after-read

The read hooks run for `get()` and everything that reads through it: a collection's `get()`, a read at a
version, each version `history()` hands out, and a live [document](./document). They do not run for a
[query](./query): a cursor reads the records themselves, as replication does when it sends a snapshot.
So `afterRead` is a convenience for what `get()` hands back, not access control. To keep data away from a
node, give it only the [scopes](./partial-sync) it may see, or [encrypt](./encryption) the records.

The read hooks run outside the write queue. A write issued from one queues like any other write.

## Decide what a peer's op does here

Ops from other nodes have hooks of their own: `beforeApply` runs once per op before it is applied, and
`afterApply` once per batch after the batch is durable. Here a node that serves as an archive keeps every
task, even after another node deleted it:

<<< @/examples/hooks.mjs#before-apply

A laptop syncs with it and deletes a task. The laptop no longer has it; the archive still does:

<<< @/examples/hooks.mjs#skipped

Returning `false` from `beforeApply` leaves this node's record as it was, and nothing else. The op is
still appended to this node's log, still relayed to the nodes behind it and still announced as a
`change`. It cannot be dropped: ops of one origin are numbered without holes, and a missing op would stop
every later op of that origin from reaching anyone who syncs through this node. Each node decides for
itself, so the two nodes above are meant to differ. To refuse a write for every node, the node that hosts
the sync protocol uses `authorizeWrite` instead (see [Server](./server)): the writer is told and sets its
record back.

A `beforeApply` that throws aborts the whole batch before anything is durable. The sending node sees a
failed push, keeps its place, and offers the same ops again at the next handshake.

## Control the connection

The sync manager has hooks of its own, under `sync.hooks`:

<<< @/examples/hooks.mjs#sync-hooks

`beforeConnect` runs before a registered node is dialed, and `false` leaves it registered but not dialed.
`beforeBootstrap` runs when a host cannot resume this node from its log and is about to hand it the whole
state; `false` refuses, and the link stays up for pushes. `beforeSend` runs before each op leaves for a
peer: `false` sends the op scrubbed, its header alone, which is a no-op where it lands and leaves no hole
in the numbering. `onRevoke` runs when a host takes [scopes](./partial-sync) back from this node. A sync
hook that throws is reported through the sync manager's `error` event rather than through a promise.

None of these hooks can hide a record from one peer. Scopes are the tool for that: a node receives only
the scopes it asked for and was granted.

## Watch what happened with events

`on()` subscribes to an event. The database announces every op it logs (`change`), every local write
once it is durable (`commit`), every turn of writes (`transaction`) and more; a collection announces its
own records as they arrive, leave or change; and `observe()` follows one record or one field of it:

<<< @/examples/hooks.mjs#events

`via` is `null` for a write made on this node and names the peer otherwise, so the same listener tells
your own writes from replicated ones. A listener is called at once and never awaited. If it throws, the
failure is logged as a warning and the operation carries on. A database takes up to 100 listeners per
event by default (`createDatabase({ maxListeners })`), and adding the same function twice throws. The
sync manager (`db.sync`) has events of its own for links, pages and refusals.

The full list, with every payload, is in the [events and hooks reference](../reference/events#database-events).

## Choose between a hook and an event

|                         | Hook                                   | Event                          |
| ----------------------- | -------------------------------------- | ------------------------------ |
| Runs                    | Inside the operation, awaited          | After it, never awaited        |
| Can change or refuse it | Yes                                    | No                             |
| How many                | One function per name                  | Up to `maxListeners` per event |
| When it throws          | The operation fails with a `HookError` | A warning is logged            |
| Set up                  | In `createDatabase()`                  | With `on()`, at any time       |

A validation, a computed field or a redaction is a hook. A counter on a dashboard, a log line, a cache to
invalidate or a UI to redraw is an event. For a UI, [Reactivity](./reactivity) turns queries and records
into stores a framework reads, which is usually easier than listening yourself.

## Coming from RxDB

RxDB's middleware hangs several hooks on each collection and moment (`preInsert`, `postSave`,
`preRemove`…), run in series or in parallel, and edits the document in place; documents that arrive
through replication do not run them. A syncom database has one function per hook name for all of its
collections, it sees every kind of op, and it returns a replacement instead of editing in place. It also
has hooks RxDB has no equivalent for: on reads, and on ops from peers (`beforeApply`). The validation
RxDB leaves to a schema plugin can live in [schema validation](./schema-validation) or in `beforeWrite`.

::: code-group

<<< @/examples/hooks.mjs#before-write [syncom]

<<< @/examples/rxdb/hooks.mjs#before-write [RxDB]

:::

<FromRxdb page="middleware" :rows="['hooks', 'replHooks', 'outHook', 'readHooks']" />

Every hook's context and every event's payload: [Events and hooks](../reference/events).
