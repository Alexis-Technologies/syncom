# src/connector/CLAUDE.md — Connectors

A collection kept in step with a backend of its own through two handlers. The rules of the core are in [src/CLAUDE.md](../CLAUDE.md); what holds for the whole repository is in [CLAUDE.md](../../CLAUDE.md).

## Layout

```
src/connector/connector.js @alexify/syncom/connector — replicate(db, { name, collection, pull, push, live, retryTime, batchSize,
                          modifier, resolve }): pulled documents landed as one transaction a page (`source: connector:<name>`), the
                          collection's turns pushed as rows with what the backend was assumed to hold, conflicts the backend wins,
                          the checkpoint `{ pull, pushed }` in the `connector` kv namespace — requires symbols.js, engine.js,
                          shape.js, errors.js, hooks.js, emitter.js, same.js only
src/connector/same.js     canonical, same — the zone's one "the same reading" (keys sorted), kept apart from shape.js's canonical so an
                          adapter weighs nothing of the core — no requires
src/connector/jsonfile.js jsonFile(store, { poll }) — one JSON file as a backend, what the two drives share: `n` the position of a document's
                          newest write, the ETag the compare-and-set (412 read again and tried RETRIES times), a probe for the stream;
                          requester — the fetch with the common headers that throws with the status — requires same.js only
src/connector/couchdb.js  @alexify/syncom/connector/couchdb — couchdb({ url, fetch, headers, longpoll }): the handlers over one CouchDB
                          database through an injected fetch — _changes with the documents, a long poll as the stream, _bulk_docs with
                          the revisions last seen, a conflict read back — no requires
src/connector/graphql.js  @alexify/syncom/connector/graphql — graphql({ url, fetch, headers, request, pull, push, stream }): the application's
                          queries posted and their answers read by its functions; one adapter for every schema — no requires
src/connector/mongodb.js  @alexify/syncom/connector/mongodb — mongodb({ collection, changes, now }): the handlers over one collection of the
                          injected driver — _rev, _deleted, _updated the adapter's fields, a change stream the signal — no requires
src/connector/supabase.js @alexify/syncom/connector/supabase — supabase({ client, table, primaryKey, modifiedColumn, deletedColumn, channel,
                          stream, now }): the handlers over one table through the injected client — PostgREST with the modified column
                          as the compare-and-set, Realtime's postgres_changes the signal — no requires
src/connector/firestore.js @alexify/syncom/connector/firestore — firestore({ sdk, database, collection, stampField, deletedField, stream }): the
                          handlers over one collection through the injected modular SDK — the server stamp and a tombstone the adapter's
                          fields, a cursor after the checkpoint, one transaction a push, onSnapshot the signal — requires same.js only
src/connector/appwrite.js @alexify/syncom/connector/appwrite — appwrite({ client, databases, Query, databaseId, collectionId, deletedField,
                          stream }): the handlers over one collection through the injected SDK — $updatedAt the position, a boolean
                          attribute the tombstone, a read then a write the push, Realtime the signal — requires same.js only
src/connector/gdrive.js   @alexify/syncom/connector/gdrive — gdrive({ fetch, token, headers, name, fileId, folder, endpoint, poll }): one JSON
                          file of the collection in the user's Drive (the application data folder) through an injected fetch — the v2
                          metadata's ETag, alt=media, the media upload under If-Match — requires jsonfile.js only
src/connector/onedrive.js @alexify/syncom/connector/onedrive — onedrive({ fetch, token, headers, path, drive, endpoint, poll }): one JSON file
                          of the collection in the user's OneDrive through Microsoft Graph — root:/<path> for the eTag, /content, PUT
                          under If-Match — requires jsonfile.js only
```

## Rules

- **A pull is a write of this node; an echo is no write.** What the backend hands over lands through `db.transact`
  as `set`/`delete` stamped here — a pulled record reaches every peer like a local one, and the backend never sees
  an op or a meta — under `source: 'connector:<name>'`, which the connector's own `transaction` listener passes
  (never pushed back). A document that reads as the record already does (`same` over the canonical JSON, `$type`
  left out) makes no op: that is how this node's own writes, come back from the backend, make no echo and no
  stamp; a hash table of what was pushed would be lost at a restart. `$type` never leaves (`plain`) and is laid
  back on what comes in. A pulled document that is no document (`documentOf`: an id, an object or `deleted`) is
  said (`connector.document.malformed`) and left out, never the page.
- **A push follows the turns and assumes the backend's state.** Every `transaction` event but this connector's own
  pulls hands the records of the collection it changed (the row's type, a purge's `type`) to `#pending`; one push is
  in flight at a time, `batchSize` rows a call, a row `{ id, data, deleted, assumed }` — `assumed` the backend's state
  as this node last knew it (what came in a pull, what went out in a push, what a conflict said), for a
  compare-and-set backend. The log position taken BEFORE the rows are read is what `pushed` moves to after the push:
  a restart pushes `log.since(pushed)` — the collection's records those entries touched — or every record of the
  collection once where the log cannot resume (`connector.rebuild`; tombstones not among them). A conflict the
  handler answers (the row as the backend holds it) is the backend's win: the record is set to it here under
  `source: 'connector:<name>:resolve'` — a turn the connector hears, so a `resolve` that answers something else goes
  back to the backend with the backend's state as `assumed`. A handler that throws is told (`error`,
  `REPLICATION_FAILED` with `direction`), kept (`errors`, the newest twenty) and tried again after `retryTime`;
  nothing is skipped and no checkpoint moves past it. A pull whose checkpoint does not move while it answers full
  pages is asked `MAX_STALLS` times, then left to the stream.
- **Live is the backend's stream or a timer, never a hook on the peers.** `pull.stream(emit)` hands pages or
  `'RESYNC'`; without one a live connector pulls every `retryTime`. `cancel()` is for good (the stream stopped, the
  listener off, what is in flight awaited, the waiters rejected); `reSync()` pulls and pushes again. Under `/shared`
  the leader runs the connector (`leader` is the plan's; not here yet).
- **An adapter is the two handlers over an injected client, and nothing of the backend's.** No SDK, no HTTP client
  and no protocol of the backend's ships with syncom: an adapter takes `fetch`, the driver's collection or the
  vendor's client as it is given, answers `{ pull, push }` to spread into `replicate()`'s options, and requires nothing
  (`scripts/size.js` holds each under 2 KB). What a compare-and-set needs — the revision or the stamp last seen for a
  document — lives in the adapter's memory for the connector's life: a connector started anew learns it with its
  first pull, a push of a document never seen lands as a new one and is a conflict where one exists. A conflict is
  answered as the backend holds the document (a deletion where it holds nothing), never guessed. A backend whose
  schema is the application's (GraphQL) takes the queries and the readers as options — syncom knows no schema. Every
  adapter is tested over a fake of its backend in `tests/utils/fake-<name>.js` (`fake-couch`, `fake-graphql`,
  `fake-mongo` — the engine's, `fake-supabase`, `fake-firestore`, `fake-appwrite`, `fake-drive` — Google Drive's and
  Graph's faces over one file store) through one scenario in `tests/connector.adapters.test.js`: a local write out
  without `$type`, the backend's write in, a change behind the adapter's back a conflict the backend wins, a deletion
  both ways, a restart resumed.
- **A backend without a compare-and-set says so.** Where the backend writes conditionally (CouchDB's `_rev`, Mongo's
  `replaceOne` on `_rev`, PostgREST's match on the modified column, a Firestore transaction, a drive's `If-Match`) a
  conflict is decided by the backend itself. Appwrite has no such write: the adapter reads, compares and writes, and
  a write landing between is overwritten — the docs say so, as the matrix says it of RxDB's. A drive is one JSON
  file of the collection (`jsonfile.js`), not a file per document with a lock file (RxDB's scheme): one ETag decides,
  a 412 reads the file again, and the collection stays under the drive's simple-upload size (Graph: 4 MB).
