# src/sync/CLAUDE.md — Replication

The dialing side and the host: scopes, the feed's cursor, failed pages, reconnects, the registry. The rules of the core — the op model, the write paths, own keys, the log — are in [src/CLAUDE.md](../CLAUDE.md); what holds for the whole repository is in [CLAUDE.md](../../CLAUDE.md).

## Layout

```
src/sync/sync.js          @alexify/syncom/sync — the sync plugin: `open(ctx)` after the replay hands the core its SyncManager
src/sync/manager.js       SyncManager — the dialing side; `unit()` delegates to hosting.js
src/sync/registry.js      NodeRegistry — the dialed nodes on disk (remote/<url>.json), saves coalesced per node — no requires
src/sync/hosting.js       createUnit — the hosting side: hello/push/snapshot/changes, limits, grant()
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
  a feed that jumped there lost the batch in flight (it was tried).
- **Reconnect/backoff/resume belong to the link.** `SyncManager` re-runs only
  `hello` + `push` on `reconnect`; a refused restored subscription (428 "say
  hello first" — wrpc gives a reconnect a NEW server-side client) triggers a
  fresh handshake, at most `MAX_REHELLOS` in a row. Do not add a reconnect
  loop or a timer to syncom: a failed push marks the peer `behind` and
  `#recover` pushes from the vector at the next sign of life on the link (a
  page in `#receive`, an op in `#fanOut`) or on `sync()`, backed off by a
  timestamp. Every push goes through `#serializePush` — never call
  `#sendPages` from a new place.
