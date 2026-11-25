---
title: Signing and identity
description: Make every op verifiable by its author's key, refuse what a relay forged or stripped, and ask peers to prove their key before they sync.
---

# Signing and identity

In a mesh, an op can reach a node through several others: a hub, a relay, a peer that was online when the
author was not. Signing lets the receiver check that the op is exactly what its author wrote, whichever
path it took. Each node's id is its Ed25519 public key, every op it makes is signed with the matching
private key, and a receiver verifies an op against its `origin` with no key directory to look anything up
in.

Signing is the `signing` plugin, which `@alexify/syncom/all` registers; with the lean core, pass
`plugins: [signing]` from `@alexify/syncom/signing`.

## A node's id is its key

<<< @/examples/signing.mjs#identity

With the plugin, the node id is the raw public key in base64url, 43 characters. The key pair is made at the
first open and kept next to the data (`keys/sign-public.pem` and `keys/sign-private.pem`). Without the
plugin the node id is a UUID (or what your `getId` option mints), its ops go out unsigned, and it checks
nothing it receives. A directory that was first opened without the plugin is rekeyed once when the plugin
arrives, with an `identity.rekeyed` warning.

## What a forged op gets

A relay that changes an op on its way, here the amount in a record, produces an op whose signature no
longer checks:

<<< @/examples/signing.mjs#forged

The receiver refuses it: not applied, not logged, not relayed, and its vector does not move, so the op is a
gap in its author's stream until it arrives again intact. The refusal is counted (`forged` in the result of
the page, `syncom.ops.rejected` in [telemetry](./telemetry)) and reported once per page as an `error` event
with `code: 'ALX_ERR_BAD_SIGNATURE'`. A host also emits `refused` on its sync manager, naming the peer that pushed
it.

The signature covers the op's header (its origin, sequence number, stamp, type, record id, scope, actor and
the fingerprint of the op before it) and a digest of its payload salted with a random nonce. Keeping the
payload apart from the header is what lets a [purge](./purge) erase the payload and the nonce from every log
while the header still verifies.

## Choose how strict a node is

`createDatabase({ sync: { signatures } })` picks the mode:

| Mode | This node | A peer's signed op | A peer's unsigned op |
| --- | --- | --- | --- |
| `'verify'` (the default) | signs | verified, refused if it does not check | taken |
| `'require'` | signs | verified, refused if it does not check | refused, as is any op whose origin is no key |
| `false` | signs nothing | taken unverified | taken |
| without the plugin | signs nothing | taken unverified | taken |

<<< @/examples/signing.mjs#require

`'verify'` is the default so that a mesh can mix nodes with and without the plugin. Its weakness is that a
relay can strip a signature and the op is taken as unsigned. Only `'require'` resists that, and it is for a
mesh where every node signs: the plugin on every node and `'require'` on every node. `'require'` without
the plugin is refused at `createDatabase()` with `ALX_ERR_PLUGIN_MISSING`, and a `'require'` host refuses the
hello of a node whose id is no key (403 `UNSIGNED`) instead of refusing every push from it in silence.

## Make peers prove their key at hello

A peer's hello names its node id, but a name is not proof. With `prove`, a host hands every peer a challenge
at hello and serves nothing until the peer signs it:

<<< @/examples/signing.mjs#prove

The dialing node signs the challenge with its key before it pushes anything. Until it has, its push,
snapshot, changes, query, count and blob calls are refused with 403 `UNPROVEN`, and a node without the
signing plugin cannot prove anything: its peer view's `lastError` says `ALX_ERR_UNPROVEN`. `prove` is on by default
for a unit under `signatures: 'require'`, and needs the signing plugin on the host.

Proof of key matters when the host grants something per node: [scopes](./partial-sync) by node id, an
`authorize` rule that trusts `hello.node`, or presence. Without it, a peer can greet with someone else's
id; its pushes would fail as forged, but it could read what that id may read.

## What a signature proves, and what it does not

A signature proves that the op, header and content, was made by the holder of the key its origin names,
whatever path it took. It does not prove more than that:

- `actor` is signed, so a relay cannot change it, but it is still what the writer claimed about itself.
  Check it against what your `authorize` established, in a `beforeApply` [hook](./hooks).
- A snapshot carries records, not ops: a node that bootstraps signs the joined state as ops of its own. Under
  `'require'` that is the one way unverified state enters a node, from a host it chose to bootstrap from.
- Delivery is not proved. A peer can withhold an op, which shows as a gap, or present it with its payload
  stripped, as a purge would leave it, which applies as a no-op: suppression, not forgery.

## Two different ops at one place in a stream

A writer can produce two ops with the same sequence number: a directory restored from an old backup, two
processes running under one identity, or a key holder that lies to different hosts. Every op names the
fingerprint of the op before it in its stream, so a node that holds one branch refuses the other with an
`error` event of code `ALX_ERR_EQUIVOCATION`. Each node keeps the branch it saw first and never mixes the two. The
fork is detected, not healed: retire the identity that forked. The [wire reference](../reference/wire#the-per-stream-chain)
has the details.

## Sign your own messages

The key functions the plugin stands on are exported for your own use, for example to sign an approval with
a key whose id looks like a node id:

<<< @/examples/signing.mjs#keys

In the browser `sign`, `verify` and `calculateHash` return promises (Web Crypto has no synchronous API).

## Costs

A signature, a digest and a nonce add about 190 bytes to every op, on the wire and in the log; a host's
`bytesPerPush` limit counts them. Signing runs on the main thread when the op is made; verifying runs on
libuv's thread pool in Node.js and in Web Crypto in the browser, 64 ops of a page at a time.

## Coming from RxDB

RxDB does not sign documents: a replication trusts whatever the other side sends, and authenticity is the
job of the server's own authentication. In syncom the author's key travels with every op, so a node can
check an op it received from a relay it does not trust.
