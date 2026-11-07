# src/sync/CLAUDE.md — Replication

The dialing side and the host: scopes, the feed's cursor, failed pages, reconnects, the registry. The rules of the core — the op model, the write paths, own keys, the log — are in [src/CLAUDE.md](../CLAUDE.md); what holds for the whole repository is in [CLAUDE.md](../../CLAUDE.md).

## Layout

```
src/sync/sync.js          @alexify/syncom/sync — the sync plugin: `open(ctx)` after the replay hands the core its SyncManager
src/sync/manager.js       SyncManager — the dialing side; `unit()` delegates to hosting.js
src/sync/registry.js      NodeRegistry — the dialed nodes on disk (remote/<url>.json), saves coalesced per node — no requires
src/sync/hosting.js       createUnit — the hosting side: hello/push/snapshot/changes, limits, grant()
src/sync/protocol.js      PROTOCOL, DEFAULT_PAGE_SIZE, schemaOf, kindsOf — what both halves of the sync protocol agree on — no requires
src/sync/wire.js          packOps / unpackOps and the type codes — the ops as they cross between peers; the core's ops.js re-exports
                          them — no requires
src/sync/link.js          isSyncLink — the link contract check; the root barrel and the wrpc adapter take it from here — no requires
src/sync/outbound.js      outbound(log, { exclude, vector, scopes, own }) — the ops a receiver lacks, the first retained seq per own
                          stream; a push and a branch merge both pick with it — requires scope.js, vector.js only
src/sync/shared-log.js    isSharedLog — the shared-log contract (wrpc BrokerLog shape: append/read/parseId); the root barrel exports it — no requires
src/sync/shared.js        SharedHub — the hubs' shared log (`sync.sharedLog`): the relay (what this hub accepts → the topic, a batch an
                          entry), the consumer (the topic and the inbox → applyRemote; a read-only hub shadows the vector), the marker a
                          snapshot is positioned at, a read-only hub's forwarded push; normalizeShared, parseEntry — requires wire.js,
                          protocol.js, shared-log.js, vector.js, shape.js, errors.js, hooks.js only
```

## Rules

- **Scopes are enforced by the host.** `unit().push` drops out-of-scope ops
  before `applyRemote` (`refused` event, `syncom.ops.rejected{scope}`);
  `snapshot`/`changes` serve `grant(asked, granted)` — a page for every scope reads no record's
  scope, and a scope function that throws on a record leaves that record out of the page
  (`snapshot.skipped`, `reason: 'scope'`), never the page. The scope an op declares
  is the peer's word: `push` also passes the grant as `bound`, and
  `applyRemote` refuses an op whose RECORD — before the op and after it, as
  this node's `sync.scope` reads it — is outside it (`outOfScope`, not logged,
  not relayed: a gap, like a forged op; relaying it as skipped would hand the
  write to every peer of the declared scope). A local op takes the scope of
  the record as it leaves it (`scopeData` in `src/commit.js`, re-read after
  validation), never of a `set`'s delta alone. `applyRemote`'s `scopes`
  option only gates `advance` adoption, and adoption needs
  `adoptFrom === op.origin` — the host a feed is read from. Never adopt on the
  push path.
- **`via` is a descriptor, never the link.** `peer.ref` (`{ url, node }`,
  `node` filled by hello) is what `change`, `apply` and the apply hooks get
  on the dialing side; the host's is `state.ref` (`url` null). `#fanOut`
  compares `peer.ref === via`. Never hand the peer object, the link or the
  wrpc client out of `SyncManager`: they carry the token and the socket.
- **A failed page is a break in the stream.** `#receive` runs pages one after
  another per peer (`peer.inbound`), numbered by `peer.feed`; a rejection goes
  to `#pageFailed`, which closes the feed (pages of the old feed are dropped),
  reports `PAGE_FAILED` with the saved cursor, and resubscribes from it —
  `STUCK` after `MAX_PAGE_RETRIES`. Never move `node.cursor` past a page that
  did not land, and never catch inside `#receive` to "keep going".
- **A hosted feed's cursor moves to a real entry, never to `lastEventId`.**
  `changes` in `src/sync/hosting.js` reads through `OpLog.read`, whose `last` is
  the seq of the last entry examined (in scope or not); when a wake brings
  nothing for the peer, the cursor moves there without a page. `lastEventId`
  is `next - 1` and runs ahead of the entries while an append is in flight —
  a feed that jumped there lost the batch in flight (it was tried). The one empty page a feed sends is the
  IDLE page — `{ ops: [], eventId, idle: true }`, labelled with that cursor (`<epoch>.0` when nothing was read),
  once per lull, before the wait — which is the dialer's `caughtUp` (`awaitInSync`); a feed over a shared log
  sends it after `IDLE_AFTER` ms of nothing. A page that failed on the dialer bumps `peer.feed` at once
  (`#pageFailed`), stuck or not, so an idle page queued behind it never moves the cursor past it.
- **The shared log is a bus, never a second log.** What a hub appends to the topic (src/sync/shared.js) is what its
  own log already holds — every op it accepted, per `#fanOut`, except what came FROM the topic (`via.shared`) — and
  what it applies from the topic goes through `applyRemote` like a push (`via`/`peer` the appending hub, `bound`
  the inbox entry's scopes, never `adoptFrom`). The topic's ids are the positions a client resumes by, so a hub
  over a shared log answers `epoch: shared:<topic>` at hello, serves `changes` from the topic alone (one page per
  entry, labelled with the entry's id — never split: a resume would skip the rest), tells a subscription with no
  cursor to bootstrap, and positions a snapshot's first page at a marker it appended (`mark()`: the tick's batch
  flushed first and the marker chained behind every append, refused `behind` while the relay is) and its consumer
  PASSED — the consumer applies every entry before the marker first, so nothing lands between the pages and the
  cursor — with the vector its reads reflect (`#relayed`: moved by every op offered, never `log.vector`, whose
  reserved positions are not on any page; `vector()` answers it at hello too). A read-only hub
  (`storage.readOnly`: a follower, a lost lease) applies nothing and relays nothing: it shadows the vector from
  the topic read whole (`vector()`), answers it at hello, holds a push to it and forwards the page to the inbox —
  the shadow moved only once the append landed, so a failed forward is pushed again — serves no snapshot (403
  `READ_ONLY`: the shadow runs ahead of its engine, a page could lack what the vector claims; a fresh client
  bootstraps from a hub that writes) and stops reading the inbox (the next writer takes it from the saved cursor,
  which only a writer saves). The relay's WATERMARK (`#appendedSeq`, saved as `appended`) is the last log position every
  op at or below which is in the topic: every op is offered with its position (the `change` event's `seq`), a batch
  that landed covers its positions (`#cover`), an op read from the topic covers its own, and the watermark moves
  only over a contiguous run of them (`#advance`) — never to `lastEventId`, which runs ahead of ops still landing
  (a batch that failed behind one that landed was lost that way). A failure is told once and recovered from
  (`SHARED_LOG_FAILED`, `reason`): the relay falls `behind` and re-appends `log.since(watermark)` — every start
  does the same, so a stop with ops waiting loses none — and moves the watermark to the last of them (`#reached`;
  duplicates in the topic are every consumer's to drop); a watermark the log compacted past is told once (`lost`)
  and moved to the floor, what the log retains going to the topic; `stop()` waits `stopWait` for an append in
  flight, then lets go of it; a cursor gone reads from the oldest; a hole the log yields (`value: null` — a number
  whose entry never came) is told (`hole`) and passed, `stats().holes` counting; an entry that will not apply three
  times leaves its topic `stuck` — never skipped, a skipped entry is a gap for good. A writer trims the inbox past
  its cursor every `INBOX_TRIM_EVERY` entries passed (`log.trimBefore`, where the log has it): what it landed is no
  one else's to read, and a second writer over the same inbox reads what it missed from the topic. The loops begin a turn after `start()` (setImmediate), so a listener
  attached right after the open hears the first read's failure. A read's 410/400 means the position is not the
  log's — the codes wrpc's brokers and `mongoSharedLog` answer; a log of another shape must answer them too.
- **A rule never withholds an op; it scrubs it.** `beforeSend` on the dialer (`#outgoing`, a copy of the op) and
  `authorizeWrite` on the host (`refused` in src/apply.js, before `beforeApply`) both end in `scrubOp`: the header
  with `scrubbed: true` (slot 20) goes on — logged skipped and scrubbed, relayed, applied nowhere — so no stream has
  a gap. The host names what it refused in the push's answer (`refused`, with the record as it holds it) and the
  dialer sets itself straight (`#refused`: `set` to the host's record with `actor: 'revert'`, `forget` where the
  host holds nothing; a revert refused is reported, never reverted again — `entryOf` tells one by its actor).
  `prove`: a `require` host (or `unit({ prove: true })`) hands a `challenge` at hello and refuses push, snapshot and
  changes (403 `UNPROVEN`) until `syncom/prove` carries its signature under the peer's key — `[1, 'prove',
challenge, host, node]`, both ids bound in — which the dialer answers before it pushes (`#prove`; no signing
  plugin: `UNPROVEN` reported, nothing pushed). `sync.revoke(node, scopes)` lives on the manager, never on the unit
  (a function on the unit would be a procedure on the wire): the sessions a unit greeted are the manager's Map by
  node (`remember`), a revoke narrows their grant, counts their `generation` up (a feed of an older generation
  ends at its next wake; one opened after serves the new grant) and tells the client through `server.sendTo`;
  hello narrows what a revoked node asks for and answers `revoked`. The dialer narrows its registry entry, reports
  `REVOKED`, runs `onRevoke` or forgets the records of those scopes (`storage.forget`: the file and the row gone,
  the log's entries scrubbed and flagged skipped — never an op, the host would refuse it) and subscribes again (a
  feed's end never takes a newer handle off the peer: `#subscribe` compares). `query`/`count` are opt-in
  (`unit({ query: true })`), read through `storage[CURSOR]` as it is — never a sealed record, which is the key
  holder's (SEC-7) — narrow the rows by the host's scope function and cap them by `limits.rowsPerQuery` — a thin
  client's door, never a write's. Over a stateless transport (plain HTTP: one
  request, one wrpc client) no hello can come first, so a read may carry one — `args.hello`, run through `greet`
  with `keep` false (`greeted`): the state set on the client for the call, no room joined, no session remembered, no
  presence handed — and a host without `query` mounts no such procedure (wrpc answers Not Found, never
  `QUERY_DISABLED`).
- **Reconnect/backoff/resume belong to the link.** `SyncManager` re-runs only
  `hello` + `push` on `reconnect`; a refused restored subscription (428 "say
  hello first" — wrpc gives a reconnect a NEW server-side client) triggers a
  fresh handshake, at most `MAX_REHELLOS` in a row. Do not add a reconnect
  loop or a timer to syncom: a failed push marks the peer `behind` and
  `#recover` pushes from the vector at the next sign of life on the link (a
  page in `#receive`, an op in `#fanOut`) or on `sync()`, backed off by a
  timestamp. Every push goes through `#serializePush` — never call
  `#sendPages` from a new place.
