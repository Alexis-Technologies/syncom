// The GraphQL page (docs/guide/replication-graphql.md) shows the regions of this file. The GraphQL server here is a
// stand-in in memory behind `fetch`, answering the two operations of the page's schema (`pullTasks`, `pushTasks`),
// with a subscription client in the shape of graphql-ws's `subscribe(payload, sink)`.
// tests/package/docs-examples.test.js runs it from an empty temporary directory.
import assert from 'node:assert/strict';

const waitUntil = async (check) => {
  for (let i = 0; i < 300; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('waitUntil: timed out');
};
const canonical = (value) => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
    .join(',')}}`;
};

const createServer = () => {
  const tasks = new Map();
  const sinks = new Set();
  let changes = 0;
  const requests = [];
  const save = (id, data) => {
    tasks.set(id, { data: structuredClone(data), change: ++changes });
    for (const sink of [...sinks]) sink.next({ data: { taskChanged: changes } });
  };
  const resolvers = {
    pullTasks: ({ since, limit }) => {
      const page = [...tasks]
        .filter(([, task]) => task.change > (since ?? 0))
        .sort((a, b) => a[1].change - b[1].change)
        .slice(0, limit);
      return {
        documents: page.map(([id, task]) => ({ id, data: task.data, deleted: task.data === null })),
        checkpoint: page.length > 0 ? page.at(-1)[1].change : (since ?? 0),
      };
    },
    // Each row written over what it assumed; the rest answered as the server holds them.
    pushTasks: ({ rows }) => {
      const conflicts = [];
      for (const row of rows) {
        const held = tasks.get(row.id)?.data ?? null;
        if (!('assumed' in row) || canonical(held) !== canonical(row.assumed)) {
          conflicts.push({ id: row.id, data: held, deleted: held === null });
          continue;
        }
        save(row.id, row.deleted ? null : row.data);
      }
      return { conflicts };
    },
  };
  const execute = (query, variables) => {
    for (const name of Object.keys(resolvers)) {
      if (query.includes(name)) return { data: { [name]: resolvers[name](variables) } };
    }
    return { errors: [{ message: `Cannot query: ${query.slice(0, 30)}` }] };
  };
  return {
    requests,
    save,
    read: (id) => tasks.get(id)?.data ?? null,
    execute,
    async fetch(url, init) {
      requests.push({ url, headers: init.headers });
      const { query, variables } = JSON.parse(init.body);
      const body = execute(query, variables);
      return { ok: true, status: 200, json: async () => structuredClone(body) };
    },
    // graphql-ws's client.subscribe(payload, sink) → unsubscribe
    subscriptions: {
      subscribe(_payload, sink) {
        sinks.add(sink);
        return () => sinks.delete(sink);
      },
    },
  };
};

const server = createServer();
globalThis.fetch = server.fetch;
const { subscriptions } = server;
const token = 'a-bearer-token';
server.save('t1', { title: 'Plan the sprint', done: false });

// #region replicate
import { createDatabase } from '@alexify/syncom/all';
import { replicate } from '@alexify/syncom/connector';
import { graphql } from '@alexify/syncom/connector/graphql';

const board = await createDatabase({ path: 'board', schema: { entities: { Task: {} } } });

const replication = replicate(board, {
  name: 'graphql',
  collection: 'Task',
  ...graphql({
    url: 'https://api.example.com/graphql',
    headers: { authorization: `Bearer ${token}` },
    pull: {
      query: `query PullTasks($since: Int, $limit: Int!) {
        pullTasks(since: $since, limit: $limit) { documents { id data deleted } checkpoint }
      }`,
      variables: (checkpoint, batchSize) => ({ since: checkpoint, limit: batchSize }),
      read: (data) => data.pullTasks, // { documents, checkpoint }
    },
    push: {
      query: `mutation PushTasks($rows: [TaskRow!]!) {
        pushTasks(rows: $rows) { conflicts { id data deleted } }
      }`,
      variables: (rows) => ({ rows }),
      read: (data) => data.pushTasks.conflicts,
    },
    // Your subscription client (graphql-ws here): every event means "pull again".
    stream: (emit) =>
      subscriptions.subscribe(
        { query: 'subscription { taskChanged }' },
        { next: () => emit('RESYNC'), error: () => emit('END'), complete: () => emit('END') },
      ),
  }),
});
await replication.awaitInitialReplication();
// #endregion replicate
assert.deepEqual(await board.Task.get('t1'), { title: 'Plan the sprint', done: false, $type: 'Task' });
assert.equal(server.requests[0].headers.authorization, `Bearer ${token}`);

// #region use
const task = await board.Task.insert({ title: 'Write the docs', done: false });
await replication.awaitInSync();
// the server now holds { title: 'Write the docs', done: false }

server.save('t2', { title: 'Review the PR', done: false }); // another client's mutation
// taskChanged fires, the connector pulls, and t2 lands here
// #endregion use
assert.deepEqual(server.read(task.id), { title: 'Write the docs', done: false });
await waitUntil(async () => (await board.Task.get('t2')) !== null);
assert.deepEqual(await board.Task.get('t2'), { title: 'Review the PR', done: false, $type: 'Task' });

// A change behind this node's back is a conflict the server wins.
await replication.cancel();
const options = {
  pull: {
    query: 'query { pullTasks }',
    variables: (checkpoint, batchSize) => ({ since: checkpoint, limit: batchSize }),
    read: (data) => data.pullTasks,
  },
  push: { query: 'mutation { pushTasks }', variables: (rows) => ({ rows }), read: (data) => data.pushTasks.conflicts },
};

// #region request
const client = { request: async (query, variables) => server.execute(query, variables).data }; // e.g. graphql-request
const viaClient = graphql({
  request: (query, variables) => client.request(query, variables), // answers the `data`
  pull: options.pull,
  push: options.push,
});
// #endregion request
const quiet = replicate(board, { name: 'graphql', collection: 'Task', live: false, ...viaClient });
await quiet.awaitInitialReplication();
server.save('t1', { title: 'Plan the sprint on Monday', done: false });
await board.Task.update('t1', { done: true });
await quiet.awaitInSync();
assert.deepEqual(await board.Task.get('t1'), { title: 'Plan the sprint on Monday', done: false, $type: 'Task' });
assert.deepEqual(server.read('t1'), { title: 'Plan the sprint on Monday', done: false });
assert.equal(quiet.stats().conflicts, 1);
await quiet.cancel();
await board.close();
