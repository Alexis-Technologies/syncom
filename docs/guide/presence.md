# Presence

Who is here, what they are editing, where their cursor is: ephemeral state
that belongs next to the documents, not in them. `@alexify/syncom/presence`
keeps it per node — never in the log, never as an op — and the sync plugin
carries it over the same links the ops take.

```js
import { createPresence } from '@alexify/syncom/presence';

const presence = createPresence(storage, { scope: 'Doc', timeout: 30_000 });
storage.sync.presence(presence);                           // carried to and from every host

await presence.set({ name: 'ada', doc: id, cursor: await storage.cursor(id, 'body', 12) });
presence.on('change', ({ added, updated, removed }) => render(presence.states()));
presence.get(peerNode);                                     // { name: 'bob', … } or undefined
await presence.delete();                                    // leaves: null for everyone
```

## The model

- **One state per node**, a JSON object of at most 64 keys, 8 deep, 16 KiB
  as JSON (`PRESENCE_SIZE` otherwise). Every `set()` is newer than the last
  by this node's own clock, so the newest wins wherever two arrive out of
  order; a state is gone when it is not renewed within `timeout` — this
  node's renews itself, a third of the timeout at a time — and `delete()`
  leaves at once with a null state.
- **Signed when the node can sign.** With the [signing](./sync#signatures) plugin
  registered, every state goes out signed with the node's Ed25519 key over
  `[1, node, clock, ts, state]` in canonical JSON, and a state received is
  verified against the node it claims: a signature that does not verify is
  forged and dropped, and under `sync.signatures: 'require'` an unsigned
  state is refused. Without the plugin states travel unsigned.
- **A scope per instance.** `scope` is the sync scope the states are of
  (`'*'`, the global one, by default): a host relays them to the peers of
  that scope. One instance per scope a node takes part in.
- **Nothing of it is written** — not to the log, not to the chain, not to a
  record. A `Record` never sees it; history never shows it.

## Over the hub

`storage.sync.presence(instance)` makes the sync manager carry an instance:
every `update` it emits goes to every connected host as the fire-and-forget
event `syncom/presence`, a host's events come back to it, and at `hello` a
host hands this node what its room holds. On the host, the unit's inbound
event `on.presence` checks an update — every entry the greeted node's own,
of a scope the peer asked for, within `unit({ presence: { rate } })` updates
a second (20), signed under `'require'` — refuses what fails (counted,
announced as `refused`, never relayed), relays the rest to the wrpc room
`syncom:<scope>` but the sender, and keeps the newest state per node (at
most `presence.max`, 1 024, per scope; for `presence.timeout`, 30 000 ms) to
hand to the next newcomer. A hub that only relays needs no instance of its
own; one that takes part registers one like any node.

```js
// the host
const router = defineRouter({ syncom: storage.sync.unit({ access: 'public', presence: { rate: 20 } }) });
// a peer, over wrpc: the adapter maps `send` to client.sendEvent and the unit's events
const storage = await open({ plugins: [sync, signing], sync: { connect: (node) => createWrpcLink(client) } });
```

A link of the application's own carries it with the optional `send(event,
data)` of the [link contract](./sync#the-link-contract) and the
`syncom/presence` event it raises; a transport that is not syncom's at all —
a WebRTC room, a broadcast channel between tabs — carries `encode()` and
feeds `apply()`:

```js
mesh.broadcast('presence/state', presence.encode());        // everything known here
mesh.on('presence/state', (update) => presence.apply(update)); // the newest per node, the forged dropped
```

`apply()` resolves to what it counted — `{ applied, stale, forged, unsigned,
refused }` — and with `{ from: node }` refuses an entry that is not that
node's, which is how a host holds a peer to its own name.

## Cursors in a state

A cursor is a [token](./lists#cursors) that survives the edits around it, so
a selection shared through presence stays right while others type:
`cursor()` makes it, `position()` reads it back as `{ index, side }` on the
node that renders it. A state is replaced whole on every `set()`; keep what
changes often (a caret) apart from what does not (a name, a color) if the
size matters, or send both — 16 KiB is the bound.
