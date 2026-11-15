// The Supabase page (docs/guide/replication-supabase.md) shows the regions of this file. The client here is a
// stand-in in memory for `@supabase/supabase-js`: `from(table)` with the builder the adapter speaks (`select`, `or`,
// `order`, `limit`, `eq`, `maybeSingle`, `insert`, `update`) and Realtime's `channel().on().subscribe()`.
// tests/package/docs-examples.test.js runs it from an empty temporary directory.
import assert from 'node:assert/strict';

const waitUntil = async (check) => {
  for (let i = 0; i < 300; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('waitUntil: timed out');
};

const createClient = () => {
  const tables = new Map();
  const channels = new Set();
  const rowsOf = (table) => tables.get(table) ?? tables.set(table, new Map()).get(table);
  // PostgREST's `or` as the adapter writes it: `col.gt."v",and(col.eq."v",key.gt."k")`.
  const orFilter = (text) => {
    const [, col, value, , , key, after] =
      /^(\w+)\.gt\."([^"]*)",and\((\w+)\.eq\."([^"]*)",(\w+)\.gt\."([^"]*)"\)$/.exec(text);
    return (row) => row[col] > value || (row[col] === value && row[key] > after);
  };
  const builder = (table) => {
    const state = { op: 'select', filters: [], orders: [], limit: null, values: null, single: false };
    const run = () => {
      const rows = rowsOf(table);
      const matching = () => [...rows.values()].filter((row) => state.filters.every((test) => test(row)));
      if (state.op === 'insert') {
        if (rows.has(state.values.id)) return { data: null, error: { code: '23505', message: 'duplicate key value' } };
        rows.set(state.values.id, structuredClone(state.values));
      } else if (state.op === 'update') {
        const hit = matching();
        for (const row of hit) rows.set(row.id, { ...row, ...structuredClone(state.values) });
        if (hit.length === 0) return { data: [], error: null };
      }
      if (state.op !== 'select') {
        for (const channel of channels) if (channel.table === table) channel.handler({ eventType: state.op });
        const id = state.values.id ?? matching()[0]?.id;
        return { data: [structuredClone(rows.get(id))], error: null };
      }
      let out = matching();
      out.sort((a, b) => {
        for (const { column, ascending } of state.orders) {
          if (a[column] !== b[column]) return (a[column] < b[column] ? -1 : 1) * (ascending ? 1 : -1);
        }
        return 0;
      });
      if (state.limit !== null) out = out.slice(0, state.limit);
      return { data: structuredClone(state.single ? (out[0] ?? null) : out), error: null };
    };
    const api = {
      select: () => api,
      insert: (values) => Object.assign(state, { op: 'insert', values }) && api,
      update: (values) => Object.assign(state, { op: 'update', values }) && api,
      eq: (column, value) => state.filters.push((row) => row[column] === value) && api,
      or: (text) => state.filters.push(orFilter(text)) && api,
      order: (column, { ascending = true } = {}) => state.orders.push({ column, ascending }) && api,
      limit: (n) => Object.assign(state, { limit: n }) && api,
      maybeSingle: () => Object.assign(state, { single: true }) && api,
      then: (resolve, reject) => Promise.resolve().then(run).then(resolve, reject),
    };
    return api;
  };
  return {
    from: (table) => builder(table),
    channel(name) {
      const channel = {
        name,
        on(_kind, { table }, handler) {
          Object.assign(channel, { table, handler });
          return channel;
        },
        subscribe(status) {
          channels.add(channel);
          status?.('SUBSCRIBED');
          return channel;
        },
      };
      return channel;
    },
    removeChannel: (channel) => channels.delete(channel),
    read: (table, id) => structuredClone(rowsOf(table).get(id) ?? null),
    get channels() {
      return channels.size;
    },
  };
};

const client = createClient();
await client
  .from('tasks')
  .insert({ id: 't1', title: 'Plan the sprint', done: false, deleted: false, updated_at: new Date().toISOString() });

// #region replicate
import { createDatabase } from '@alexify/syncom/all';
import { replicate } from '@alexify/syncom/connector';
import { supabase } from '@alexify/syncom/connector/supabase';

// const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY); // from '@supabase/supabase-js'
const board = await createDatabase({ path: 'board', schema: { entities: { Task: {} } } });

const replication = replicate(board, {
  name: 'supabase',
  collection: 'Task',
  ...supabase({ client, table: 'tasks' }),
});
await replication.awaitInitialReplication();
// #endregion replicate
assert.deepEqual(await board.Task.get('t1'), { title: 'Plan the sprint', done: false, $type: 'Task' });
assert.equal(client.channels, 1, 'the Realtime channel is open');

// #region use
const task = await board.Task.insert({ title: 'Write the docs', done: false });
await replication.awaitInSync();
console.log(client.read('tasks', task.id));
// { title: 'Write the docs', done: false, id: '…', deleted: false, updated_at: '2026-11-15T09:30:00.000Z' }
// #endregion use
assert.deepEqual((({ title, done, deleted }) => ({ title, done, deleted }))(client.read('tasks', task.id)), {
  title: 'Write the docs',
  done: false,
  deleted: false,
});

// #region other-writer
// Another client of the table sets `updated_at` on every write and deletes by flagging the row.
await client.from('tasks').update({ deleted: true, updated_at: new Date().toISOString() }).eq('id', 't1');
await client
  .from('tasks')
  .insert({ id: 't2', title: 'Review the PR', done: false, deleted: false, updated_at: new Date().toISOString() });
// #endregion other-writer
await waitUntil(async () => (await board.Task.get('t2')) !== null && (await board.Task.get('t1')) === null);
assert.deepEqual(await board.Task.get('t2'), { title: 'Review the PR', done: false, $type: 'Task' });

await board.Task.delete(task.id);
await replication.awaitInSync();
assert.equal(client.read('tasks', task.id).deleted, true);
await replication.cancel();
assert.equal(client.channels, 0, 'cancel() removes the channel');

// A row changed while this node's edit waits: the update matches no `updated_at`, the table wins.
const quiet = replicate(board, {
  name: 'supabase',
  collection: 'Task',
  live: false,
  ...supabase({ client, table: 'tasks' }),
});
await quiet.awaitInitialReplication();
await new Promise((resolve) => setTimeout(resolve, 2));
await client
  .from('tasks')
  .update({ title: 'Review the PR today', updated_at: new Date().toISOString() })
  .eq('id', 't2');
await board.Task.update('t2', { done: true });
await quiet.awaitInSync();
assert.deepEqual(await board.Task.get('t2'), { title: 'Review the PR today', done: false, $type: 'Task' });
assert.equal(quiet.stats().conflicts, 1);
await quiet.cancel();

// #region columns
const custom = supabase({
  client,
  table: 'todos',
  primaryKey: 'todo_id',
  modifiedColumn: 'modified_at',
  deletedColumn: 'is_deleted',
  stream: false, // no Realtime: the connector pulls every `retryTime`
});
// #endregion columns
assert.equal(custom.pull.stream, undefined);
await board.close();
