# src/shared/CLAUDE.md — Several instances over one database

One leads, the others follow and write through it. The rules of the core are in [src/CLAUDE.md](../CLAUDE.md); what holds for the whole repository is in [CLAUDE.md](../../CLAUDE.md).

## Layout

```
src/shared/shared.js      @alexify/syncom/shared — openShared({ createDatabase, ...options, channel, election, grace, failover }) → Shared: the
                          facade over the current instance (the leader's Database, or a follower's read-only one), the writers forwarded, the
                          recorded transaction, live things made again at a failover, serve() — requires emitter.js, errors.js, hooks.js,
                          election.js, channel.js only
src/shared/election.js    elect({ name, locks, channel, heartbeat, misses }) — Web Locks, or a heartbeat over a BroadcastChannel, or alone — no requires
src/shared/channel.js     the follower's channel to the leader: describe/revive an error across JSON, answerOf, unwrap, callLeader — requires errors.js only
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
- **Every write of a follower is the leader's write, answered as the leader answers it.** The facade's writers
  (`MUTATORS`, one per writer of the database's API) run on the leader's `Database` where this instance leads and are
  carried over the channel — `{ call(method, args) }` — otherwise; the leader's `serve()` answers every call as a
  VALUE, `{ ok: true, value }` or `{ ok: false, error: describe(error) }`, never a thrown error, so a refusal
  round-trips over any wire (`revive`: a SyncomError with its code and fields, a TypeError with its data code). A
  transport failure, a `NOT_LEADER` or a `LEADER_LOST` answer drops the channel and tries again — `channel()` dialed
  anew — while a leader comes within `failover` ms, this instance's own where the election made it so meanwhile;
  past it, `LEADER_LOST` with the cause. A follower's `transact(fn)` is RECORDED: `fn` runs here against a recorder
  (`TX_WRITERS` note the call and answer at once; `get`/`has` read this instance), the batch goes as one `transact`
  call and runs in one transaction there — `insert` is refused on the recorder (its id would be the leader's). The
  leader validates every name of a recorded batch against `TX_WRITERS` and the transaction's api.
- **A promotion opens the leader beside the follower, then swaps.** Granted the lock, the instance opens the
  database as the leader (the follower holds no lock, so both stand; `LOCKED` — the old leader still letting go —
  is tried LOCKED_RETRIES times), moves `#db` to it, counts `generation` up, makes every live thing again
  (`live`, `document`), says `leader`, and only then closes the follower: `shared.db` is never null. A leader that
  yields (the heartbeat's two-leaders rule) opens a follower and swaps the other way. The leadership waiters resolve
  at the promotion and reject `CLOSED` at `close()`. An elected instance that cannot open says `LEADER_LOST` on
  `error` and stays a follower.
- **The election is Web Locks first.** `navigator.locks.request('syncom:leader:<path>', { mode: 'exclusive' })` —
  a name apart from the database's own `syncom:<path>` lock, which the leader's `createDatabase` takes — resolves
  when granted and lets go with the tab. The heartbeat (a BroadcastChannel-shaped `channel`) is for platforms
  without locks: claim, lead, bye, the smaller token stays; its two leaders at once are settled by the database's
  lock, never by writes racing. Neither given: `mode: 'alone'`, the instance leads at once.
- **The wire is wrpc's.** `createSharedChannel(client)` of the wrpc subpath is the follower's channel; the leader's
  `serve()` is a router unit (`syncom-db`); a SharedWorker attaches each tab's port on its `wrpc:connect`
  (`rpc.attachPort(event.ports[0])`) — the handshake of wrpc's worker transport, run in
  `tests/wrpc.integration.test.js` over a `MessageChannel`. No port, BroadcastChannel or IPC client of syncom's own.
