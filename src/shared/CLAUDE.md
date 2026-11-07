# src/shared/CLAUDE.md — Several instances over one database

One leads, the others follow and write through it. The rules of the core are in [src/CLAUDE.md](../CLAUDE.md); what holds for the whole repository is in [CLAUDE.md](../../CLAUDE.md).

## Layout

```
src/shared/shared.js      @alexify/syncom/shared — openShared({ createDatabase, ...options, channel, election, grace, failover }) → Shared: the
                          facade over the current instance (the leader's Database, or a follower's read-only one), the writers forwarded, the
                          recorded transaction, live things made again at a failover, serve() — requires emitter.js, errors.js, hooks.js,
                          election.js, channel.js only
src/shared/election.js    elect({ name, locks, channel, follower, heartbeat, misses }) — Web Locks, or a heartbeat over a BroadcastChannel, a
                          follower that never leads, or alone; re-armable: onLead at every grant, yield(), request() — no requires
src/shared/channel.js     the follower's channel to the leader: describe/revive (wire-error.js's packError/unpackError), answerOf, unwrap,
                          callLeader — requires errors.js, wire-error.js only
```

## Rules

- **A follower is a read-only database, nothing else.** `openShared` opens a follower with `createDatabase({ ...options,
readOnly: true })` — `sync` and `lock` left out: a follower neither dials nor hosts nor holds the lock — over the
  same engine, which must be `shared`; its reads, its collections' queries and a live Document's `update` are the
  database's own, fed by the engine's change stream (`db.changes`: the IndexedDB engine's BroadcastChannel, the memory
  engine's listeners, MongoDB's change stream). A follower raises no `transaction` event, so the facade has no
  `observe()` — a thing that would silently hear nothing is not offered. Nothing of the core is required here:
  `createDatabase` is an option, as `/branch` opens through the parent's constructor and `scripts/size.js` measures a
  block alone.
- **Every write of a follower is the leader's write, answered as the leader answers it — once.** The facade's
  writers (`MUTATORS`, one per writer of the database's API) run on the leader's `Database` where this instance
  leads and are carried over the channel — `{ call(method, payload) }`, the payload a CALL `{ id: '<token>:<n>',
args, retry }` (`callOf`), the token the election's — otherwise; the leader's `serve()` answers every call as a
  VALUE, `{ ok: true, value }` or `{ ok: false, error: describe(error) }`, never a thrown error, so a refusal
  round-trips over any wire (`revive`: a SyncomError with its code and fields, a TypeError with its data code). The
  forward is at-least-once and deduplicated by id: the leader keeps the answers (`ANSWERS_KEPT` per token,
  `TOKENS_KEPT` tokens, in memory, one `serve()`'s) and answers a call tried again from what it kept, in flight or
  done; a `retry` it never saw is `CALL_UNKNOWN`, never run, which the follower turns into `LEADER_LOST
{ maybeApplied: true }`. A call that rejected may have reached the leader (`sent`, unless the transport says
  `sent: false`); a dial that failed, a `NOT_LEADER`, `LEADER_LOST` or `CLOSED` answer marks nothing sent. Every
  such failure drops the channel and tries again — `channel()` dialed anew, one dial for every write waiting —
  while a leader comes within `failover` ms, this instance's own where the election made it so meanwhile; past it,
  `LEADER_LOST` with the cause and `maybeApplied`. A follower's `transact(fn)` is RECORDED: `fn` runs here against a recorder
  (`TX_WRITERS` note the call and answer at once; `get`/`has` read this instance), the batch goes as one `transact`
  call and runs in one transaction there — `insert` is refused on the recorder (its id would be the leader's). The
  leader validates every name of a recorded batch against `TX_WRITERS` and the transaction's api. Three procedures
  stand beside the writers (`PROCEDURES` = `MUTATORS` + `transact` + them; `[CALL]` runs them here on the leader,
  forwards them else): `collection` (`[name, method, args]`, `method` one of `COLLECTION_WRITERS` — the list of
  src/collection.js, kept here so nothing of the core is bundled, the two held equal by tests/shared.test.js;
  `insert`/`upsert`/`insertIfAbsent` answer the id, a bulk its verdicts with the errors `describe`d), `local`
  (`[method, [key, value]]`, `set`/`delete` by the full key; `set(key, fn)` refused) and `fetchBlob` (`[digest, id,
name]` → `db.sync.fetchBlob`, the bytes landing in the shared store, `{ length }` answered). `SharedCollection`,
  `SharedAttachments` and `SharedLocal` are the facade's: readers the current instance's, writers through `[CALL]`
  or `[WRITE]`, the same answer on either role; `SharedAttachments.put` writes the blob into the engine's blobs
  store through a raw handle of the engine (`[RAW_BLOBS]`, lazily, closed with the facade: a follower's database
  refuses the write, a blob is content-addressed and outside the write set) and forwards the register
  (`Attachments.prepare` makes both).
- **A promotion opens the leader beside the follower, then swaps.** Granted the lock, the instance opens the
  database as the leader (the follower holds no lock, so both stand; `LOCKED` — the old leader still letting go —
  is tried LOCKED_RETRIES times), checks the election still names it (two heartbeat leaders settling: the writer
  goes), moves `#db` to it, counts `generation` up, makes every live thing again (`live`, `document`), says
  `leader`, and only then closes the follower: `shared.db` is never null. A leader that lost the election (the
  heartbeat's two-leaders rule, a lock stolen) opens a follower and swaps the other way — after a promotion in
  flight, never under it. The leadership waiters resolve at the promotion and reject `CLOSED` at `close()`. An
  elected instance that cannot open says `PROMOTE_FAILED` on `error` (`attempt`, `cause`), YIELDS the election so
  the next in line leads, and asks again after `min(LOCKED_STEP · 2^attempt, MAX_BACKOFF)` ms — it never holds a
  lock it cannot use. `[START]` is honest the same way: a first open that fails releases the election and throws
  (`openShared` never resolves with `db === null`); a follower on a fresh path waits for the elected instance's
  identity (READ_ONLY tried again every step, `LEADER_LOST` `fresh` past `failover`); `close()` stops the live
  things, rejects the waiters, closes the channel, waits for a promotion in flight, closes the database and
  releases the election LAST, so the next leader never meets this one's database lock.
- **The election is Web Locks first, and re-armable.** `navigator.locks.request('syncom:leader:<path>', { mode:
'exclusive' })` — a name apart from the database's own `syncom:<path>` lock, which the leader's `createDatabase`
  takes — resolves when granted and lets go with the tab. The heartbeat (a BroadcastChannel-shaped `channel`) is
  for platforms without locks: claim, lead, bye (a claim round: the smallest token leads at the next beat), the
  smaller token stays; its two leaders at once are settled by the database's lock, never by writes racing. Either
  way `onLead` fires at EVERY grant (never a one-shot promise), `yield()` steps aside and `request()` asks again;
  a lock stolen (`AbortError`) is `onLost`. `follower: true` never leads (`mode: 'follower'`: a tab beside a
  SharedWorker that holds the election). Neither given: `mode: 'alone'`, the instance leads at once.
- **The wire is wrpc's, and the worker leads.** `createSharedChannel(client)` of the wrpc subpath is the follower's
  channel; the leader's `serve()` is a router unit (`syncom-db`, `PROCEDURES`); a SharedWorker attaches each tab's
  port on its `wrpc:connect` (`rpc.attachPort(event.ports[0])`) — the handshake of wrpc's worker transport, run in
  `tests/wrpc.integration.test.js` over a `MessageChannel`. In a browser the SharedWorker holds the election and
  serves, and every tab is `election: { follower: true }` (`mode: 'follower'`, never a leader): nothing crosses a
  realm but the wrpc calls, no tab's `serve()` is reached from another — the shape `tests/shared.test.js` runs over
  the in-process port. Followers open only over a `shared` engine (memory, IndexedDB, MongoDB): never the files
  engine or SQLite, whose journal and connection are one instance's. No port, BroadcastChannel or IPC client of
  syncom's own.
