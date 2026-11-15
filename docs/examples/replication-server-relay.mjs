// The syncom server replication page (docs/guide/replication-server.md) shows the regions of this file: a node that
// dials one host and hosts others itself. Its servers listen on ports 8201 and 8202.
// tests/package/docs-examples.test.js runs it from an empty temporary directory.
import assert from 'node:assert/strict';
import { Server, defineRouter, WrpcClient } from '@alexify/wrpc';
import { createDatabase } from '@alexify/syncom/all';
import { createWrpcLink } from '@alexify/syncom/wrpc';
import { settle } from '@alexify/syncom/testing';

const schema = { entities: { Task: {} } };
const connect = async (node) => createWrpcLink(await WrpcClient.connect(node.url));
const host = async (db, port) => {
  const server = new Server({
    router: defineRouter({ syncom: db.sync.unit({ access: 'public' }) }),
    host: '127.0.0.1',
    port,
    protocol: 'http',
  });
  await server.listen();
  return server;
};

const server = await createDatabase({ path: 'server', schema });
const serverHttp = await host(server, 8201);

// #region relay
// The office desktop dials the server and hosts the devices on the office network.
const desktop = await createDatabase({ path: 'desktop', schema, sync: { connect } });
await desktop.sync.addNode({ url: 'ws://127.0.0.1:8201/api' });

const router = defineRouter({ syncom: desktop.sync.unit({ access: 'public' }) });
const lan = new Server({ router, host: '127.0.0.1', port: 8202, protocol: 'http' });
await lan.listen();

// The phone dials the desktop, never the server.
const phone = await createDatabase({ path: 'phone', schema, sync: { connect } });
await phone.sync.addNode({ url: 'ws://127.0.0.1:8202/api' });
// #endregion relay

// #region relayed
const fromPhone = await phone.Task.insert({ title: 'Written on the phone', done: false });
const fromServer = await server.Task.insert({ title: 'Written on the server', done: false });
// phone → desktop → server, and server → desktop → phone: the desktop passes on what it receives
// #endregion relayed
await settle([server, desktop, phone], { timeout: 10_000 });
assert.deepEqual(await server.Task.get(fromPhone.id), { title: 'Written on the phone', done: false, $type: 'Task' });
assert.deepEqual(await phone.Task.get(fromServer.id), { title: 'Written on the server', done: false, $type: 'Task' });

await phone.close();
await desktop.close();
await server.close();
await lan.close();
await serverHttp.close();
