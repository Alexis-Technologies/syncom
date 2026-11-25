---
title: Presence
description: Show who is online, which task each person has open and where their caret is, with state that is never logged and that hosts relay to the right peers.
---

# Presence

A shared board feels alive when you can see who else is on it: Bob's avatar on the task he has open, his
caret moving in its notes. That state changes several times a second and means nothing an hour later, so
it does not belong in the records, the log or the history. Writing it as ops would fill every node's log
with carets.

`@alexify/syncom/presence` keeps it apart. Each node holds one small state of its own and the states it
heard from others; the sync engine carries them over the same links as the ops, and nothing of them is
ever written to a log, a record or a chain.


## Share a state from each node

The examples run a server, a laptop and a phone in one process (`createMesh` from
`@alexify/syncom/testing`), the laptop and the phone dialing the server. Create a presence instance for
each database and hand it to the sync manager:

<<< @/examples/presence.mjs#create

`db.sync.presence(instance)` sends every change of this node's state to every host it dials, and feeds the
states the hosts relay back into the instance. It returns a function that stops carrying it.

Listen for the nodes that arrive, change and leave:

<<< @/examples/presence.mjs#listen

Then set this node's state. It is any JSON object: here a name, a color, the task Ada has open and her
caret in its notes:

<<< @/examples/presence.mjs#set

The phone hears of it and reads it by node id:

<<< @/examples/presence.mjs#read

`get(node)` reads one state, `states()` all of them as a `Map` (this node's included), and `nodes()` the
ids that have one.

## Keep a caret on the right character

A caret stored as a number goes wrong as soon as someone types before it. Store a
[cursor](./text) instead: `db.cursor(id, field, index)` returns a token that stays attached to the same
place in a text or a list, and `db.position(id, field, token)` reads where that place is now:

<<< @/examples/presence.mjs#caret-moves

Bob typed six characters before Ada's caret, and the same token now reads index 10 on every node. Draw
other people's carets from tokens, and they stay put while everyone types.

## Leave, or time out

<<< @/examples/presence.mjs#leave

`delete()` sends an empty state, and every node removes Ada at once. A node that disappears without
leaving (a closed laptop, a lost connection) stops renewing its state, and the others drop it once
`timeout` passes without a renewal (30 seconds by default). A node renews its own state by itself, a third
of the timeout at a time, so you call `set()` only when something changed. `destroy()` leaves and stops
the instance's timers.

## What a state may hold

A state is one JSON object of at most 64 keys, 8 levels deep and 16 KiB as JSON; `set()` rejects a larger
one with `ALX_ERR_PRESENCE_SIZE`. Every `set()` replaces the whole state, and each carries a counter of this
node's, so where two updates arrive out of order the newer wins. Keep what changes often (a caret) small;
16 KiB is the bound, not a target.

An instance belongs to one [scope](./partial-sync): `createPresence(db, { scope: 'design' })` shares its
state with the nodes of the design board alone, and `'*'` (the default) with every node. A node that takes
part in several scopes creates an instance per scope.

When the [signing](./signing) plugin is registered, every state goes out signed with the node's key, and
a received state that does not verify against the node it names is dropped. Under
`sync: { signatures: 'require' }`, unsigned states are refused too. Without the plugin, states travel
unsigned.

## What a host relays

A host needs no presence instance of its own to relay; it creates one only if its own users take part.
When a node sends an update, the host checks it before passing it on: every entry must be the sending
node's own, of a scope the node asked for in its hello, within the rate limit (20 updates a second per
node), and signed where the host requires signatures. It relays what passes to the other nodes of that
scope, not back to the sender, and refuses the rest, which it reports on its `refused` event with a
`PRESENCE_…` reason. It also keeps the newest state per node for a while, so a node that connects later is
handed everyone's state with its hello.

Tune it with the unit's `presence` option: `db.sync.unit({ presence: { timeout, rate, max } })` sets how
long the host keeps a state for newcomers (30 000 ms), the updates per second per node (20) and the
states kept per scope (1 024).

## Carry presence over a transport of your own

Presence does not need the sync engine. Between the tabs of one browser, or among WebRTC peers, send the
instance's updates over whatever connects them and feed what arrives to `apply()`:

<<< @/examples/presence.mjs#encode

`update` fires with this node's state whenever it changes or is renewed; `encode()` returns every state
the instance knows, to hand to a newcomer. `apply(update)` keeps the newest state per node, drops expired,
forged and oversized entries, and resolves to what it counted: `{ applied, stale, forged, unsigned,
refused }`. Pass `{ from: node }` to refuse any entry that is not that node's, which is how a relay holds
each sender to its own name. Entries it refused also raise the instance's `refused` event.

## Trade-offs

- **Gone when you are offline.** Presence is never stored, so a node that comes back sees who is there now,
  not who was there while it was away.
- **No history.** Nothing of it reaches the log, so [versions](./versions) and [undo](./undo) never see
  it. If "who edited what" must be kept, that is the `actor` every op carries
  (`createDatabase({ actor })`), not presence.
- **Best effort.** An update travels as a fire-and-forget event, so one can be lost on the way; the next
  renewal, a third of the timeout later, repairs it. Never put in presence what must arrive.
