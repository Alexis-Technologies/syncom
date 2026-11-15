// The Quickstart page (docs/guide/quickstart.md) shows the regions of this file.
// tests/package/docs-examples.test.js runs it from an empty temporary directory.
import assert from 'node:assert/strict';
// #region collection
import { createDatabase } from '@alexify/syncom/all';

const board = await createDatabase({
  path: 'board',
  schema: {
    entities: {
      Task: { index: ['done'] },
    },
  },
});
// #endregion collection

// #region insert
const task = await board.Task.insert({ title: 'Write the docs', done: false });
console.log(task.id); // a UUID, generated for you
// #endregion insert

// #region query
await board.Task.insert({ title: 'Ship it', done: false });
await board.Task.insert({ title: 'Set up the repo', done: true });

const open = await board.Task.select({ done: false }).order('title').fetch();
console.log(open.map((row) => row.title)); // [ 'Ship it', 'Write the docs' ]
// #endregion query
assert.deepEqual(
  open.map((row) => row.title),
  ['Ship it', 'Write the docs'],
);

// #region update
await board.Task.update(task.id, { done: true }); // a plain field: the last write wins
await board.inc(task.id, 'votes', 1); // a counter: increments from every node add up
await board.add(task.id, 'tags', ['docs']); // a set: concurrent adds are all kept
console.log(await board.Task.get(task.id));
// { title: 'Write the docs', done: true, $type: 'Task', votes: 1, tags: [ 'docs' ] }
// #endregion update
assert.deepEqual(await board.Task.get(task.id), {
  title: 'Write the docs',
  done: true,
  $type: 'Task',
  votes: 1,
  tags: ['docs'],
});

// #region observe
const stop = board.Task.select({ done: false }).watch((rows) => {
  console.log('open tasks:', rows.length);
});
// open tasks: 1   (right away)
await board.Task.insert({ title: 'Answer issues', done: false });
// open tasks: 2   (after the insert lands)
// #endregion observe
await new Promise((resolve) => setTimeout(resolve, 20));
stop();

// #region delete
await board.Task.delete(task.id);
console.log(await board.Task.get(task.id)); // null
// #endregion delete
assert.equal(await board.Task.get(task.id), null);

// #region host
// server.mjs: the node the others dial, here the `board` database opened above
import { Server, defineRouter } from '@alexify/wrpc';

const router = defineRouter({
  // `syncom` is the name the other side calls: syncom/hello, syncom/push, syncom/changes…
  syncom: board.sync.unit({
    access: 'public', // let any connection greet the unit…
    authorize: (context, hello) => hello.token === 'board-secret', // …and admit only nodes with the token
  }),
});
// 0.0.0.0 listens on every network interface; the WebSocket endpoint is ws://<this host>:8000/api
const server = new Server({ router, host: '0.0.0.0', port: 8000, protocol: 'http' });
await server.listen();
// #endregion host

// #region dial
// laptop.mjs: a second node, on another device, with the same collections
import { WrpcClient } from '@alexify/wrpc';
import { createWrpcLink } from '@alexify/syncom/wrpc';

const laptop = await createDatabase({
  path: 'laptop',
  schema: { entities: { Task: { index: ['done'] } } },
  sync: {
    connect: async (node) => createWrpcLink(await WrpcClient.connect(node.url)),
  },
});
// the server's address on your network, e.g. ws://192.168.1.20:8000/api
await laptop.sync.addNode({ url: 'ws://127.0.0.1:8000/api', token: 'board-secret' });
await laptop.sync.awaitInSync();

console.log((await laptop.Task.select({}).fetch()).length); // 3: every task the server has
await laptop.Task.insert({ title: 'Written on the laptop', done: false });
// #endregion dial
assert.equal((await laptop.Task.select({}).fetch()).length, 4);

await laptop.sync.awaitInSync();
await new Promise((resolve) => setTimeout(resolve, 50));
assert.equal((await board.Task.select({}).fetch()).length, 4);
await laptop.close();
await board.close();
await server.close();
