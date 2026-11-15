// The Installation page (docs/guide/install.md) shows the region of this file: a lean database that syncs over wrpc.
// Its server listens on port 8217. tests/package/docs-examples.test.js runs it from an empty temporary directory.
import assert from 'node:assert/strict';
import { Server, defineRouter } from '@alexify/wrpc';
import { createDatabase as open } from '@alexify/syncom';
import { schema as schemaPlugin } from '@alexify/syncom/schema';
import { query as queryPlugin } from '@alexify/syncom/query';
import { sync as syncPlugin } from '@alexify/syncom/sync';
import { waitUntil } from '@alexify/syncom/testing';

// The node the laptop dials, lean as well: the sync plugin gives it `db.sync.unit()`.
const board = await open({
  path: 'board',
  logger: false,
  plugins: [schemaPlugin, queryPlugin, syncPlugin],
  schema: { entities: { Task: { index: ['done'] } } },
});
const router = defineRouter({ syncom: board.sync.unit({ access: 'public' }) });
const http = new Server({ router, host: '127.0.0.1', port: 8217, protocol: 'http' });
await http.listen();
await board.Task.insert({ title: 'Written on the server', done: false });

// #region sync
import { createDatabase } from '@alexify/syncom';
import { schema } from '@alexify/syncom/schema';
import { query } from '@alexify/syncom/query';
import { sync } from '@alexify/syncom/sync';
import { createWrpcLink } from '@alexify/syncom/wrpc'; // the link adapter: not a plugin
import { WrpcClient } from '@alexify/wrpc';

const laptop = await createDatabase({
  path: 'laptop',
  plugins: [schema, query, sync],
  schema: { entities: { Task: { index: ['done'] } } },
  sync: { connect: async (node) => createWrpcLink(await WrpcClient.connect(node.url)) },
});
await laptop.sync.addNode({ url: 'ws://127.0.0.1:8217/api' });
await laptop.sync.awaitInitialReplication();
console.log(await laptop.Task.select({ done: false }).count()); // 1: the server's task
// #endregion sync
assert.deepEqual(laptop.plugins, ['schema', 'query', 'sync']);
assert.equal(await laptop.Task.select({ done: false }).count(), 1);
const mine = await laptop.Task.insert({ title: 'Written on the laptop', done: false });
await waitUntil(async () => (await board.Task.get(mine.id)) !== null);

await laptop.close();
await board.close();
await http.close();
