# Sync

::: warning No transport is implemented yet
`SyncManager` registers, persists and lists peer nodes. It does **not** move
any data: `start()` walks the enabled uplinks and does nothing with them.
Treat this page as a description of the node registry, not of working
replication.
:::

## The node registry

```js
const storage = await open({ path: 'data' });

await storage.sync.addNode({
  type: 'uplink',
  url: 'ws://example.com:8001',
  token: 'secret',
});

storage.sync.listNodes();
// [{ type: 'uplink', url: 'ws://example.com:8001', token: 'secret',
//    enabled: true, lastSync: 1757000000000 }]

await storage.sync.removeNode('ws://example.com:8001');
```

| Field | Meaning |
| --- | --- |
| `type` | `'uplink'` (a peer this node pulls from) or `'downlink'` (a peer that pulls from this one) |
| `url` | Required, and unique — adding a duplicate throws |
| `token` | Optional shared secret, stored as given |
| `enabled` | Set to `true` on registration |
| `lastSync` | Timestamp, set on registration |

`addNode` throws on a missing `url`, on a `type` outside those two values, and
on a `url` already registered. `removeNode` throws for an unknown url.

## Persistence

On Node.js each node is written to `<path>/remote/<host>.json`, where the host
is taken from the url, and the registry is reloaded from that directory when
the storage is reopened. The browser `SyncManager` keeps its nodes in memory
only — nothing is written to OPFS.

## What a transport would need

The pieces the registry is built around, for when a transport lands:

- `Storage` accumulates an update log (`{ type, id, timestamp, data }`
  entries) from every `set`, `update`, `swap` and `Record.save()`.
- [`apply`](./crdt#apply-source-history) replays such a log onto a state, and
  [`merge`](./crdt#merge-source-delta) reconciles concurrent deltas.
- The [chain](./chain) gives each peer a verifiable ordering to compare
  against.

None of that is wired to a socket today.
