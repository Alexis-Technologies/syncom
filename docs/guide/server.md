---
title: Hosting a node
description: Turn any syncom database into the node other nodes dial, then decide who may connect, what they may write, how fast, and what thin clients may read.
---

# Hosting a node

syncom has no separate server product. Any database with the sync plugin can host: it mounts a set of
procedures (the sync unit) on a [wrpc](./replication-websocket) router, and other nodes dial it. A host
holds a full replica, so it answers from its own data, keeps working when it has no peers, and relays
what one client writes to every other. Choose this page when you want a node in the middle: a server
every laptop and phone syncs through, a gateway that enforces your rules, or a source of reads for
scripts that keep no database. The steps below build a host for the task board and lock it down.

<div class="sc-steps">

### Open the database

The host is an ordinary database. `@alexify/syncom/all` includes the sync plugin, and the host should
run every plugin its peers write with (see [Limitations](#limitations)).

<<< @/examples/server.mjs#open

### Decide who may connect

`authorize(context, hello)` runs every time a dialing node says hello, which it does on every
connection and after every reconnect. `hello.token`
is the token the dialer registered with `addNode({ url, token })`, and `hello.scopes` the
[scopes](./partial-sync) it asks to be held to. Return `false` and the hello is refused with 403.

<<< @/examples/server.mjs#authorize

`context` is wrpc's: if you keep wrpc's default access level (`'session'`) and sign clients in through
wrpc's own authentication, `context.session` is available here too, and the token becomes optional.

### Decide what a peer may write

`authorizeWrite` sees every op a peer pushes, with the record as the host holds it (`current`) and as
the op would leave it (`after`). Return `false` to refuse that op. This rule keeps deletes for the
server alone.

<<< @/examples/server.mjs#rules

A refused op is not thrown away in silence: the host logs it as an empty no-op, so the writer's
stream has no hole, and names it in the answer to the push. The writer then puts its own copy back to
what the host holds (see [What a refused write looks like](#what-a-refused-write-looks-like)). You can
also set the rule once for every unit with `createDatabase({ sync: { authorizeWrite } })`.

### Bound what a peer can push

`limits` are checked in the push itself, whatever transport carried it. A page over `opsPerPush` or
`bytesPerPush` is refused with 413, and a peer that sends more than
`opsPerSecond` ops a second gets 429.

<<< @/examples/server.mjs#limits

A refusal is a code, not a hang-up: the dialer reports it, marks the host as behind, and pushes what is
missing at the next sign of life on the link. A dialer pushes pages of `sync.pageSize` ops (500 by
default), so keep `opsPerPush` at or above it, or no page ever gets through.

### Mount the unit and listen

`sync.unit()` returns a plain object of procedures shaped for wrpc's `defineRouter`. Mount it under
`syncom`, the name dialers call.

<<< @/examples/server.mjs#mount

`access: 'public'` lets any connection reach the procedures and leaves the gate to `authorize`.
`query: true` adds the reads of the last section.

### Dial it

A client registers the host once, with its token. The registry is kept on disk, so the next start
dials it again by itself.

<<< @/examples/server.mjs#dial

</div>

## Watch who is connected

The host's manager reports the hosting side through events and two views: `hello` when a peer was
authorized, `refused` when a push carried ops it would not take (`reason` is `'scope'`, `'rule'`,
`'forged'`, `'unsigned'` or `'equivocation'`).

<<< @/examples/server.mjs#observe

`server.sync.hosted()` lists every peer with a live feed, with its scopes and cursor, and
`server.sync.sessions()` every greeted peer and how many connections it holds. To take scopes back from
a peer that is connected, call `server.sync.revoke(node, scopes)`: [Partial sync](./partial-sync)
shows the whole flow.

## What a refused write looks like

On the client, a write the host refuses arrives as a `ALX_ERR_WRITE_REFUSED` error on the manager, and the
record goes back to what the host holds. Here the laptop deletes a task, the server's rule refuses the
delete, and the task returns on the laptop.

<<< @/examples/server.mjs#refused

The revert is made of new ops stamped after the refused one, through each field's own kind (a counter
by an increment, a set by adds and removes), so whatever the host accepted from others in the meantime
stays. The host tells the kind of each field with the record, so a field the refused write turned into
another kind (a counter unset and written as a plain value) is that kind again on the client, and what
the host's own kind does next still lands there. The error carries `id`, `current` (the record as the host holds it) and `touched` (the fields
put back, or `null` for the whole record). A revert that the host refuses again is reported and left
alone.

## Serve reads to thin clients

A client that keeps no database, such as a report script, a server-rendered page or a service in
another language, can read the host through `syncom/query` and `syncom/count` once the unit serves
them (`query: true`). Over plain HTTP every request is its own wrpc client, so no hello can come
first: the call carries it, and the host checks it as it checks any hello, with `authorize` and the
scopes, and keeps nothing of it.

<<< @/examples/server.mjs#thin

The rows are those of a [query](./query): a MongoDB-style selector over a collection, sort keys and a
window, limited to the caller's scopes and to `limits.rowsPerQuery` rows (500 unless you set it). For a
scoped caller the budget counts the rows the host reads, and the answer says `capped: true` when the
budget ran out before the window was full. Records stored [encrypted](./encryption) are never served.
A `$regex` from the wire is refused with 400 unless you allow it: `query: { regex: 'safe' }` takes
patterns without nested quantifiers, backreferences or lookarounds, and `query: { regex: true }` takes
any, which you should reserve for peers you trust, since a pattern runs on the host's event loop. For
live results, dial over Server-Sent Events instead and keep a replica ([WebSocket](./replication-websocket)
covers the transports).

## Serve only some procedures

`allow` decides which procedures a unit serves. A read-only mirror takes no pushes, a write-only sink
serves no feed, and each can be a unit of its own on the same router.

<<< @/examples/server.mjs#mirror

A push to a unit without `push` is refused with 403 `READ_ONLY`, and a feed or a snapshot from a unit
without them with 403 `NOT_SERVED`. `allow.blob` controls how [attachments](./attachments) are served:
by default only to a peer that names a live record in its scopes holding the bytes.

## Apply a policy to every procedure

Some rules belong to the whole router, not to sync: a rate limit per session across every unit, an
audit of who called what. Write them as a wrpc `onRequest` hook, and give the unit a `meta` object the
hook reads as `context.procedure.meta`.

<<< @/examples/server.mjs#hook

The hook runs before access checks and the handler, on every transport the router serves, with a
bucket per procedure, so `hello` and `changes` keep their own budgets. A push refused with 429 reaches
the dialer as an error with that code; it keeps its cursor and pushes the rest later. The `Server`'s
own options (`maxCalls`, `maxSubscriptions`, `maxBatch`, `maxMessage`) bound the wire below all of this.

## Ask peers to prove their key

With the [signing plugin](./signing), a node's id is its public key. `unit({ prove: true })` (the
default when the host runs `sync: { signatures: 'require' }`) hands every peer a random challenge at
hello and refuses everything else with 403 `UNPROVEN` until the peer signs it. A dialing syncom node
answers the challenge by itself; you only turn it on.

## Host from a browser

Nothing in hosting is Node.js-only. A browser tab can host its unit on a wrpc `PeerHost` over a WebRTC
data channel, and the other tabs or devices dial it as they would dial a server. [WebRTC
P2P](./replication-webrtc) shows the setup.

## Limitations

- **The host should run your peers' plugins.** An op of a kind the host has no plugin for (a text
  field on a core-only host) is still logged and relayed, so the host carries it between peers, but
  its own copy of that field stays empty, and a dialer that runs more kinds than the host will not
  bootstrap from it (`ALX_ERR_KINDS_MISMATCH`).
- **Rules are per op and per record, not per field of a query.** There is no field that exists only
  on the server. Keep server-only data in records of a scope that clients are not granted, or in
  [local documents](./local), which never replicate.
- **Writes come in as ops.** There is no REST endpoint that writes: a client that wants to write keeps
  a database and syncs. Thin clients read.
- **CORS, TLS and sessions are wrpc's.** Configure them on the wrpc `Server`; use `wss://` in
  production so tokens do not travel in clear.

[`SyncManager` and `unit()`](../reference/api#syncmanager) list every option; the procedures and their
refusal codes are in [Wire format](../reference/wire#the-procedures).

## Coming from RxDB

RxServer adds an endpoint per collection to a server you start separately; syncom mounts one unit per
database on a router you already have, and the same unit serves replication, thin-client reads and
attachments. RxDB's auth handler maps to `authorize`, its query modifier to [scopes](./partial-sync),
its change validator to `authorizeWrite`, and its REST query endpoint to `syncom/query`. Both refuse
`$regex` from clients by default. RxServer can hide server-only fields from clients; syncom has no
field-level equivalent. The syncom server code is part of the MIT package.

<FromRxdb page="rx-server" :rows="['serverProduct', 'serverRuntime', 'endpoints', 'remoteQuery', 'authn', 'writeRules', 'limits']" />
