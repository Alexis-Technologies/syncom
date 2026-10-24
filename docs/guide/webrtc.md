# WebRTC

syncom has no WebRTC code. A peer-to-peer link is [wrpc's](https://wrpc.vercel.app/guide/webrtc):
its `@alexify/wrpc/webrtc` subpath negotiates the connection, keeps it
alive, redials it and speaks wrpc on a data channel — and what it hands the
application for the far end is an ordinary `WrpcClient`. `createWrpcLink()`
takes that client as it takes one over a WebSocket, and `storage.sync.unit()`
is the same plain object whether a server or a browser peer mounts it. So
a browser node **can host**: its peers dial it the way a dialer dials a hub.

## When

A hub is the simplest topology and stays the fallback: every node dials it,
it relays. Peer-to-peer links take the hot path off the hub — two tabs in
one room exchanging edits at the speed of their own connection, a team on
one LAN, a hub that is down for a minute — while the hub remains the
signaling server, the durable copy and the way in for a peer no one can
reach directly. Scopes and the version vector make the two the same mesh:
an op reaches a node once, whichever links carried it.

## The shape

```js
import { open } from '@alexify/syncom';
import { createWrpcLink } from '@alexify/syncom/wrpc';
import { connect } from '@alexify/wrpc';
import { WrpcPeer, wrpcSignaler, defineRouter } from '@alexify/wrpc/webrtc';

const HUB = 'wss://hub.example.com/api';
const client = await connect(HUB, { headers: { authorization: `Bearer ${token}` } });
let peer = null; // made after open(): its router mounts the storage's unit

const storage = await open({
  path: 'app',
  sync: {
    scope: (id, data) => data.orgId ?? '*',
    // A node's url says where it is: the hub's WebSocket, or a peer id.
    connect: async (node) =>
      createWrpcLink(node.url.startsWith('ws') ? client : (await peer.connect(node.url)).remote),
    // The registry is on disk and may hold peer ids from the last run: dial once `peer` exists.
    autoStart: false,
  },
});

peer = new WrpcPeer({
  router: defineRouter({ syncom: storage.sync.unit({ access: 'session', authorize }) }),
  signaler: wrpcSignaler(client, { identity: () => user.id }),
  iceServers,
});
await peer.start();
if (!storage.sync.listNodes().some((node) => node.url === HUB)) {
  await storage.sync.addNode({ url: HUB, scopes: myOrgIds });
}
await storage.sync.start();
```

`peer.connect(id)` resolves a `PeerLink` whose `remote` is the `WrpcClient`
that calls the other peer's router — reconnecting, resuming subscriptions
from their `lastEventId`, streaming binary, exactly what syncom asks of a
link. It is idempotent while the link lives, so `connect(node)` may be
called again for the same peer.

The hub's branch hands every dial the one `client` the signaler speaks over.
Closing a link closes its client, so `removeNode()` or `enableNode(url,
false)` on the hub's node, or `sync.stop()`, closes that WebSocket —
signaling with it — and a later dial would get the closed client back. Where
the hub's node may be switched off and on, have `connect(node)` open a
client of its own for it.

## Hosting in a browser

A `WrpcPeer` holds a `PeerHost`: a router, a dispatcher and one `Client` per
attached peer, with no sessions, cluster or HTTP. Under its default
`trust: 'link'` every client gets a frozen pseudo-session — the link only
exists because the signaling server admitted the peer — and that is what
`authorize` reads:

```js
const authorize = (context, hello) =>
  context.session?.data?.peer === hello.node && hello.scopes.every((scope) => myOrgIds.includes(scope));
```

`context.session.data.peer` is the link's peer id — never what the peer said
about itself. With `trust: 'assertion'` the signaling server signs a token
per peer, bound to the certificate it dials with, and the verified claims are
`context.session.data.claims` (see
[WebRTC: identity and trust](https://wrpc.vercel.app/guide/webrtc-trust)) —
the place to hold an `op.actor` to a `claims.sub`, in `beforeApply`. With
`trust: 'none'` there is no session, and a unit with the default
`access: 'session'` answers 403 before `hello` runs. `hello.token` is not
needed over a peer link; `hello.schema` arrives as over any link.

## Signaling on the hub

The hub mounts wrpc's signaling unit next to syncom's; one server does both:

```js
const { createSignalingUnit, createSignalingHooks } = require('@alexify/wrpc/webrtc');

const router = defineRouter(
  {
    ...createSignalingUnit({
      identity: (context) => context.session.data.userId,
      authorize: (context, info) => info.action !== 'join' || orgsOf(context).includes(info.room.slice(4)),
    }),
    syncom: storage.sync.unit({ access: 'session', authorize, limits: { opsPerPush: 500, opsPerSecond: 2000 } }),
  },
  { hooks: createSignalingHooks() },
);
```

A browser signals through `wrpcSignaler(client, { identity })` over the same
WebSocket it syncs with the hub on.

## A mesh of a room

`peer.join(room)` links a peer with everyone in a signaling room as they come
and go. One syncom link per pair is enough — the dialer pushes, the host's
`changes` feed carries the rest — and wrpc already decides who dials: the
peer with the lower id is the initiator. Use the same rule, so both sides
agree without a word:

```js
const attach = async (id, orgId) => {
  if (storage.sync.listNodes().some((node) => node.url === id)) {
    await storage.sync.enableNode(id, false); // the edge came back: a fresh link
    await storage.sync.enableNode(id, true);
  } else await storage.sync.addNode({ url: id, scopes: [orgId] });
};

for (const orgId of myOrgIds) {
  const mesh = peer.join(`org:${orgId}`);
  mesh.on('join', ({ id }) => peer.id < id && attach(id, orgId));
  mesh.on('leave', ({ id }) => storage.sync.removeNode(id).catch(() => {}));
}
```

Presence — who is editing what — is ephemeral and belongs next to the
documents, not in them: `mesh.broadcast('presence/state', …)` in a room, or
`context.server.to('presence:' + docId).except(context.client).emit(…)` on
the hub.

## Reconnect and close

Nothing here is syncom's: the engine maps two link events, and wrpc's
`PeerLink` fires them as a `WrpcClient` does.

| On the link | What syncom sees | What it does |
| --- | --- | --- |
| A redial succeeds (ICE restart, a new `RTCPeerConnection`) | `reconnect`, after wrpc restored the subscription from its `lastEventId` | Repeats `hello` + `push`; the host's client is new, so the restored subscription answers 428 and the manager greets first — the ordinary path |
| The link gave up, or the other side said goodbye or refused | `close` | `peer { connected: false }`; nothing is redialled — in a mesh wrpc dials the edge again and `join` fires |
| `removeNode(id)` / `enableNode(id, false)` | — | `link.close()`: **a goodbye to the whole link**, both directions; the other side's `leave`/`close` fires |

## Without signaling: a raw data channel

An application that negotiated an `RTCDataChannel` itself — next to its
media channels, say — hands it to wrpc and nothing else changes. This is the
level the test suite runs over a fake channel pair:

```js
// Node: the channel's far end on an ordinary server, next to its WebSocket clients
const { attachChannel } = require('@alexify/wrpc/webrtc');
attachChannel(server.rpc, channel, { peer: 'browser-7' }); // no session: the unit is access 'public', or authorize checks `context.meta`

// Browser: the channel's near end as a syncom link
import '@alexify/wrpc/webrtc';
const link = createWrpcLink(await connect('webrtc:hub', { transport: 'webrtc', channel, reconnect: false }));

// Browser hosting over a raw channel: a PeerHost on the host half
import { PeerHost, RtcPeerTransport } from '@alexify/wrpc/webrtc';
const host = new PeerHost({ router: defineRouter({ syncom: storage.sync.unit({ access: 'session', authorize }) }) });
host.attach(new RtcPeerTransport(channel, { peer: 'other' }), { peer: 'other' });
```

A static channel is one connection — when it closes, the link is down. To
plug your own recovery into wrpc's reconnect cycle, pass a **factory** as
`channel`: every (re)open asks it for the next channel, the subscription
resumes with its `lastEventId`, and syncom greets again — the second
scenario of `tests/wrpc.integration.test.js`.

## Limits

Three layers, each its own: `unit({ limits })` bounds what a peer pushes
(413/429 — [Hosting](./sync#hosting)), a `PeerHost`'s `maxCalls`,
`maxSubscriptions` and `maxStreams` bound the wire, and a wrpc `onRequest`
hook on the peer's router reads `unit({ meta })` for anything above.

## What it does not give

- **Receive-side backpressure.** A data channel has no `pause()`; a
  streamed bootstrap page is bounded by `pageBytes`, keep it so.
- **Sessions.** `trust: 'link'` trusts the relay's word; an assertion is the
  server's signed word at issue time; neither is revocable but by closing
  the link.
- **The worker proxy.** `WrpcClientProxy` connects to a URL; a data channel
  cannot be reached through it (see [Scaling](./scaling#several-tabs)).

## Bundle

syncom does not grow: the peer imports `@alexify/wrpc/webrtc`, syncom keeps
`createWrpcLink`. `@alexify/wrpc` is a devDependency of this package for
its integration tests and nothing else.
