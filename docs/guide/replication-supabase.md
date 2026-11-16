---
title: Supabase replication
description: Keep a syncom collection in step with a Supabase table through the client you inject, PostgREST's conditional update and Realtime.
---

# Supabase replication

Choose the Supabase adapter when a Postgres table behind Supabase is the backend of record: your dashboard, edge
functions or other apps read and write it, and syncom nodes keep a collection in step with it. The adapter takes the
`@supabase/supabase-js` client from your app, pulls the rows modified since a checkpoint, pushes with an `update`
matched on the modified value it last saw (so a row changed by someone else matches nothing and comes back as a
conflict), and follows Realtime's `postgres_changes`. It is a [connector](./connectors), about 2 KB, with nothing of
Supabase bundled.

<div class="sc-steps">

### Create the table

Besides your fields, the table needs a primary key, a boolean that marks a deletion, and a text column that every
write sets to a value that sorts in write order. Add the table to Realtime's publication for the live stream.

```sql
create table tasks (
  id text primary key,
  title text,
  done boolean,
  deleted boolean not null default false,
  updated_at text not null
);
alter publication supabase_realtime add table tasks;
```

The adapter sets `updated_at` to an ISO date on its own writes. A trigger that sets it on every write works too: the
adapter keeps the value the database stored for its next match, not its own. Row Level Security applies as for any
client, so the key you create the client with needs `select`, `insert` and `update` on the table.

### Connect the collection

<<< @/examples/replication-supabase.mjs#replicate

### Watch it work

<<< @/examples/replication-supabase.mjs#use

### Write from other clients

Other writers set `updated_at` on every write and delete by setting `deleted`, never by removing the row, which a pull
could not report.

<<< @/examples/replication-supabase.mjs#other-writer

Realtime tells the connector of both, and it pulls them. When another client changed a row after this node last saw
it, the push's `update ... where updated_at = <last seen>` matches no row; the adapter reads the row back and the
connector sets the record to the table's version, unless you pass `resolve`
([conflicts](./connectors#decide-what-wins-when-both-sides-changed-a-record)). A push of a row the adapter has never
seen is an `insert`, and a duplicate key is a conflict the same way.

### Name your own columns

<<< @/examples/replication-supabase.mjs#columns

</div>

## Options that matter

| Option | Default | Meaning |
| --- | --- | --- |
| `client` | (required) | The Supabase client, or anything with its `from()` builder |
| `table` | (required) | The table |
| `primaryKey` | `'id'` | The primary key column: the record's id |
| `modifiedColumn` | `'updated_at'` | The text column every write sets: the pull's order and the push's match |
| `deletedColumn` | `'deleted'` | The boolean column of a deletion |
| `schema` | `'public'` | The schema Realtime listens on |
| `channel` | `'syncom:<table>'` | The Realtime channel's name |
| `stream` | `true` | Follow Realtime (where the client has channels); `false` and the connector pulls every `retryTime` |
| `lookback` | `0` | How far before its checkpoint each pull starts, in ms: [rows that commit late](#pull-rows-that-commit-late) |
| `now` | an ISO date | The value the adapter writes to the modified column |

The adapter also answers `stampOf(id)`, the modified value it last saw for a row. The pull's checkpoint is
`{ at, id }`: the rows modified after `at`, or at `at` with a greater key, so the rows of one transaction (which share
one `now()`) are never skipped at a page's edge. A checkpoint of any other shape is no checkpoint: the pull starts
from the beginning. Every Realtime change is a `RESYNC`; the channel's `CHANNEL_ERROR`,
`TIMED_OUT` or `CLOSED` is an `END`, and the connector subscribes again after a backoff.

## Pull rows that commit late

The pull reads past a checkpoint, so a row that becomes visible with a stamp already behind it is never pulled.
Postgres makes that easy to hit: `now()` is the time a transaction began, so a transaction that runs for ten seconds
commits rows stamped ten seconds ago. Pass `lookback`, in milliseconds, and each pull starts that far before its
checkpoint:

<<< @/examples/replication-supabase.mjs#lookback

The rows of that window are read again at every pull. The connector passes over the ones it already knows (no
write, nothing counted in `stats().pulled`) and lands the late one. The checkpoint never moves back. Set `lookback`
to your longest transaction plus a margin;
[Connectors](./connectors#pull-by-a-timestamp-without-missing-late-writes) explains the rules and the cost.
`lookback` needs a modified column that reads as a date (`timestamptz`, or text in ISO 8601, which is what the
adapter's own `now` writes).

## Limitations

- **The cursor follows the modified column.** A write that becomes visible after a client pulled past its stamp (a
  transaction that started earlier but committed later, or a row stamped at the same instant as one already pulled,
  with a smaller key) is not pulled by that client unless [`lookback`](#pull-rows-that-commit-late) covers how late
  it was. A row later than the window is still missed, so stamp writes as late and as precisely as you can.
- **Deletions are rows.** A hard `delete` is never seen; set `deleted` instead.
- **One row, one request.** A push is an `update` or `insert` per row. A database error with a code on one row (a
  check constraint, a type) parks that row as `refused` with the code as the reason; an error without a code (the
  network) fails the push, which is retried.
- **Every field needs a column.** A record's fields are written as columns; a field the table lacks makes PostgREST
  refuse the row, and the connector parks it as `refused` with PostgREST's error code. Nested objects and arrays
  need `json` or `jsonb` columns.

## Coming from RxDB

RxDB's Supabase plugin also matches an update on the modified column and uses Realtime for live rows. This adapter
reads the client you pass and nothing else of Supabase, pulls with a `(stamp, key)` cursor so rows that share a stamp
are not skipped at a page's edge, keeps the stamp a trigger stored for its next match, and resumes a dropped channel.

<FromRxdb page="replication-supabase" :rows="['supabase', 'foreignBackend']" />
