# src/mongodb/CLAUDE.md — MongoDB

The engine over MongoDB, Node only, the driver injected. The engine contract and the rules of the core are in [src/CLAUDE.md](../CLAUDE.md); what holds for the whole repository is in [CLAUDE.md](../../CLAUDE.md).

## Layout

```
src/mongodb/mongodb.js    @alexify/syncom/mongodb — mongoEngine({ client, db, name, transactions, changes }): the engine over one
                          MongoDB database — kv, records (JSON text), pieces, copies, log (a document per entry with its group's
                          first seq), meta; `_id` the key as JSON, the key's fields flat beside it over an index per collection;
                          a bulk write per collection per write set, in a session transaction under `transactions: true`; change
                          streams as `db.changes` — requires engine.js, errors.js only
```

## Rules

- **The driver is the application's.** `mongoEngine({ client })` takes the connected `MongoClient` (or `{ db }`, a
  `Db`), never requires `mongodb`, never connects or closes: `engine.close()` does nothing, `engine.destroy()`
  drops the database. The driver is a devDependency for `tests/engine.mongodb.test.js` under `MONGODB_URL` alone;
  `tests/utils/fake-mongo.js` is what every other test runs over — as much of the driver as the engine speaks, and
  it throws on a method it lacks, so a test never passes on one the real driver would not have. A new call on a
  collection is added to the fake first.
- **Every put is an upsert; a set is ordered.** Without `transactions` a write set is a bulk write per collection
  in the files engine's order — kv puts, the pieces a record makes, the records (and the removals), the pieces it
  drops, the copies, kv removals — so a failure midway leaves what the replay lands again whole. The log's group
  is one ordered bulk write too, but a failed group's seqs are taken back and reused, and the failed write may
  have landed — whole or in part, its acknowledgement lost — so a group that failed after it landed is not a
  group: every document carries its group's `first` and `last`, every group's bulk write begins by wiping every
  document at or past its first seq (nothing acknowledged sits there: a seq is handed out once per epoch), the
  catch of a failed append wipes them as a best effort, and `load` leaves out a newest group short of its
  documents. Under `transactions: true` the set is one session transaction and `atomicBatch` holds;
  that needs the client (sessions are its) and a replica set. `kv.create` is the one `insertOne`: the unique
  `_id` refuses a key held (E11000 → `EEXIST`).
- **A change stream tells writers apart by token.** Every record and log document carries `w`, the writer's
  token; `db.changes` hears `records` and `log` through `watch` and drops what carries its own. A deletion
  carries no document, so the ids this instance removed are remembered (`deleted`) and dropped once. One
  message per document, never per set: a follower re-reads what it hears. `changes: false` for a standalone
  server, where `watch` would fail.
