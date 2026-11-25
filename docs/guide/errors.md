---
title: Errors
description: How syncom reports failures, how to handle a SyncomError by its code, and which errors arrive as events instead of rejections.
---

# Errors

syncom reports a failure in one of three shapes. A `SyncomError` with a `code` is an operational failure that
correct code can run into: a record that is gone, a directory another process holds, a peer's op that does not
fit. A `TypeError` is a bug in the call itself: a wrong argument or option. And a failure that has no caller to
reject, such as an op from a peer that this node cannot apply, arrives as an `error` event. This page shows how
to handle each; the full list of codes, who raises them and which fields they carry is in the
[API reference](../reference/api#syncomerror).

## Handle an error by its code

Every `SyncomError` has a short constant in `code` and the details as fields of its own. Test the class, switch
on the code, and rethrow what you do not handle:

<<< @/examples/errors.mjs#by-code

`ALX_ERR_NOT_FOUND` here carries the `id` it could not find. Switch on `code`, never on `message`: the message is written
for a person and may change, the code is part of the API. The messages are complete in every build, so a log line
reads well without a development mode.

Some codes are worth handling in almost every app. A second open of a directory that another instance holds
rejects with `ALX_ERR_LOCKED`, which in a browser usually means a second tab (see [Leader election](./leader-election)):

<<< @/examples/errors.mjs#locked

An `insert()` whose data names the id of a record that is already there rejects with `ALX_ERR_EXISTS`, with the `id` and
the collection as `entity`:

<<< @/examples/errors.mjs#exists

## An ArgumentError means the call is wrong

A wrong argument, a misspelled option or a hook that returns the wrong thing is an `ArgumentError`, a `TypeError`
whose `code` is always `ALX_ERR_INVALID_ARGUMENT`. Do not catch it to recover; fix the call. A `DataError` is a
`TypeError` too, but its bad value came from data rather than from your code, and you may want to tell a user about
it. An id typed into a form is the common case:

<<< @/examples/errors.mjs#type-error

The codes of a `DataError` are `ALX_ERR_INVALID_ID`, `ALX_ERR_TYPE_IMMUTABLE` (a write that changes a record's collection),
`ALX_ERR_ID_IMMUTABLE` (a write that changes a field a composite id is made of), `ALX_ERR_INVALID_VERSION`, `ALX_ERR_BLOB_TOO_LARGE`,
`ALX_ERR_PRESENCE_SIZE`, and two about configuration: `ALX_ERR_NO_CHAIN` and `ALX_ERR_PLUGIN_MISSING`. A call into a feature whose
[plugin](./plugins) this database was not opened with is `ALX_ERR_PLUGIN_MISSING`, and the message names the import that
fixes it:

<<< @/examples/errors.mjs#plugin-missing

What a code documents beside it is under `details`: a collection's refused id names its `entity` and `field`, a blob
past the cap its `length` and `max`. In TypeScript the unions are `SyncomErrorCode` (the codes of `SyncomError`),
`DataErrorCode` (the codes of `DataError`) and `ErrorCode` (every code, `ALX_ERR_INVALID_ARGUMENT` included), all
exported from the package root with the classes.

## When a hook throws

A [hook](./hooks) that throws fails the operation it runs in with a `HookError`: `code` is `ALX_ERR_HOOK_FAILED`, `hook`
names the hook, and `cause` is what your hook threw.

<<< @/examples/errors.mjs#hook

For a `before*` hook the operation did not happen: nothing was written. For an `after*` hook it did, and only the
caller's promise rejects. `HookError` is a `SyncomError`, so a handler that switches on `code` sees it as
`ALX_ERR_HOOK_FAILED`.

## When a record does not validate

A write that would leave a record invalid under its collection's [schema](./schema-validation), or that takes a
unique key another record holds, rejects with a `ValidationError` before anything is stamped or logged. `entity`
names the collection and `issues` says what is wrong, as `{ path, message, code? }`:

<<< @/examples/errors.mjs#validation

A unique-key issue also names the record that holds the key (`conflict`). Two nodes that take the same key while
apart cannot be refused this way, since each write is already in its node's log; that case is reported as a
`conflict` event, which [Transactions and conflicts](./transactions-conflicts) covers.

## Errors that arrive as events

Some failures happen where nobody awaits a promise: an op from a peer, a record file that could not be written
after its op was logged, a host that refused this node. syncom reports those on the `error` event of the database or
of its sync manager. A listener only observes: the database has already done what it does with the op (logged
and relayed it, so no other node waits on a gap), and an `error` with no listener is dropped quietly rather than
thrown.

The database's `error` event reports what its own data path refused. Here a phone runs without the text plugin and
receives a text edit from a laptop:

<<< @/examples/errors.mjs#database-error

The sync manager's `error` event reports a failure on the way to a peer, with `url` naming the peer: a dial that
failed (the error your `connect` threw), a push that did not go through, a page that could not be applied. A host
that refuses a peer answers with a number rather than a `SyncomError`: the HTTP-style status the transport carries
(`400`, `403`, `409`, `413`, `428` or `429`) and the name of the check in `reason`.

<<< @/examples/errors.mjs#sync-error

Listen to both in production and send them to your logs or your [telemetry](./telemetry). The payload of every
event is in the [events reference](../reference/events).

## Errors that cross a boundary

A refusal that travels between two parts of syncom keeps its shape. A follower tab's write that the leader refuses
is rethrown in the follower with the same code and fields, and so is an error from an engine served over a port.
An error from your own code inside a hook or a handler reaches you as the `cause` of the `SyncomError` that
reports it.

## Coming from RxDB

RxDB throws an `RxError` with a code such as `COL20` or `CONFLICT` and the details in `parameters`; the readable
message ships only with the dev-mode plugin. A syncom code is a word (`ALX_ERR_EXISTS`, `ALX_ERR_NOT_FOUND`, `ALX_ERR_LOCKED`), the details
are fields on the error itself, and the message is always there. Inserting a record whose id exists, side by side:

::: code-group

<<< @/examples/errors.mjs#exists [syncom]

<<< @/examples/rxdb/errors.mjs#exists [RxDB]

:::

RxDB's replication reports its failures on `error$` observables; syncom's equivalent is the `error` event of the
database and of the sync manager.

<FromRxdb page="errors" :rows="['errors', 'errorEvents']" />
