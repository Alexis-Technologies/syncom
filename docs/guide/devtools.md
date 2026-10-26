# Devtools

`@alexify/syncom/inspect` is what you reach for when a record does not read
as you expect and you want to see what it is made of — and what you hand
over when you report it.

```js
import { inspect, anonymize } from '@alexify/syncom/inspect';

const report = await inspect(storage, id);
report.reading;                 // the record as get() would read it, lens and hooks aside
report.data;                    // the op model's terms: every path a field of its own
report.fields;                  // [{ field, kind, reachable, …the kind's counts and stamps }]
report.log;                     // every retained log entry of the record, by seq
```

## What `inspect()` shows

- `present`, `encrypted`, `alive`; `base`, `deleted` and `purged`, the
  reset stamps; `v`, the schema version the record was written under.
- `fields`: every field the metadata holds, sorted — a register with its
  `stamp` (`[ts, origin]`), a counter with its `sums` per stream (the
  origin, or `origin@scope`), a set with its `elements` (slots) and how many
  are `live`, a list or a text with its
  block code `k`, newest stamp `ts` and how many `runs`, `cuts`, `ext`,
  `pos`, `vals` and `marks` it holds, a tree with its `nodes` and `moves` —
  and `reachable`, whether the composed reading shows it (a field under a
  list element that is not shown is kept but not read).
- `log`: the record's retained entries — `seq` and `eventId`, the op's
  `type`, `origin` and its `stream` seq, `ts`, `scope`, `field`, `actor`,
  `message`, whether it is `signed`, `skipped` (a hook or a validator left
  it unapplied here) or `scrubbed` (a purge took its payload).

Nothing is read through the lens or the hooks, nothing is written, and an
encrypted record shows its data and no metadata (it has none that
replicates). `stats()` and the [telemetry](./telemetry) say how the node
is; `inspect()` says what a record is.

## Handing a case over

`anonymize(value, { salt, keys })` copies anything JSON — a report, a
snapshot page, an op, a whole dump — with every string replaced by a stable
hash of it: the same id, origin or word reads the same throughout the
copy, so the structure of a case survives, and nothing of its words
leaves. Numbers, booleans and nulls stay (counts, stamps, lengths are the
shape); keys stay unless `keys: true`. Change the `salt` and every hash
changes, so two copies cannot be lined up.

```js
const page = await storage.snapshot();
const safe = anonymize({ report: await inspect(storage, id), page }, { salt: 'case-42' });
```
