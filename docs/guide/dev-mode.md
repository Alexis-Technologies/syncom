---
title: Development checks
description: Why syncom has no separate dev mode like RxDB's, which checks always run, and the tools that help you look inside while developing.
---

# Development checks

<NotInSyncom page="dev-mode" />

RxDB's dev-mode is a plugin you add while developing and remove for production. With it, errors carry
readable messages instead of bare codes, the data a query hands back is deep-frozen so that editing it
throws, and schemas and queries are checked for mistakes before they run. Without it those checks are
off, which keeps the production bundle smaller and faster.

## Why syncom does not have one

syncom runs the same checks in production as in development, because they are cheap and because a check
you only run in development misses the data you meet in production. Every option, entity definition and
query is checked where it enters: a typo in a definition is a `TypeError` at `createDatabase()`, and a
query with an operator syncom does not know is a `TypeError` at `select()`, before anything runs.

<<< @/examples/dev-mode.mjs#definition

<<< @/examples/dev-mode.mjs#query

Every operational failure is a `SyncomError` with a `code` and a full message, in production too, so you
handle errors by their code rather than by parsing text ([Errors](./errors) lists how):

<<< @/examples/dev-mode.mjs#code

There is nothing to freeze either. What you read from a database is a JSON copy, so editing it changes
nothing stored, and what you write is copied on the way in:

<<< @/examples/dev-mode.mjs#copies

## Look inside while you develop

When you want to see what syncom did, `inspect()` from `@alexify/syncom/inspect` shows a record's
anatomy without changing it: the kind of every field and the operations the log holds for it.

<<< @/examples/dev-mode.mjs#inspect

The same subpath has `indexAdvisor()`, which suggests indexes for the queries no index served, and
`anonymize()`, which strips the words out of a record for a bug report. [Devtools](./devtools) covers them,
[Logger](./logger) shows how to route syncom's log lines, and [Telemetry](./telemetry) adds spans and
metrics.

## Coming from RxDB

Remove the dev-mode import and its `addRxPlugin()` call: there is nothing to switch on in development or
off in production, and no warning to silence.

<FromRxdb page="dev-mode" :rows="['devMode', 'errors', 'returnedData', 'queryValidation']" />
