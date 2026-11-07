# src/connector/CLAUDE.md — Connectors

A collection kept in step with a backend of its own through two handlers. The rules of the core are in [src/CLAUDE.md](../CLAUDE.md); what holds for the whole repository is in [CLAUDE.md](../../CLAUDE.md).

## Layout

```
src/connector/connector.js @alexify/syncom/connector — replicate(db, { name, collection, pull, push, live, retryTime, maxRetryTime,
                          batchSize, modifier, resolve }): pulled documents landed as one transaction a page (`source:
                          connector:<name>`), a document that cannot land refused by name, the collection's turns pushed as rows
                          with what the backend was assumed to hold (the canonical text of the backend's shape per id), conflicts
                          the backend wins, rows refused by name parked, the checkpoint `{ pull, pushed }` in the `connector` kv
                          namespace — requires symbols.js, engine.js, shape.js, errors.js, hooks.js, emitter.js, same.js only
src/connector/same.js     canonical, same — the zone's one "the same reading" (keys sorted), kept apart from shape.js's canonical so an
                          adapter weighs nothing of the core — no requires
src/connector/jsonfile.js jsonFile(store, { poll }) — one JSON file as a backend, what the two drives share: `n` the position of a document's
                          newest write, the ETag the compare-and-set (412 read again and tried RETRIES times), a probe for the stream;
                          requester — the fetch with the common headers that throws with the status — requires same.js only
src/connector/couchdb.js  @alexify/syncom/connector/couchdb — couchdb({ url, fetch, headers, longpoll }): the handlers over one CouchDB
                          database through an injected fetch — _changes with the documents, a long poll from the checkpoint as the stream,
                          _bulk_docs with the revisions last seen, a conflict read back, a probe read back, another refusal the row's
                          `{ id, error }`; credentials in the url moved to the Authorization header — no requires
src/connector/graphql.js  @alexify/syncom/connector/graphql — graphql({ url, fetch, headers, request, pull, push, stream }): the application's
                          queries posted and their answers read by its functions; one adapter for every schema — no requires
src/connector/mongodb.js  @alexify/syncom/connector/mongodb — mongodb({ collection, changes, now }): the handlers over one collection of the
                          injected driver — _rev, _deleted, _updated the adapter's fields, a change stream the signal (its error or close
                          END), a server's code on a document the row's `{ id, error }` — no requires
src/connector/supabase.js @alexify/syncom/connector/supabase — supabase({ client, table, primaryKey, modifiedColumn, deletedColumn, schema,
                          channel, stream, now }): the handlers over one table through the injected client — PostgREST with the modified
                          column as the compare-and-set, Realtime's postgres_changes the signal (the channel's error, timeout or close
                          END), a code of the database's on a row the row's `{ id, error }` — no requires
src/connector/firestore.js @alexify/syncom/connector/firestore — firestore({ sdk, database, collection, stampField, deletedField, stream }): the
                          handlers over one collection through the injected modular SDK — the server stamp and a tombstone the adapter's
                          fields, a cursor after the checkpoint, a transaction per 500 rows a push, onSnapshot the signal (its error END),
                          an id or a body the SDK refuses the row's `{ id, error }` — requires same.js only
src/connector/appwrite.js @alexify/syncom/connector/appwrite — appwrite({ client, databases, Query, databaseId, collectionId, deletedField,
                          stream }): the handlers over one collection through the injected SDK — $updatedAt the position, a boolean
                          attribute the tombstone, a read then a write the push, a 400 the row's `{ id, error }`, Realtime the signal —
                          requires same.js only
src/connector/gdrive.js   @alexify/syncom/connector/gdrive — gdrive({ fetch, token, headers, name, fileId, folder, endpoint, poll }): one JSON
                          file of the collection in the user's Drive (the application data folder) through an injected fetch — the v2
                          metadata's ETag, alt=media, the media upload under If-Match — requires jsonfile.js only
src/connector/onedrive.js @alexify/syncom/connector/onedrive — onedrive({ fetch, token, headers, path, drive, endpoint, poll }): one JSON file
                          of the collection in the user's OneDrive through Microsoft Graph — root:/<path> for the eTag, /content, PUT
                          under If-Match — requires jsonfile.js only
```

## Rules

- **A pull is a write of this node; an echo is no write; the backend's state is what a document is judged against.**
  What the backend hands over lands through `db.transact` as `set`/`delete` stamped here — a pulled record reaches
  every peer like a local one, and the backend never sees an op or a meta — under `source: 'connector:<name>'`,
  which the connector's own `transaction` listener passes (never pushed back). A document is judged against
  `#known` (the backend's state as the canonical text of ITS shape, before `modifier.pull`), never against the
  record alone (`#land`, in one `#exclusive` turn with the push so neither judges under the other): the text known
  is an echo (`#assumedText`) — this node's own write come back — and makes no op; over a pending edit it changes
  nothing (the push compares the edit against it), and over a record that reads otherwise with nothing pending it
  lands after all (a landing that never happened); another text over a pending edit is a conflict (`#decide`: the
  backend wins or `resolve`; `#landResolution` in the page's transaction under the `:resolve` actor, the `conflict`
  event after it) — never a silent write over the edit; another text over a record with nothing pending lands
  unless the record reads so already (`same`). Comparing the document with the record instead (as the first
  version did) overwrote an unpushed edit with the backend's older state. `$type` never leaves (`plain`) and is
  laid back on what comes in. A pulled document that is no document (`documentOf`: an id, an object or `deleted`) is
  said (`connector.document.malformed`) and left out, never the page. A document is judged one by one, before
  the transaction and inside it (`#land`): another collection's record (`seam.row(id).type`, a tombstone's too —
  a backend's tombstone never deletes a record of another collection), a sealed one (`row.encrypted`: a connector
  never reads it through the decrypting `get`), a value that is no JSON (`isJson`: a Date or an SDK's class is never
  flattened), a `modifier.pull` that throws, and the engine's own refusal at `tx.set`/`tx.delete` (a validator's,
  a field's) are each `#refuse('pull', id, reason, cause)` — the `refused` event, `connector.document.refused`,
  `stats.refused` — and the rest of the page lands, the checkpoint moving past it. Only a landing that fails WHOLE
  (the engine, the database closing) is the pull's failure (`#failed('pull')`): the checkpoint stays, the page is
  tried again. Never let a throw of one document stop a page, and never let a page's failure move the checkpoint.
- **A push follows the turns and assumes the backend's state.** Every `transaction` event but this connector's own
  pulls hands the records of the collection it changed (the row's type, a purge's `type`; never a sealed one) to
  `#pending`, a Map of id → the log position BEFORE the turn (`#last`, the newest turn heard); one push is in flight
  at a time, `batchSize` rows a call, a row `{ id, data, deleted, assumed }` — `assumed` the backend's state as this
  node last knew it, for a compare-and-set backend. `#known` holds that state per id as the CANONICAL TEXT of the
  backend's shape (`modifier.push` applied; a pulled document before `modifier.pull`), null for nothing held: a row
  whose text equals it has nothing to say and leaves `#pending` without a call (`#rowsOf`) — that is how a resolution
  the backend won, or a turn that leaves the record as the backend holds it, makes no second write. The handler's
  answer is judged row by row (`#answered`): a row not answered is the backend's now (`#learn`); `{ id, error }` is a
  row refused by name — parked (`#park`: out of pending, `#parked`, the `refused` event with the error's code),
  tried again by a turn of the record or `reSync()`; a document is a conflict (`#resolveConflicts`): the backend
  wins — the record set to its state under `source: 'connector:<name>:resolve'` — unless `resolve` says otherwise (a
  `resolve` that throws is `connector.resolve.failed` and the backend wins); the landing is one transaction with a
  try/catch per row (a resolution the engine refuses is `#refuse('push')`, the record stands), the backend's state
  learned and the `conflict` events told AFTER it landed, and the ids stay pending for the next round — equal to the
  backend's state they say nothing, different they go with it assumed. A backend answering a conflict for a row that
  assumed exactly what it holds, twice in a row (`#contradicted`), has the row parked (`reason: 'conflict'`) — never
  a loop at microtask speed (it starved the event loop once). A turn heard while its id is in flight is pending
  again after the push (`#redo`), from that turn's position. Everything after the handler answered — the reads, the
  landing — runs inside one try: a failure keeps every row pending, is `#failed('push')` and tried again; `#flush()`
  never rejects (`.catch(NOOP)` where it is not awaited). `pushed` is a FRONTIER (`#frontier`): before the oldest
  turn still pending, or the newest turn heard (`#last`, never `log.lastEventId` — a position reserved but not yet
  announced would be claimed) where nothing is pending — a restart pushes `log.since(pushed)` (each id pending since
  before its first entry there, `formatId(seq - 1)`) or every record of the collection once where the log cannot
  resume (`connector.rebuild`: each a probe, `#probing`; tombstones not among them). Durably, `#digests` names the
  backend's state per id (DIGEST_LENGTH of the seam's `digest` of the text; `[SOURCE].digest` is `hashText` so the
  connector bundles no hasher), saved with the checkpoint as one kv text `{ pull, pushed, known }` (`#write`), loaded
  into `#digests` alone: a pulled document is judged by digest where the text is not in memory (`#assumedText`), and
  a push of such a record is a PROBE (`#assumedOf` → `assumed: undefined`): the handler answers what the backend
  holds without writing, and `#answered` learns it where the digest names it (or, knowing nothing durably, where the
  backend holds nothing or the row itself) and keeps the id pending for the next round — the row then goes with that
  state assumed or says nothing — or lands a conflict. `#known` is bounded (KNOWN_MAX, the oldest not pending
  forgotten, `#forget`): past it a push probes first. The save is coalesced (`#save`: `#dirty`, one `#saveLoop` in
  flight, SAVE_GAP between writes, `#hurry`/`#flushSave` for at once — the end of a pull run, a push, a stream page,
  `cancel()`); a page's save is not awaited, so the pages of a run coalesce; a crash between a landing and its save
  lands the page again (at least once) and makes an offline edit of that record a conflict. A handler that throws is
  told (`error`, `REPLICATION_FAILED` with `direction` and `retryIn`), kept
  (`errors`, the newest twenty) and tried again after a backoff (`#failed`: `retryTime · 2^n` up to `maxRetryTime`,
  ±25 % jitter, `#attempts` per direction reset by a success); nothing is skipped and no checkpoint moves past it. A
  pull whose checkpoint does not move while it answers full pages is asked `MAX_STALLS` times, then left to the stream.
- **Live is the backend's stream or a timer, never a hook on the peers; one queue lands everything.** The live half
  begins when the first pull run comes through (`#pullRun` → `#follow`, once: `#following`), never before.
  `pull.stream(emit, { checkpoint })` hands pages, `'RESYNC'` or `'END'`: a page is `#enqueue`d on the pull side's
  one queue (`#queue`, `#queued`) behind the runs and pages before it and NEVER moves `checkpoint.pull` — a pull run
  does (`#pullPages`), so a page that fails to land (`#failed('pull')`, a run after the backoff) is pulled again,
  never passed over; `RESYNC` is `#pullAll()`, which runs once more after the run in flight where one is (`#stale`,
  checked in the loop and in the run's `finally` — a RESYNC between the last check and `#pulling = null` was lost
  once); `END` stops following and `#later('pull')` follows again from the checkpoint as it stands (a page stream
  re-reads from there: no gap) and pulls once. With a stream `#safety` pulls every `safetyTime` (0: none); without
  one `#timer` pulls every `retryTime`. The initial replication is `#initialPull && #initialPush`, each set on success
  alone (a run through; a drain without failure). `cancel()` is for good (the stream stopped, the timers cleared,
  the listeners off — `transaction` and the database's `close`, which cancels the connector — the queue's tail and
  the push awaited, what is dirty saved, the waiters rejected); `reSync()` pulls and pushes again. Under `/shared`
  the leader runs the connector (`leader` is the plan's; not here yet). On a mesh, one connector per backend: two
  nodes each pushing what the other pulled make a conflict of every write.
- **An adapter is the two handlers over an injected client, and nothing of the backend's.** No SDK, no HTTP client
  and no protocol of the backend's ships with syncom: an adapter takes `fetch`, the driver's collection or the
  vendor's client as it is given, answers `{ pull, push }` to spread into `replicate()`'s options, and requires nothing
  (`scripts/size.js` holds each under 2 KB). What a compare-and-set needs — the revision or the stamp last seen for a
  document — lives in the adapter's memory for the connector's life: a connector started anew learns it with its
  first pull, a push of a document never seen lands as a new one and is a conflict where one exists. A row with
  `assumed: undefined` is a PROBE: the adapter reads the document and answers it among the refused as the backend
  holds it (a deletion for none), writing nothing. A conflict is answered as the backend holds the document (a
  deletion where it holds nothing), never guessed. A backend whose
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
