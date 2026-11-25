---
title: The sync protocol
description: "What two nodes say to each other: hello, the push by vector, the feed and its cursor, failed pages, reconnects, snapshots, and how a host admits a batch."
---

# The sync protocol

The laptop comes back online after an afternoon of edits. In the next second it has to learn what the
server holds, send the server what it lacks, receive what it missed, and then keep both directions
flowing until the connection drops again, when it must pick up exactly where it stopped. This page
follows that conversation step by step, as a developer sees it through events. The bytes of each
message, the refusal codes and the bounds are in [Wire format](../reference/wire#the-procedures).

The examples run over the in-process link of `@alexify/syncom/testing`, which behaves like a wrpc
client at the boundary but needs no network:

<<< @/examples/sync-protocol.mjs#setup

Every node can play both roles. The node that opens the connection **dials** and the other **hosts**;
on a given link that is the only difference.

## Say hello

The dialer's first call is `hello`. It says who it is (its node id), which protocol version it speaks,
what it has (its whole [version vector](./operation-log#what-a-node-has-seen-version-vectors)), which
[scopes](./partial-sync) it asks for, the token it registered, its [schema](./schema) version and hash,
and the field kinds it runs (the plugins such as `text` and `tree`). The host checks the hello and
answers with the same about itself, plus its log's epoch.

<<< @/examples/sync-protocol.mjs#events

<FigHandshake />

The host refuses a hello in a few cases, each with a code the dialer reports through its `error`
event and keeps as `peers()[i].lastError`: another protocol version (400), the host's own node id,
which means a copied data directory (409), a node id that is not a signing key on a host that requires
signatures (403), and `authorize` saying no (403). A refused hello is tried again when the link
reconnects. What the host grants is the scopes the dialer asked for, less any it [revoked](./partial-sync)
from that node; those scopes bound everything the peer reads and writes on this link.

The answer can carry two more things. A host that runs `unit({ prove: true })` adds a random
challenge, and the dialer signs it with its key before anything else happens (see [Hosting a
node](./server#ask-peers-to-prove-their-key)). A host that holds more of the dialer's own stream than
the dialer does adds a proof, which is how a node restored from a backup notices (see
[Retention](./retention#restore-a-node-from-a-backup)). When both sides run the same schema version with
different hashes, each database emits a `schema` event of kind `drift` and the link stays up; a
different version is not drift, it is what each op's `v` is for.

## Push what the host lacks

Right after hello, the dialer compares its log with the host's vector and pushes every op above it, in
pages of `sync.pageSize` ops (500 by default). That includes the dialer's own writes and the ops it
received from its other peers, which is how an op crosses a mesh hop by hop.

<<< @/examples/sync-protocol.mjs#dial

The host answers each page with the vector keys the page moved and what it made of the ops: how many
it applied, skipped, found duplicate or out of order, and refused. The dialer merges those keys into
the host's vector, so the next push starts from the right place. Pushes to one peer never overlap: a
handshake, a relay, a `sync()` call and a recovery take turns, so each push starts from the newest
answer.

A push that fails, or that the host refuses with a limit (413, 429), marks the peer `behind`. The
dialer does not retry on a timer: it pushes from the host's vector again at the next sign of life on
the link (a page received from the host, an op to relay) or on `sync()`, with a backoff of one second
doubling to a minute after a recovery that failed.

## Follow the host's feed

The inbound half is a subscription to the host's `changes` procedure, opened from the cursor the
dialer saved for that host. The host replays its log from there and then keeps the feed open: every
op that lands on the host goes out as it lands, in the scopes granted, less the subscriber's own ops
and the ones that came from it. Each page is labelled with the host's log position, an event id
(`<epoch>.<seq>`), which the dialer saves as its cursor once the page has landed.

When the feed has nothing more to send, the host sends one empty page marked idle. That is the
dialer's `caughtUp`, and it is what `awaitInSync()` waits for, together with an empty outbox:

<<< @/examples/sync-protocol.mjs#peers

A feed for one scope still reads every entry of the host's log once: when an entry is for another
scope, the cursor moves past it without a page, so a client of a small scope never rereads a busy
hub's other traffic.

## When a page does not land

A page that cannot be applied, because a `beforeApply` hook threw or the log append failed, is a break
in the stream, not a page to step over. The dialer drops the pages behind it, closes the feed, reports
`ALX_ERR_PAGE_FAILED` with the saved `cursor` and the `attempt`, and subscribes again from that cursor, so the
page comes again. The third failure in a row leaves the peer **stuck** (`ALX_ERR_STUCK`, `peers()[i].stuck`):
nothing past that page is taken until you fix the cause and call `enableNode(url, false)` and then
`enableNode(url, true)`. The cursor never moves past a page that did not land.

<FigResume />

One problem stays local to one op instead of the page: an op whose record file this node cannot read
is skipped and reported as `ALX_ERR_OP_UNREADABLE`, and the rest of the page lands.

## Pick up after a reconnect

Reconnecting is the link's job, and wrpc already does it: it backs off, reconnects, and reopens the
subscription from the last event id it delivered, so the feed replays exactly what was missed. syncom
runs no reconnect loop or timer of its own. What a transport cannot know is the outbound half, so
after a reconnect the dialer only repeats hello and the push:

<<< @/examples/sync-protocol.mjs#resume

<LiveReplication />

wrpc gives a reconnected client a new server-side identity, so the reopened subscription can reach
the host before the new hello does; the host answers it with 428 ("say hello first") and the dialer
greets again. A host that answers 428 to five fresh hellos in a row is reported once as
`ALX_ERR_HANDSHAKE_LOOP` and not greeted again until the link reconnects. Timeouts on a call are the link's
too: give the wrpc client a `timeout`.

## Join from a snapshot

A cursor cannot always be resumed. The host may have compacted its log past it ([retention](./retention)
moved its floor), or the cursor may come from another epoch (a host that was reinstalled, a hub of
another log). A brand-new node has no cursor at all, which works as long as the host still holds its
whole log. When the host cannot resume a feed, it tells the dialer to bootstrap instead:

<<< @/examples/sync-protocol.mjs#bootstrap

The dialer pages through the host's `snapshot` procedure: every record of the granted scopes in id
order, tombstones included, each with the metadata that makes it merge. On a transport that carries
binary streams a page comes as NDJSON with backpressure. The dialer joins each page as one batch,
where every record becomes a `merge` op of its own, adopts the host's vector as of the first page, and
subscribes again from that page's event id; anything that landed while it paged replays and folds in
as a no-op.

<FigBootstrap />

The joined state enters the dialer's own log as `merge` and `advance` ops, so a third node that syncs
from the dialer gets it too: a bootstrap is transitive. Those ops run in the dialer's `@~` stream and
never travel back to the node the snapshot came from. A `beforeBootstrap` hook can refuse a bootstrap,
and the dialer refuses one by itself from a host that runs fewer field kinds than it does
(`ALX_ERR_KINDS_MISMATCH`), since that host's snapshot would lack those fields. A record the dialer keeps
[encrypted](./encryption) is left as it is, and a record with a stamp past the skew bound is left
out.

## How a host admits a peer's batch

Whether a batch arrives as a push on a host or as a feed page on a dialer, the receiving node runs it
through the same gate before anything is written. In order:

1. **Limits and scopes of the push** (on a host): a page over `limits` is refused whole; an op that
   declares a scope the peer was not granted is refused alone.
2. **Shape**: every field the node reads has its type and length, and nothing nests deeper than 80
   levels.
3. **Signature**: a signed op is verified against its origin; under `signatures: 'require'` an unsigned
   op is refused too.
4. **Stamp**: a stamp beyond `sync.maxSkew` ahead of this node's clock is refused (`ALX_ERR_SKEW`).
5. **Order**: an op this node already has is a duplicate, one that skips ahead is a gap.
6. **Chain**: an op that forks its writer's stream is refused (`ALX_ERR_EQUIVOCATION`).
7. **The record's scope** (on a host): an op that would write a record outside the peer's scopes,
   before or after the op, is refused, and logged as a withheld scrub.
8. **Rules**: the host's `authorizeWrite`, then your `beforeApply` hook.
9. **Apply**: the op merges into the record by the field's kind, and the validator checks the result.
10. **Persist, then relay**: the batch is appended to the log, the records are written, and the ops go
    on to this node's other peers.

<FigAdmission />

The difference between the two ways an op can stop matters. An op refused at steps 1 to 6 is neither
logged nor relayed, and the vector does not move: it is a gap in its stream, and the stream waits until
the op comes again intact. An op declined at step 7, 8 or 9 (the record is outside the pusher's scopes, a
rule refuses it, the validator fails, a field's kind holds it) is still logged and relayed as a no-op, so
that the nodes behind this one do not see a hole in the writer's stream. A refusal at step 7 or by
`authorizeWrite` goes on as a withheld scrub, the header alone, which applies nowhere, not even as a
purge, and the pusher is told (`ALX_ERR_WRITE_REFUSED`). A host checks, and every node decides by its own rules.

## Sync without the plugin

The protocol's two halves are also plain functions of the core, for a transport of your own or a test.
`outbound()` picks the ops a receiver lacks by its vector, as a push does, and `applyRemote()` runs a
batch through the gate above:

<<< @/examples/sync-protocol.mjs#by-hand

What the `sync` plugin adds on top is the rest of this page: the registry of nodes, hello, the push
pages and the feed, snapshots, recovery and hosting.

## Trade-offs

The protocol never asks the two sides to agree on anything but ops, so it needs no locks, no server
round trip per write and no conflict step. In exchange, a node holds a full replica of its scopes, a
host relays every op it accepts to every peer that needs it, and a node that was away longer than the
host's retention pays for a whole snapshot of its scopes. Delivery is at least once: an op can arrive
twice, through two paths, and applying it again changes nothing. The guarantees and bounds are listed
in [Wire format](../reference/wire#guarantees-and-limits).

## Coming from RxDB

RxDB's replication protocol pulls documents changed since a checkpoint and pushes each write with the
state the client assumed the server had, so the server can detect a conflict and send back its own
state for the client's conflict handler. syncom pushes ops by vector and follows a feed by cursor; the
ops merge on every node by the same rules, so there is no assumed state to send and no conflict to
resolve in the protocol. RxDB's `reSync()` corresponds to `sync()`, and its checkpoint to the cursor
plus the vector.
