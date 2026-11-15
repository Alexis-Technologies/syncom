---
title: WebRTC P2P
description: Sync browsers directly over wrpc's WebRTC links, with signaling on your hub, a browser node that hosts, and a mesh of everyone in a room.
---

# WebRTC P2P

Choose peer-to-peer links when browsers should exchange edits directly: two people editing one board see
each other's changes at the speed of their own connection, a team on one network keeps working while the
internet is down, and the hub carries less traffic. The hub stays in the picture as the signaling server
that introduces the peers, the durable copy of the data, and the way in for a peer that nobody can reach
directly. [Scopes](./partial-sync) and version vectors make hub links and peer links one mesh: each node
applies an op once, whichever links carried it.

syncom has no WebRTC code. The peer connection is [wrpc's](https://wrpc.vercel.app/guide/webrtc): it
negotiates the connection, keeps it alive, redials it, and hands you an ordinary `WrpcClient` for the
other peer, which `createWrpcLink()` takes as it takes one over a WebSocket. Because the sync unit is the
same plain object wherever it is mounted, a browser node can **host**: other peers dial it the way a node
dials a server.

The browser code on this page follows wrpc's WebRTC API and needs `RTCPeerConnection`, so the docs' test
suite only checks that it parses. The hub's code runs in Node.js as shown, and the repository's
integration tests run syncom over wrpc's WebRTC transport on a stand-in data channel.

<div class="sc-steps">

### Signal and sync on the hub

The hub mounts wrpc's signaling unit next to syncom's, on one server. Browsers use the same WebSocket to
find each other and to sync with the hub:

<<< @/examples/replication-webrtc-hub.mjs#hub

### Open the database in the browser

The database's `connect` function now has two kinds of nodes to dial: the hub, by its WebSocket url, and
other peers, by their peer id. The peer object is created after the database, because its router mounts
the database's unit, so start the sync manager by hand once both exist:

<<< @/examples/replication-webrtc.mjs#peer

### Decide which peers may sync with you

A browser that hosts admits peers with `authorize`, like a server does. Under wrpc's default trust mode,
every peer link carries a session naming the peer id the hub admitted, which the peer cannot forge:

<<< @/examples/replication-webrtc.mjs#authorize

With the [signing](./signing) plugin on every peer, `unit({ prove: true })` also makes each peer prove it
holds the key that is its node id before it can push or read.

### Start the peer and dial the hub

<<< @/examples/replication-webrtc.mjs#start

`peer.connect(id)` resolves to a link whose `remote` is the `WrpcClient` for the other peer. It reconnects,
resumes subscriptions and streams binary data, which is all syncom needs from a link, and calling it again
for the same peer returns the live link.

### Link with everyone in a room

`peer.join(room)` links this peer with every member of a signaling room as they come and go. Register each
member as a node when it joins:

<<< @/examples/replication-webrtc.mjs#room

One syncom link per pair is enough: the side that dials pushes, and the host's feed carries the rest back.
Using wrpc's rule (the lower peer id dials) means both sides agree without a word.

</div>

## Reconnects and closed links

Nothing here is syncom's own. When wrpc redials a link (an ICE restart, a new peer connection), the link
announces `reconnect` after wrpc has restored the subscription, and syncom says hello again and pushes what
the peer lacks. When wrpc gives up on a link, or the other side closes it, syncom sees `close`, emits `peer`
with `connected: false` and dials nothing; in a room, wrpc dials the edge again and `join` fires, which is
what `attach` above handles. `removeNode(id)` or `enableNode(id, false)` closes the whole link, both
directions, and the other side sees it leave.

The hub's node is different: the hub's branch of `connect` hands every dial the one `client` the signaler
also uses, so closing that link (with `removeNode()`, `enableNode(HUB, false)` or `sync.stop()`) closes the
signaling WebSocket too. If the hub's node may be switched off and on, open a client of its own for it.

## Use a data channel you negotiated yourself

An app that already negotiates an `RTCDataChannel`, next to its audio and video, can hand that channel to
wrpc and skip the signaling unit:

<<< @/examples/replication-webrtc.mjs#raw-channel

A channel passed as a value is one connection: when it closes, the link is down. To recover, pass a
function as `channel`: wrpc calls it for every (re)open, resumes the subscription from its last position,
and syncom greets again.

## Presence among peers

Who is looking at which task travels as [presence](./presence), not as ops. Over the hub,
`db.sync.presence(instance)` carries it; among peers, send the instance's updates over the room yourself
and feed what arrives to `presence.apply()`, as [Presence](./presence#carry-presence-over-a-transport-of-your-own)
shows.

## Limits

Three layers bound what a peer can do. The unit's `limits` bound what a peer pushes (413 for a page too
large, 429 for a peer too fast), the same as on a server. A `PeerHost`'s `maxCalls`, `maxSubscriptions`
and `maxStreams` bound the wire. A wrpc `onRequest` hook on the peer's router can read the unit's `meta`
for any policy above that.

## Limitations

- **No backpressure on the receiving side.** A data channel cannot be paused, so keep the unit's
  `pageBytes` (4 MiB) as the bound on a streamed snapshot page.
- **Trust is the hub's word.** Under `trust: 'link'` a peer is who the hub said it was; with
  `trust: 'assertion'` the hub signs a token per peer, bound to its connection's certificate
  ([wrpc: identity and trust](https://wrpc.vercel.app/guide/webrtc-trust)). Neither can be revoked except by
  closing the link. With `trust: 'none'` there is no session, and a unit with `access: 'session'` refuses
  every call.
- **Not through a worker proxy.** A data channel cannot be reached through wrpc's worker proxy, so the
  tab that runs the database runs the peer.
- **A hub is still needed.** Peers find each other through signaling, and a peer that is offline when
  the others write catches up from whoever holds the ops, usually the hub.

## Coming from RxDB

RxDB's WebRTC plugin replicates a collection between the peers of a topic, through simple-peer and a
signaling server (or Nostr relays), validates peers with `isPeerValid()`, and resolves conflicts with the
collection's handler. In syncom the WebRTC link is wrpc's, each peer is a full node that can host, one link
carries every collection, scopes decide what each peer may read and write, and the hub that signals is a
syncom node that keeps the durable copy. RxDB's Nostr signaling needs no server of your own, which syncom
does not offer.

<FromRxdb page="replication-webrtc" :rows="['webrtc', 'signaling', 'p2pRoom', 'ice', 'peerValidation', 'browserHosts']" />
