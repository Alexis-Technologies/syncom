# src/sync/CLAUDE.md — Replication

The dialing side and the host: scopes, the feed's cursor, failed pages, reconnects, the registry. The rules of the core — the op model, the write paths, own keys, the log — are in [src/CLAUDE.md](../CLAUDE.md); what holds for the whole repository is in [CLAUDE.md](../../CLAUDE.md).

## Layout

```
src/sync/sync.js          @alexify/syncom/sync — the sync plugin: `open(ctx)` after the replay hands the core its SyncManager
src/sync/manager.js       SyncManager — the dialing side; `unit()` delegates to hosting.js
src/sync/registry.js      NodeRegistry — the dialed nodes on disk (remote/<url>.json), saves coalesced per node — no requires
src/sync/uploads.js       UploadQueue — the attachments each dialed node waits for the bytes of, on disk (`uploads.json` of the root
                          kv: `[digest, id, name]` per node, oldest first, MAX_UPLOADS a node), saves coalesced — requires blobs.js only
src/sync/hosting.js       createUnit — the hosting side: hello/greet, push and the bytes a push names (blobPut), snapshot, the two feeds
                          (changes, sharedChanges), the presence event and the unit itself; the rules and the reads below
src/sync/rules.js         what the procedures stand on: a refusal on the wire (coded, refuse, refuseCall), the peer of a call (peerOf: greeted,
                          proven under `prove`), the refusals told (announceRefused, refuseOps), the unit's options (normalizeAllow,
                          normalizeLimits), the push limits (limit), the scopes a read covers (grant), the proof of the key (challengeOf,
                          prove — the message protocol.js's), the sessions a revoke reaches (remember, joinRooms, handPresence) — requires
                          hooks.js, protocol.js, scope.js, symbols.js only
src/sync/reads.js         the thin client's reads: query/count (normalizeQuery, the $regex gate regexRefusal, cursorOf, the scoped walk
                          walkScoped, greeted/ungreet for a hello carried by the call) and blob (blobNamed: served by the record that names
                          it; blobPut's door too; namedBlobs: the registers an op's data names — what a dialer uploads and a forwarding
                          hub waits for) — requires rules.js, protocol.js, safe-regex.js, scope.js, shape.js, symbols.js, pem.js,
                          chunks.js, blobs.js only
src/sync/chunks.js        a blob's bytes over a link's stream: streams (a host's client that carries binary streams), sendAll (the
                          transport's own writeAll, wrpc ≥ 2.1, then the end) and collect (the pieces read to the size announced, no
                          further) — both halves use both — no requires
src/sync/protocol.js      PROTOCOL, DEFAULT_PAGE_SIZE, ATTACHMENTS_FIELD, schemaOf, kindsOf, proveMessage — what both halves of the sync protocol
                          agree on — no requires
src/sync/wire.js          packOps / unpackOps and the type codes — the ops as they cross between peers; the core's ops.js re-exports
                          them — no requires
src/sync/link.js          isSyncLink — the link contract check; the root barrel and the wrpc adapter take it from here — no requires
src/sync/outbound.js      outbound(log, { exclude, vector, scopes, own }) — the ops a receiver lacks, the first retained seq per own
                          stream; a push and a branch merge both pick with it — requires scope.js, vector.js only
src/sync/shared-log.js    isSharedLog — the shared-log contract (wrpc BrokerLog shape: append/read/parseId); the root barrel exports it — no requires
src/sync/shared.js        SharedHub — the hubs' shared log (`sync.sharedLog`): the relay (what this hub accepts → the topic, a batch an
                          entry), the consumer (the topic and the inbox → applyRemote; a read-only hub shadows the vector), the marker a
                          snapshot is positioned at, a read-only hub's forwarded push, what its pages named (expect/expects) and the
                          bytes a follower kept (landed → the inbox); normalizeShared, parseEntry — requires wire.js,
                          protocol.js, shared-log.js, vector.js, shape.js, errors.js, hooks.js only
```

## Rules

- **Scopes are enforced by the host.** `unit().push` drops an op that declares a scope not granted
  before `applyRemote` (`refused` event, `syncom.ops.rejected{scope}`: a stream the peer may not write here);
  `snapshot`/`changes` serve `grant(asked, granted)` — no list asked is the grant; an empty list asks for no scope,
  whatever the grant: the global records alone (a peer that asked for no scope, or whose last scope a revoke took,
  asks with an empty list and stays subscribed; 403 `SCOPES` only where named scopes none of which is granted, and
  an empty list was once refused so, which left such a peer terminal) — a page for every scope reads no record's
  scope, and a scope function that throws on a record leaves that record out of the page
  (`snapshot.skipped`, `reason: 'scope'`), never the page. The scope an op declares
  is the peer's word: `push` also passes the grant as `bound`, and
  `applyRemote` refuses an op whose RECORD — before the op and after it, as
  this node's `sync.scope` reads it — is outside it (`outOfScope`): logged and relayed as a withheld scrub
  (`refuse` in src/apply.js, as a rule's refusal is — the header alone, applied nowhere, a purge included), so its
  stream goes on, and named in the answer's `refused` with `reason: 'scope'` and NO `current` — the record is one
  the pusher may not read; the dialer reports it (`WRITE_REFUSED`) and reverts nothing. Relaying it with its payload
  would hand the write to every peer of the declared scope. A local op takes the scope of
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
  did not land, and never catch inside `#receive` to "keep going". A peer the host refused for good — a 403 on the
  feed or the bootstrap, a handshake loop, a stuck feed, a kinds mismatch — is `terminal` (`#terminal`): not waited
  for by the awaits (`#peerOf` answers null, as for a failed dial, and `#settle()` runs so a waiter is told) until a
  hello succeeds again; a dial that fails settles the waiters too.
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
  entry, labelled with the entry's id — never split: a resume would skip the rest; through `SharedHub.read()`: the
  consumer's one read of the log serves every feed from the ring of the entries it passed last, `RING`, woken as it
  passes — a feed whose cursor is behind the ring, ahead of the consumer or on a stopped hub reads the log its own
  way until an entry the ring holds comes by), tells a subscription with no
  cursor to bootstrap, and positions a snapshot's first page at a marker it appended (`mark()`: the tick's batch
  flushed first and the marker chained behind every append, refused `behind` while the relay is) and its consumer
  PASSED — the consumer applies every entry before the marker first, so nothing lands between the pages and the
  cursor — with the vector its reads reflect (`#relayed`: moved by every op offered, never `log.vector`, whose
  reserved positions are not on any page; `vector()` answers it at hello too). A read-only hub
  (`storage.readOnly`: a follower, a lost lease) applies nothing and relays nothing: it shadows the vector from
  the topic read whole (`vector()`), answers it at hello, verifies a push as a writer would (the seam's `checkOps`:
  forged and unsigned ops stop there, counted and announced), holds it to the shadow AND to what it forwarded before
  (`#forwarded`, by stream key, `FORWARD_TTL`) and forwards the page to the inbox — the shadow moves on topic
  entries alone (`#shadowAdvance`, which lets a hold go as it passes it), never on a forward, so a writer's refusal
  is never acked for good — serves no snapshot (403
  `READ_ONLY`: the shadow runs ahead of its engine, a page could lack what the vector claims; a fresh client
  bootstraps from a hub that writes) and stops reading the inbox (the next writer takes it from the saved cursor,
  which only a writer saves). The writer rules the inbox as it rules a push — `#apply` passes the manager's
  `authorizeWrite` (`sync.authorizeWrite`, every unit's default) as `authorize`, a refusal — the rule's, or a record out of the client's scopes — logged as a withheld
  scrub and relayed — tells each kind of refusal (`refused`, `via: 'inbox'`), and names what it did not take at all (not in
  its vector after the apply: a gap, an equivocation, forged) in a `dropped` topic entry (`#judged`), which a follower
  reads to let its holds go (`#release`). The relay's WATERMARK (`#appendedSeq`, saved as `appended`) is the last log position every
  op at or below which is in the topic: every op is offered with its position (the `change` event's `seq`), a batch
  that landed covers its positions (`#cover`), an op read from the topic covers its own, and the watermark moves
  only over a contiguous run of them (`#advance`) — never to `lastEventId`, which runs ahead of ops still landing
  (a batch that failed behind one that landed was lost that way). A failure is told once and recovered from
  (`SHARED_LOG_FAILED`, `reason`): the relay falls `behind` and re-appends `log.since(watermark)` — every start
  does the same, so a stop with ops waiting loses none — and moves the watermark to the last of them (`#reached`;
  duplicates in the topic are every consumer's to drop); a watermark the log compacted past is told once (`lost`)
  and moved to the floor, what the log retains going to the topic; `stop()` waits `stopWait` for an append in
  flight, then lets go of it; a cursor gone reads from the oldest; a hole the log yields (`value: null` — a number
  whose entry never came) is told (`hole`) and passed, `stats().holes` counting; an entry the engine refuses (the
  medium down, a lease late, the log's group refused) is tried again, backed off to `MAX_BACKOFF`, told once per run
  (`apply`, `stats().retrying`), until it lands, and one a rule refuses (`HOOK_FAILED`, a `TypeError`) three times
  leaves its topic `stuck` — never skipped, a skipped entry is a gap for good. A writer trims the inbox past
  its cursor every `INBOX_TRIM_EVERY` entries passed (`log.trimBefore`, where the log has it): what it landed is no
  one else's to read, and a second writer over the same inbox reads what it missed from the topic. The loops begin a turn after `start()` (setImmediate), so a listener
  attached right after the open hears the first read's failure. A read's 410/400 means the position is not the
  log's — the codes wrpc's brokers and `mongoSharedLog` answer; a log of another shape must answer them too.
- **A rule never withholds an op; it scrubs it.** `beforeSend` on the dialer (`#outgoing`, a copy of the op) and
  `authorizeWrite` on the host (`refused` in src/apply.js, before `beforeApply`; the manager's rule — `sync.authorizeWrite`
  — is every unit's unless it names its own, and the writer's over the inbox) both end in `withholdOp` (src/header.js):
  the header with `scrubbed: true` and `withheld: true` (slot 20 `2`) goes on — logged skipped and scrubbed,
  relayed, applied nowhere, a PURGE INCLUDED, where a purge's own scrub (slot 20 `1`) still purges where it lands —
  so no stream has a gap and a refused purge purges nothing behind the host. The host names what it refused in the
  push's answer (`refused`, `reason: 'rule'` with the record as it holds it; `'scope'` without it) and the
  dialer sets itself straight (`#refused`: the fields the op touched — `touchedBy`: a set's keys, an unset's names,
  a kind's op's `key`, the whole record for a write, a delete, a merge or an op the log compacted — brought to the
  host's through the seam's `revert(id, current, fields, { actor: 'revert', kinds })`, which diffs the reading by kind
  (`diffViews`: a counter by an inc, a set by adds and removes, a text by its splices) so what the host accepted
  since stands — `kinds`, the refusal's, says which of the host's fields are no registers (`refuse` in
  src/apply.js: a reading does not tell a counter's sum from a number), and a field of another kind here is unset
  and made again as the host's: left a counter over the host's register, or a register over its set, it would take
  none of what the host's kind makes next; `forget` where the host holds nothing; a revert refused is
  reported, never reverted again — the answer's `actor` tells one, the log compacted or not; a purge refused is
  reported alone). A sealed record at the host is skipped before the rule is asked: a sealed entry has no meta an op
  could be tried over.
  `prove`: a `require` host (or `unit({ prove: true })`) hands a `challenge` at hello and refuses push, blobPut, snapshot,
  changes, query, count and blob (403 `UNPROVEN`) until `syncom/prove` carries its signature under the peer's key —
  `[1, 'prove', challenge, host, node]`, both ids bound in — which the dialer answers before it pushes (`#prove`; no
  signing plugin: `UNPROVEN` reported, nothing pushed); the rooms are joined and the presence handed at the proof,
  not at hello (`joinRooms`, `state.keep`), and an unproven presence update is `PRESENCE_UNPROVEN`. `blob` serves a
  digest under `allow.blob` `'named'` (the default) only where a live record in the peer's scopes names it under the
  name the call gives (`blobNamed`: the catalog's row, the seam's `load`, `ATTACHMENTS_FIELD` of protocol.js, the
  scope function) — one 404 for every miss, so nothing is told — and by digest alone under `'any'`. `blobPut` takes
  bytes through the same door (404 `NOT_NAMED`; `allow.push`, a blobs store, `limits.bytesPerBlob` and
  the cap, the digest hashed over the bytes) and hands what it kept to `landed` — the manager uploads it on to the
  hosts that wait for it (`#blobLanded`); the dialer uploads what a page the host took names after the page, on the
  push chain (`#noteUploads`, `#upload`), never as a push of its own. A hub that cannot write is one of two, and
  the seam says which (`storage[SOURCE].blobStore()`: the engine's own store, undefined where it keeps none, NULL
  once the lease was lost — never `storage.readOnly`, which is true of both): a FOLLOWER takes the bytes into the
  engine's store — the one its writer reads, a blob content-addressed and outside every write set, no lock, no op —
  through the same door, which opens only once it HEARS the record (the engine's change stream), so a blob is
  written only where the writer holds the record naming it; a register it forwarded for the peer is 425 `NOT_YET`
  until then (`SharedHub.expect`/`expects`: the host's key `<digest>/<id>/<name>` by the node that pushed it,
  `FORWARD_TTL` long, `MAX_EXPECTED` a node, in memory — to that node and no other, every other miss the one 404;
  thrown through `coded`, never `refuseCall`: no refusal, neither logged nor counted), and what it kept it tells the
  writer through the inbox (`SharedHub.landed`, the `{ v, node, landed }` entry → `manager.adoptBlob` →
  `#blobLanded`: a writer that dials relayed the register before the bytes were in its store). A hub whose LEASE
  WAS LOST writes nothing more and refuses for good (403 `READ_ONLY`, final at the dialer — never 503, which the
  dialer tried again at every push for ever). The dialer notes a forwarded page like any other; 425 leaves the entry
  and reports nothing (`peer.deferred`), and the host's next IDLE page asks again (`#receive`, on the push chain) —
  which is why `sharedChanges` resets `idle` on the peer's own op: the lull after an echo is told, though the echo
  makes no page. No timer and no count on the dialer: the wait is the host's to end. What waits is the NODE's, not the peer's, and
  on disk (src/sync/uploads.js: `uploads.json` of the root kv, written when an entry is noted and when one goes —
  uploaded, refused for good, past `MAX_UPLOADS`, its node removed — coalesced, never awaited by a push, a failed
  write logged): `peer.uploads` is the node's Map, so a peer dialed again — a reconnect, a restart — takes up what
  the one before left, at its hello's push, empty or not (`#serializePush` stays the one door). Not a field of the
  registry entry: that file is rewritten at every page received, and a relay holds a thousand of these for long.
  `waiting` (this node lacks the bytes) is derived, never stored: `store.has` says it at the first pass after an
  open, `#blobLanded` clears it on every node's entry — a link that is down takes the bytes up at its next push — and
  an entry named again is looked at again (`note`). A blob's bytes cross as BYTES, IN PIECES, where
  the transport carries a stream (src/sync/chunks.js over wrpc's binary streams — nothing of a transport is written
  here; the pieces, the pacing and the stop are wrpc's, 2.1 or later): a download is the host's `client.createStream`
  written through the writable's own `writeAll` (`sendAll`: 64 KiB pieces, each as the transport takes it, false once
  the transport closed or the reader let go), and an upload the link's `createStream` — announced, then the `blobPut`
  call naming it (`stream`, `size`), then the pieces (`#streamUp`) — which the probe's answer allows (`stream: true`:
  a persistent, binary connection — `streams(client)`); an empty blob is a stream of no bytes like any other. The
  reader takes the size announced and no further (`collect`: a sender that sends more is stopped there, never held),
  and the host lets go of the stream whatever it answers (`terminate()` in a `finally`), which wrpc tells the dialer:
  its writer stops, so a refusal or bytes the host holds already leave the rest unsent — syncom keeps no stop of its
  own. Base64 in the call is what remains where no stream goes (a text-only transport — SSE — a `MemoryLink` without
  `streams`). One message of the whole blob — the base64 call, or the download as one chunk — was what a transport's
  message limit refused (16 MiB on wrpc's uWebSockets.js engine, under permessage-deflate and over WebTransport and
  WebRTC; a blob may be 64 MiB) and what nothing paced. A `beforeSend`
  rules a hosted page too (`manager.sendable(ops, ref)` in `changes` and `sharedChanges`), never a snapshot page or
  a query row (records: the scopes'). An op flagged `scrubbed` that carries a payload is scrubbed before it is
  logged (`applyOne`): the flag is the peer's word, the payload goes all the same. `sync.revoke(node, scopes)` lives on the manager, never on the unit
  (a function on the unit would be a procedure on the wire): the sessions a unit greeted are the manager's Map by
  node (`remember`; a session goes with its client's `close` — wrpc hands a reconnect a new client, so one outlived
  by its socket would stay for good — `sync.sessions()` lists them), a revoke narrows their grant, counts their
  `generation` up (a feed of an older generation ends at its next wake; one opened after serves the new grant) and
  tells the client through `server.sendTo`; hello narrows what a revoked node asks for and answers `revoked`. The
  revocations are durable — `revoked.json` of the root kv (`#loadRevoked`/`#saveRevoked`, coalesced; a read-only hub
  saves none) — and shared: a writer over a shared log appends `{ v, node, revoke }` to the topic (`SharedHub.revoke`),
  every hub folds it (`manager.adoptRevocation`: never appended again, `revoke` event `via: 'shared'`). The dialer narrows its registry entry, reports
  `REVOKED`, runs `onRevoke` or forgets the records of those scopes (`storage.forget`: the file and the row gone,
  the deferred slot settled with them — a flush after would lay the record back — and the log's entries scrubbed and
  flagged skipped in the same turn of the queue; never an op, the host would refuse it) and subscribes again (a
  feed's end never takes a newer handle off the peer: `#subscribe` compares). `query`/`count` are opt-in
  (`unit({ query: true | { regex } })`), read through `storage[CURSOR]` as it is — never a sealed record, which is
  the key holder's (SEC-7) — refuse a `$regex` from the wire unless the unit takes them (`regexRefusal`: 400 `REGEX`;
  `'safe'` runs `safeRegex` of src/query/safe-regex.js over every pattern, down every branch), and for a scoped peer
  walk the cursor (`walkScoped`: `stream` by `SCOPED_BATCH`, the catalog's row asked once more, the scope function
  per row) until the window is full or `limits.rowsPerQuery` rows were READ — `capped` in the answer where the
  budget ended it; a peer granted everything is answered `rowsPerQuery` rows at most; `Infinity` is kept as such in
  `normalizeLimits`, never deleted — a thin client's door, never a write's. Over a stateless transport (plain HTTP: one
  request, one wrpc client) no hello can come first, so a read may carry one — `args.hello`, run through `greet`
  with `keep` false (`greeted`, `ephemeral`): the state set on the client for the call and taken off it after
  (`ungreet`) — a persistent socket greeted by a read holds no state a session knows of, so its next push or
  subscription is 428 — no room joined, no session remembered, no presence handed — and a host without `query`
  mounts no such procedure (wrpc answers Not Found, never `QUERY_DISABLED`).
- **Reconnect/backoff/resume belong to the link.** `SyncManager` re-runs only
  `hello` + `push` on `reconnect`; a refused restored subscription (428 "say
  hello first" — wrpc gives a reconnect a NEW server-side client) triggers a
  fresh handshake, at most `MAX_REHELLOS` in a row. Do not add a reconnect
  loop or a timer to syncom: a failed push marks the peer `behind` and
  `#recover` pushes from the vector at the next sign of life on the link (a
  page in `#receive`, an op in `#fanOut`) or on `sync()`, backed off by a
  timestamp. Every push goes through `#serializePush` — never call
  `#sendPages` from a new place.
