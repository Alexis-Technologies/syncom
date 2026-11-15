---
title: WebSocket
description: Replicate over wrpc on a WebSocket. Dial with createWrpcLink, let wrpc reconnect and resume, fall back to Server-Sent Events, and read from scripts over HTTP.
---

# WebSocket

[wrpc](https://wrpc.vercel.app) is the transport syncom is built to run on: WebSocket RPC with
subscriptions that resume, reconnection with backoff, rooms and binary streams, everything the sync
protocol leaves to the link. Use it for every node that dials a server, in Node.js and in the browser.
syncom never imports wrpc: the adapter in `@alexify/syncom/wrpc` takes a `WrpcClient` you create, so
syncom keeps zero dependencies and you choose the wrpc version.

<div class="sc-steps">

### Install both packages

```bash
npm install @alexify/syncom @alexify/wrpc
```

### Mount the unit on a wrpc server

The server is a syncom node with its unit on a wrpc router ([syncom server replication](./replication-server)
covers authorization and write rules). One wrpc `Server` serves the WebSocket, Server-Sent Events and plain
HTTP on the same port:

<<< @/examples/replication-websocket.mjs#host

### Dial it with a wrpc client

Give the database a `connect` function that opens a `WrpcClient` for the node's url and wraps it with
`createWrpcLink()`:

<<< @/examples/replication-websocket.mjs#link

`connect` is called once per registered node, and again whenever the node is enabled after being
disabled, so every dial gets a fresh client. When the link closes (`removeNode()`, `enableNode(url, false)`
or `sync.stop()`), the client is closed with it.

</div>

## Let wrpc reconnect and resume

Reconnecting is the client's job, not syncom's. When the connection drops, the wrpc client retries with
backoff and, once it is back, reopens the feed's subscription from the last position it delivered. syncom
adds only what a transport cannot know: it says hello again and pushes what the node wrote meanwhile.
Here the server restarts for a deploy while the laptop keeps writing:

<<< @/examples/replication-websocket.mjs#restart

The laptop's offline write reached the server, and its feed resumed from its saved position without a
snapshot. Keep wrpc's `reconnect` and `heartbeat` on (they are by default) for every client you hand to
syncom; tune `reconnect: { minDelay, maxDelay }` for how fast clients come back, and `callTimeout` for how
long one call may take.

## Fall back to Server-Sent Events

Some proxies and networks block WebSockets. wrpc's SSE transport reads a server's events over a plain HTTP
stream and sends calls as POST requests, and syncom works over it unchanged:

<<< @/examples/replication-websocket.mjs#sse

There is nothing to configure on the server: its `/events` endpoint is on by default (`sse: false` on the
`Server` turns it off). SSE carries text only, so a snapshot that would arrive as a binary stream over a
WebSocket arrives as JSON pages instead; reconnects resume the same way.

## Read from a script over HTTP

A script, a server-rendered page or a cron job may need to read the board without keeping a database of
its own. Turn on `query` in the server's unit (the host step above does) and call `syncom/query` and
`syncom/count` over plain HTTP:

<<< @/examples/replication-websocket.mjs#thin

Over plain HTTP each request is a client of its own, so the call carries its hello, and the server admits
the caller as it would admit a node (`authorize`, scopes, revocations) and keeps nothing of it. The query
is a [Mango query](./query) over one collection, with `order` and `limit`, and returns at most
`limits.rowsPerQuery` rows (500 by default). A `$regex` from the wire is refused unless the unit allows it
with `query: { regex: 'safe' }`. A thin client has no live results: ask again, or dial over SSE and read
from a real database.

## Use it in the browser

The adapter has no Node.js code, so the same imports work in a bundle; dial `wss://` from the page and
let the database store its data in [OPFS](./storage-opfs) or [IndexedDB](./storage-indexeddb). A browser
node can host as well, over a WebRTC link to another browser ([WebRTC](./replication-webrtc)).

## What the adapter does

`createWrpcLink(client)` maps the [link contract](./sync-protocol) onto the client: calls go to
`client.call('syncom/…')`, the feed is a wrpc subscription that wrpc resumes from its last event id, a
streamed snapshot page is read from `client.getStream()`, and the link's `open`, `close` and `reconnect`
events are the client's own. Pass `{ unit: 'name' }` if you mounted the unit under another name than
`syncom`. On the server, every greeted node joins the wrpc room `syncom:<scope>` for each of its scopes,
so `server.rooms.count('syncom:*')` counts the nodes that take every scope.

Two wrpc features need nothing from syncom. Give the wrpc `Server` and `WrpcClient` their `telemetry`
option, and syncom its own, and a write, its push and the apply on the server become one
[trace](./telemetry). Turn on wrpc's per-message compression to shrink replication traffic. syncom does
not need a wrpc codec: ops already travel as compact positional arrays.

## Limitations

- **wrpc is a separate install.** syncom does not pull it in; keep it at version 2 on both ends.
- **Plain HTTP cannot replicate.** wrpc's `transport: 'http'` has no subscriptions, so it serves only the
  thin client's reads. Use the WebSocket or SSE for a node that replicates.
- **Timeouts are wrpc's.** syncom adds no timer of its own around a call; set `callTimeout` on the client.

## Coming from RxDB

RxDB's WebSocket plugin starts a server from an RxDB database and replicates with it collection by
collection, with no authentication, as a server-to-server tool. In syncom the WebSocket is wrpc's: one
connection carries every collection, reconnecting and resuming are the transport's, the same server also
answers SSE and plain HTTP, and the node behind it admits clients with `authorize` and holds them to
scopes and write rules, so it is meant for clients as much as for servers.

<FromRxdb page="replication-websocket" :rows="['websocket', 'http', 'reconnect', 'resume', 'remoteQuery', 'customTransport']" />
