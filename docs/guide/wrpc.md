# wrpc transport

[wrpc](https://wrpc.vercel.app) is the transport syncom is built to run on:
WebSocket RPC with subscriptions that resume, reconnection with backoff, rooms
and binary streams — everything the [sync protocol](./sync#protocol) leaves to
the link. The adapter lives in the `@alexify/syncom/wrpc` subpath and takes a
`WrpcClient` you construct; syncom never imports wrpc, so its dependency count
stays at zero and wrpc stays on your version.

```bash
npm install @alexify/syncom @alexify/wrpc
```

(syncom is not on npm yet — see [Installation](./getting-started#installation).)

## Hosting a node

`storage.sync.unit()` returns a plain object of procedures shaped for
`defineRouter`. Mount it under `syncom`:

```js
const { Server, defineRouter } = require('@alexify/wrpc');
const { open } = require('@alexify/syncom');

const storage = await open({ path: 'data' });

const router = defineRouter({
  syncom: storage.sync.unit({
    access: 'public',
    authorize: (context, hello) => hello.token === process.env.SYNC_TOKEN,
  }),
});

const server = new Server({ router, host: '0.0.0.0', port: 8000, protocol: 'http' });
await server.listen();
```

`access` defaults to wrpc's own default, `'session'`, which refuses every peer
until one has a session. Either open it with `'public'` and gate with
`authorize`, or keep sessions and sign peers in through wrpc's
[`authenticate`](https://wrpc.vercel.app/guide/client#authenticating) hook —
`context.session` is available inside `authorize` too.

## Dialing a node

```js
const { WrpcClient } = require('@alexify/wrpc');
const { open } = require('@alexify/syncom');
const { createWrpcLink } = require('@alexify/syncom/wrpc');

const storage = await open({
  path: 'data',
  sync: {
    connect: async (node) => createWrpcLink(await WrpcClient.connect(node.url)),
  },
});

await storage.sync.addNode({ url: 'ws://hub.example.com:8000/api', token: process.env.SYNC_TOKEN });
```

The registry is kept on disk, so a node is added once: on the next start it
is dialled from there, and a second `addNode()` of its url is `NODE_EXISTS`.
`connect(node)` is called once per registered node and again whenever the node
is re-enabled, so every dial gets a fresh client. Keep wrpc's `reconnect` and
`heartbeat` defaults: reconnecting is the client's job, and after it the
subscription resumes from its `lastEventId` by itself — syncom only repeats
its handshake to push what it wrote while offline.

A node can be both. The same storage can mount its unit on a server **and**
dial other nodes; that is what makes a [mesh](./sync#protocol).

## In the browser

The subpath has no Node.js code, so the same two imports work in a bundle:

```js
import { open } from '@alexify/syncom';
import { createWrpcLink } from '@alexify/syncom/wrpc';
import { WrpcClient } from '@alexify/wrpc';

const storage = await open({
  path: 'app',
  sync: { connect: async (node) => createWrpcLink(await WrpcClient.connect(node.url)) },
});
await storage.sync.addNode({ url: 'wss://hub.example.com/api', token });
```

A browser node dials the nodes it can reach, and a bootstrap arrives as a
binary stream through wrpc's `WrpcReadable`. It hosts too: over a WebRTC
link its unit sits on a wrpc `PeerHost`, and a peer's `PeerLink.remote` is
a `WrpcClient` this adapter takes as it is — see [WebRTC](./webrtc).

## What the adapter does

`createWrpcLink(client, { unit })` feeds `client.use()` the unit's four
procedures once, with no round trip, and returns:

- `call('syncom/x', args)` → `client.call('syncom/x', args)` — no `load()`
  needed.
- `subscribe('syncom/changes', …)` →
  `client.api.syncom.changes.subscribe(args, { lastEventId, … })`, the handle
  wrpc resumes. wrpc updates the handle's `lastEventId` from each packet
  before it delivers the value, and the adapter passes that id along with it.
- `stream(id)` → `client.getStream(id)`, the async-iterable `WrpcReadable` a
  streamed snapshot page arrives on.
- `open` / `close` / `reconnect` events and `close()` are the client's own —
  so `removeNode()`, `enableNode(url, false)` and `sync.stop()` close the
  client.
- `client`: the client it wraps.

`unit` renames the router unit when you mounted it under something other than
`syncom`. `isSyncLink()` is exported too, and `SYNC_INTROSPECTION` if you want
to scaffold the unit yourself.

## Tracing across the wire

The adapter adds nothing for tracing, and needs nothing: give wrpc's `Server`
and `WrpcClient` their `telemetry` option and syncom its own, and a write on
the dialing node, its `syncom/push` call, the handler on the host and the
`syncom.apply` inside it are one trace — wrpc carries the context per packet,
syncom's spans nest under whatever is active. See
[OpenTelemetry](./telemetry).

## Rooms and presence

On `hello` the host joins the peer to `syncom:<scope>` for every scope it asked
for, so wrpc's rooms and [cluster](https://wrpc.vercel.app/guide/cluster)
describe the sync topology for free:

```js
server.rooms.count('syncom:*');                            // peers here that take every scope
await server.cluster.fetchClients({ room: 'syncom:Doc' }); // peers of Doc, across instances
server.cluster.disconnect({ room: 'syncom:Doc' });         // drop them
```

A peer registered with `scopes: ['Doc']` joins `syncom:Doc` alone — not
`syncom:*`, though it receives the global records too.

Delivery does **not** go through rooms: a room broadcast is at-most-once and
cannot be resumed, which is exactly what the subscription provides.

## Why no codec

wrpc's [wire codec](https://wrpc.vercel.app/guide/codec) is a connection-wide,
text-only setting your application owns. syncom's ops already travel
[packed](./sync#on-the-wire) (one positional array per op, no repeated
keys), permessage-deflate compresses the rest, and the storage is JSON on
both ends — there is no binary representation to preserve. Set a codec if
your application wants one; syncom neither needs nor notices it.

## Testing

The pattern from wrpc's own [testing guide](https://wrpc.vercel.app/guide/testing)
applies unchanged — `port: 0`, `logger: false`, teardown registered with
`t.after` the moment the server is up. syncom's
`tests/wrpc.integration.test.js` boots two servers and a dialer that way and
is skipped, never failed, when `@alexify/wrpc` is not installed.
