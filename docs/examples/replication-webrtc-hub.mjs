// The WebRTC page (docs/guide/replication-webrtc.md) shows the regions of this file: the hub that signals for the
// browser peers and syncs with them too. Its server listens on port 8204.
// tests/package/docs-examples.test.js runs it from an empty temporary directory.
import assert from 'node:assert/strict';
import { createDatabase } from '@alexify/syncom/all';

const schema = { entities: { Task: {} } };
const hub = await createDatabase({ path: 'hub', schema, sync: { scope: (id, data) => data.board ?? '*' } });

// #region hub
import { Server, defineRouter } from '@alexify/wrpc';
import { createSignalingUnit, createSignalingHooks } from '@alexify/wrpc/webrtc';

const router = defineRouter(
  {
    // wrpc's signaling: who is in which room, and the offers and answers between them.
    // In production keep wrpc's default access ('session') and name each peer from the session.
    ...createSignalingUnit({
      access: 'public',
      authorize: (context, info) => info.action !== 'join' || info.room.startsWith('board:'),
    }),
    // syncom's unit, on the same server: the hub is a node the browsers sync with too.
    syncom: hub.sync.unit({ access: 'public', limits: { opsPerPush: 500, opsPerSecond: 2000 } }),
  },
  { hooks: createSignalingHooks() },
);
const server = new Server({ router, host: '127.0.0.1', port: 8204, protocol: 'http' });
await server.listen();
// #endregion hub

// A dialer syncs with the hub over the same server the signaling runs on.
import { WrpcClient } from '@alexify/wrpc';
import { createWrpcLink } from '@alexify/syncom/wrpc';
import { settle } from '@alexify/syncom/testing';
const laptop = await createDatabase({
  path: 'laptop',
  schema,
  sync: { connect: async (node) => createWrpcLink(await WrpcClient.connect(node.url)) },
});
await laptop.sync.addNode({ url: 'ws://127.0.0.1:8204/api' });
const task = await laptop.Task.insert({ title: 'Through the hub', board: 'design' });
await settle([hub, laptop], { timeout: 10_000 });
assert.deepEqual(await hub.Task.get(task.id), { title: 'Through the hub', board: 'design', $type: 'Task' });
await laptop.close();
await hub.close();
await server.close();
