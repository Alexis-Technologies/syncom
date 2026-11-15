---
title: Logger
description: Send syncom's log lines to the console, pino or nowhere, filter them by level, and react to the named events every line carries.
---

# Logger

A database runs work you did not call directly: it replays its log at open, applies the ops peers send, saves its
catalog in the background, and calls your event listeners. When something goes wrong there, no promise of yours
rejects, so syncom writes a log line instead. Every line is one object whose `event` field names what happened,
such as `{ event: 'listener.error', name: 'change', err }`, and you choose where the lines go with the `logger`
option of `createDatabase()`: the console (the default), a pino-shaped logger, or nowhere.

## See what the database logs

Without a `logger` option, lines go to `console`:

<<< @/examples/logger.mjs#default

Both lines above are routine, logged at `debug` the first time a database opens. The console prints every level,
so in development you see everything; give the database a logger with levels to keep production logs to what
matters.

## Send logs to pino

Any object with `debug`, `info`, `warn` and `error` methods that take an object works, which is the shape of pino,
of `console`, and of most structured loggers:

<<< @/examples/logger.mjs#pino

pino drops what is below its level, adds its own fields (`level`, `time`, the `base` bindings) and writes one JSON
line per event, ready for whatever collects your logs. The `event` field and the fields next to it are syncom's.

## Keep only warnings and errors

A level the logger does not have is skipped, so the smallest filter is an object with the levels you want:

<<< @/examples/logger.mjs#levels

## Silence the database

<<< @/examples/logger.mjs#silent

`logger: false` drops every line. Nothing else changes: the database's `error` event still fires for what you
should handle in code (an op a peer sent that this node refused, a record file that could not be written), so a
silent database is not a blind one if you listen to it. Tests usually pass `logger: false`.

## React to named events

The `event` names are a stable surface: a dashboard, an alert or a log query can key on them. Route lines by name
in the logger itself:

<<< @/examples/logger.mjs#route

A listener that throws does not fail the write that called it. syncom catches the error and logs it as
`listener.error` at `warn`, with the event's `name` and the error as `err`. The levels follow the same idea
everywhere:

- `error`: data is at risk or a write failed, such as `storage.unpersisted` (ops logged whose record files could not
  be written, kept in memory until the next open) or `log.append.failed`;
- `warn`: something was refused or skipped and the database carried on, such as `sync.op.invalid` for a peer's op
  that failed this node's [validation](./schema-validation), or `listener.error`;
- `info`: something worth saying out loud, such as `schema.upgrade` when a directory opens under a newer schema
  version, or `database.drop`;
- `debug`: routine work, such as `catalog.rebuild` or `log.epoch.new`.

Many `error` and `warn` lines have a matching `error` event on the database or its sync manager carrying a `code`
(`UNPERSISTED`, `OP_INVALID`, `SKEW`…). Handle those in code with `db.on('error', …)`, and use the log for what an
operator reads. Every event name, its level and its fields are in the
[log events table](../reference/telemetry#log-events).

## Spans and metrics

A logger tells you what happened; it does not time the writes or count them. For spans around every commit, every
page of ops applied and every push, and metrics such as the ops received and refused and the replication lag,
inject OpenTelemetry instead: [Telemetry](./telemetry) shows how. The two are independent and you can use both.

## Coming from RxDB

RxDB's logger is a Premium wrapper around the storage that logs every storage call and can time it. syncom's logger
is part of the core and logs events (what failed, what was refused, what changed state) rather than every call;
timing every call is the job of syncom's OpenTelemetry spans.

<FromRxdb page="logger" :rows="['logging', 'otel']" />
