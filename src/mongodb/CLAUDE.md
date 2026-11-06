# src/mongodb/CLAUDE.md — MongoDB

The engine over MongoDB, Node only, the driver injected. The engine contract and the rules of the core are in [src/CLAUDE.md](../CLAUDE.md); what holds for the whole repository is in [CLAUDE.md](../../CLAUDE.md).

## Layout

```
src/mongodb/mongodb.js    @alexify/syncom/mongodb — mongoEngine({ client, db, name, transactions, changes }): the engine over one
                          MongoDB database — kv, records (JSON text), pieces, copies, catalog (a document per record's row), log (a document per entry with its group's
                          first seq), meta; `_id` the key as JSON, the key's fields flat beside it over an index per collection;
                          a bulk write per collection per write set, in a session transaction under `transactions: true`; change
                          streams as `db.changes`; the subpath also exports mongoSharedLog — requires engine.js, errors.js,
                          shared-log.js only
src/mongodb/shared-log.js mongoSharedLog({ client, db, name, collection, changes, poll, gapTimeout, retention, logger }): a shared log
                          (wrpc's BrokerLog shape) over two collections — a topic's entries `[topic, n]` numbered by its head document
                          (`<collection>_heads`: epoch, next, first) in one findOneAndUpdate; a read a range by `n` then a tail woken by a
                          change stream or a poll; 410/400 as wrpc's feeds speak them; trim, retention — no requires
```

## Rules

- **The driver is the application's.** `mongoEngine({ client })` takes the connected `MongoClient` (or `{ db }`, a
  `Db`), never requires `mongodb`, never connects or closes: `engine.close()` does nothing, `engine.destroy()`
  drops the database. The driver is a devDependency for `tests/engine.mongodb.test.js` under `MONGODB_URL` alone;
  `tests/utils/fake-mongo.js` is what every other test runs over — as much of the driver as the engine speaks, and
  it throws on a method it lacks, so a test never passes on one the real driver would not have. A new call on a
  collection is added to the fake first.
- **Every put is an upsert; a set is ordered.** Without `transactions` a write set is a bulk write per collection
  in the files engine's order — kv puts, the tags' copies, the pieces a record makes, the records (and the
  removals), the pieces it drops, kv removals — so a failure midway leaves what the replay lands again whole, and
  never a changed record without the copy the tag keeps of it. A log or meta document that does not parse at open is
  counted `corrupt` and left out (`log.row.unreadable`, `log.meta.unreadable`); the segments list in memory moves once
  the medium has it. The catalog is a document a record (`row`, its JSON): a save writes the rows that changed, never
  the catalog as one document, which 16 MiB would end. The log's group
  is one ordered bulk write too, but a failed group's seqs are taken back and reused, and the failed write may
  have landed — whole or in part, its acknowledgement lost — so a group that failed after it landed is not a
  group: every document carries its group's `first` and `last`, every group's bulk write begins by wiping every
  document at or past its first seq (nothing acknowledged sits there: a seq is handed out once per epoch), the
  catch of a failed append wipes them as a best effort, and `load` leaves out a newest group short of its
  documents. Under `transactions: true` the set is one session transaction and `atomicBatch` holds;
  that needs the client (sessions are its) and a replica set. `kv.create` is the one `insertOne`: the unique
  `_id` refuses a key held (E11000 → `EEXIST`).
- **The lease is the server's clock and a generation; every document carries the generation (the fence).**
  `lock()` makes the lease document with `insertOne` (its expiry on the client's clock for the one round trip
  until `updateOne` sets it to `$$NOW + staleAfter` — the only time the client's clock is trusted), takes a
  lapsed one through `findOneAndUpdate({ $expr: { $lt: ['$expires', '$$NOW'] } })` with a pipeline that counts
  `gen` one up, renews with `{ _id, owner, gen }` on `$$NOW`, and a release leaves the document lapsed
  (`expires: new Date(0)`) so the count goes on; `remove(path)` deletes it. No `Date.now()` reaches a filter or
  a stored expiry. A handle writes with the generation of the lease it holds; one that never locked — opened
  with `lock: false`, or `copyEngine`'s target — writes with the generation the lease document held at its
  open, 0 where none ever did. Every put is
  `updateOne({ _id, gen: { $not: { $gt: gen } } }, { $set: { …, gen } }, { upsert: true })`
  and every `deleteOne`/`deleteMany` carries the same filter: a document of a newer lease does not match, the
  upsert tries an insert, the `_id` collides, E11000 stops the ordered bulk and the statement — the write set,
  the log group, a seal, the index, a kv or copies put — fails as `LEASE_LOST` (`fenced`; `kv.create`'s E11000
  stays `EEXIST`). Under `transactions: true` the lease (`{ _id, owner, gen }`) is read inside the transaction
  first, absent → `LEASE_LOST` before anything is written. The driver is 6 or later (`findOneAndUpdate` answers
  the document; `taken?.value ?? taken` reads an older one defensively). Every lease the engine holds is renewed on
  ONE timer, in one bulk write a tick at the shortest margin among them (keyed by the holder's token: a lease lost and
  not yet noticed and the next on the same path are two); a tick that lands short or fails hands each lease its own
  renewal, which tells the lost one from the rest and keeps its retry (`late`, then lost) as it is.
- **The shared log numbers in the head, waits for a hole, and is not the engine's log.** `mongoSharedLog` keeps a
  topic's entries apart from the engine's `log` collection (a follower never reads the writer's op log — it hosts
  from the shared log, src/sync/shared.js): `append` takes a number from the topic's head document
  (`findOneAndUpdate` with a pipeline, upsert — the one round trip two appenders agree through, so two never share
  a number) and inserts the entry after it, so a reader that finds `n + 1` before `n` waits `gapTimeout` for `n`
  (an insert is one round trip behind its number) and then skips it as a crashed appender's hole; the epoch is
  minted once per topic (`$ifNull` keeps the first) and a topic never appended to adopts the first head it sees.
  A tail is one per topic per instance, shared by its readers: a change stream matched to the topic on the server
  wakes them, a poll every `poll` ms where there is none or it failed (`shared.stream.failed`); every read checks the
  head again before it yields (another epoch or a trim under it is 410). `trim` and `retention.maxEntries` move
  `first` with `$max` — the fake supports `$max` for it — and delete below it.
- **A change stream is one path's records, matched on the server, and its end is heard.** `db.changes`
  watches `records` alone (the `log` collection is not watched: a follower hosts from the shared log, never
  from the writer's op log) with a pipeline — `$match` on `fullDocument.p`, or for a deletion (no document) on the key's
  JSON prefix `["<p>",` by `$regex`, then `$project` without `fullDocument.t` — under `fullDocument:
'updateLookup'`, because every put is an upsert and an update event carries no document otherwise. Every
  record and log document carries `w`, the writer's token — one per `open(path)`, so two handles of one engine
  tell each other apart — and what carries its own is dropped. A deletion carries no document, so the ids this
  instance removed are remembered (`deleted`, once the write landed, only while a subscription is live) and
  dropped once. One message per document, never per set: a follower re-reads what it hears. The stream's
  `error`, `close` and `end` are listened to (an unheard `error` would crash the process): the listener hears
  `{ error }` once and the subscription is over — the follower subscribes again and reads every record again
  (`FOLLOW_LOST`). `changes: false` for a standalone server, where `watch` would fail.
- **A blob is a document of bytes.** `blobs` (`{ _id, p, digest, b }`, `b` the bytes: the driver's Binary, answered as a
  Uint8Array through `bytesOf`; a fake's own Uint8Array as it is), fenced like every put; one document a blob, under 16 MB.
