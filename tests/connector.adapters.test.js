'use strict';

// The adapters beside the connector — CouchDB, GraphQL, MongoDB, Supabase —
// each over a fake of its backend: one scenario for every one. A local write
// reaches the backend without the collection's mark, the backend's write
// reaches the collection, a change made behind the adapter's back is a
// conflict the backend wins, a deletion goes both ways, and a connector
// started anew resumes.

const test = require('node:test');
const assert = require('node:assert');
const syncom = require('../src/all/all.js');
const { replicate } = require('../src/connector/connector.js');
const { couchdb } = require('../src/connector/couchdb.js');
const { graphql } = require('../src/connector/graphql.js');
const { mongodb } = require('../src/connector/mongodb.js');
const { supabase } = require('../src/connector/supabase.js');
const { createFakeCouch } = require('./utils/fake-couch.js');
const { createFakeGraphQL } = require('./utils/fake-graphql.js');
const { createFakeMongo } = require('./utils/fake-mongo.js');
const { createFakeSupabase } = require('./utils/fake-supabase.js');
const { waitUntil } = require('./utils/mesh.js');

const schema = { entities: { Task: {} } };
const engine = syncom.memoryEngine();

// One scenario over a backend: `handlers()` makes a fresh adapter (its own memory of revisions), `write`/`read`
// are the backend's own door, `stream` says whether the adapter has a live half.
const scenario = async (t, title, { handlers, write, read, stream = true }) => {
  await t.test(title, async (t2) => {
    const open = async (name) => {
      const db = await syncom.createDatabase({ engine, path: `${t2.name}/${name}`, logger: false, defer: 0, schema });
      t2.after(() => db.close().catch(() => {}));
      return db;
    };
    const a = await open('A');
    const connect = (options = {}) => {
      const replication = replicate(a, { name: 'main', collection: 'Task', ...handlers(), retryTime: 50, ...options });
      t2.after(() => replication.cancel().catch(() => {}));
      return replication;
    };
    // The backend holds a document before the connector comes: pulled at the start.
    write('b1', { title: 'from the backend', n: 1 });
    const replication = connect();
    const errors = [];
    replication.on('error', (error) => errors.push(error));
    await replication.awaitInitialReplication();
    assert.deepStrictEqual(await a.get('b1'), { title: 'from the backend', n: 1, $type: 'Task' });
    // A local write goes out, without the collection's mark.
    const id = await a.insert({ $type: 'Task', title: 'from A', n: 2 });
    await replication.awaitInSync();
    assert.deepStrictEqual(read(id), { title: 'from A', n: 2 });
    // The backend's write comes down the stream, or the next pull.
    write('b2', { title: 'later', n: 3 });
    if (!stream) await replication.reSync();
    await waitUntil(async () => (await a.get('b2')) !== null);
    assert.deepStrictEqual(await a.get('b2'), { title: 'later', n: 3, $type: 'Task' });
    // A local update goes out; a local delete goes out as a deletion.
    await a.Task.update(id, { n: 20 });
    await replication.awaitInSync();
    assert.deepStrictEqual(read(id), { title: 'from A', n: 20 });
    await a.Task.delete(id);
    await replication.awaitInSync();
    assert.strictEqual(read(id), null, 'deleted on the backend');
    // The backend's deletion comes down.
    write('b2', null, { deleted: true });
    if (!stream) await replication.reSync();
    await waitUntil(async () => (await a.get('b2')) === null);
    assert.deepStrictEqual(errors, []);
    await replication.cancel();

    // A change behind a connector's back (no stream: live off), then a local write: the backend wins.
    const quiet = connect({ name: 'quiet', live: false });
    await quiet.awaitInitialReplication();
    const conflicts = [];
    quiet.on('conflict', (event) => conflicts.push(event));
    write('b1', { title: 'changed on the backend', n: 11 });
    await a.Task.update('b1', { n: 12 });
    await quiet.awaitInSync();
    await waitUntil(() => conflicts.length === 1);
    assert.deepStrictEqual(conflicts[0].remote, { title: 'changed on the backend', n: 11 });
    await waitUntil(async () => (await a.get('b1'))?.n === 11);
    assert.deepStrictEqual(await a.get('b1'), { title: 'changed on the backend', n: 11, $type: 'Task' });
    await quiet.awaitInSync();
    assert.deepStrictEqual(read('b1'), { title: 'changed on the backend', n: 11 }, 'nothing of A’s went back');
    await quiet.cancel();

    // A connector started anew: the backend pulled from the checkpoint, the collection pushed from the log.
    write('b3', { title: 'while away', n: 4 });
    const local = await a.insert({ $type: 'Task', title: 'while away too', n: 5 });
    const again = connect({ name: 'main', live: false });
    await again.awaitInitialReplication();
    assert.deepStrictEqual(await a.get('b3'), { title: 'while away', n: 4, $type: 'Task' });
    assert.deepStrictEqual(read(local), { title: 'while away too', n: 5 });
    assert.deepStrictEqual(again.errors, []);
  });
};

test('Connector adapters', async (t) => {
  await t.test(
    'CouchDB: _changes with the documents pulled, a long poll streamed, _bulk_docs with the revisions seen pushed, a conflict read back',
    async (t2) => {
      const couch = createFakeCouch();
      await scenario(t2, 'over _changes, _bulk_docs and a long poll', {
        handlers: () => couchdb({ url: 'https://couch.test/db', fetch: couch.fetch, longpoll: 200 }),
        write: (id, data, options) => couch.write(id, data, options),
        read: (id) => couch.read(id),
      });
      await t2.test('the options are checked; a failing request is an error with its status', async () => {
        assert.throws(() => couchdb({}), { name: 'TypeError', message: /url is required/ });
        assert.throws(() => couchdb({ url: 'x', fetch: 7 }), { name: 'TypeError' });
        assert.throws(() => couchdb({ url: 'x', longpoll: 0 }), { name: 'TypeError' });
        const down = couchdb({
          url: 'https://couch.test/db',
          fetch: async () => ({ ok: false, status: 503, text: async () => 'busy' }),
        });
        await assert.rejects(() => down.pull.handler(null, 10), {
          status: 503,
          message: /_changes answered 503: busy/,
        });
        await assert.rejects(() => down.push.handler([{ id: 'x', data: {}, deleted: false, assumed: null }]), {
          status: 503,
        });
        const adapter = couchdb({ url: 'https://couch.test/db/', fetch: couch.fetch });
        assert.strictEqual(adapter.revisionOf('b1'), undefined);
        await adapter.pull.handler(null, 100);
        assert.match(adapter.revisionOf('b1'), /^\d+-/);
      });
    },
  );

  await t.test(
    'GraphQL: the application’s queries posted, their answers read by its functions, its subscription the stream',
    async (t2) => {
      const endpoint = createFakeGraphQL();
      const handlers = () => {
        // The schema is the application's: so is the memory of the revisions a compare-and-set needs.
        const revs = new Map();
        const learn = (doc) => {
          if (doc.rev === null || doc.rev === undefined) revs.delete(doc.id);
          else revs.set(doc.id, doc.rev);
          return { id: doc.id, data: doc.data, deleted: doc.deleted };
        };
        return graphql({
          url: 'https://gql.test/graphql',
          fetch: endpoint.fetch,
          pull: {
            query:
              'query pullTasks($since: Int, $limit: Int!) { pullTasks(since: $since, limit: $limit) { documents { id data deleted rev } checkpoint } }',
            variables: (checkpoint, limit) => ({ since: checkpoint, limit }),
            read: (data) => ({ documents: data.pullTasks.documents.map(learn), checkpoint: data.pullTasks.checkpoint }),
          },
          push: {
            query:
              'mutation pushTasks($rows: [TaskInput!]!) { pushTasks(rows: $rows) { conflicts { id data deleted rev } written { id rev } } }',
            variables: (rows) => ({
              rows: rows.map((row) => ({
                id: row.id,
                data: row.data,
                deleted: row.deleted,
                assumedRev: revs.get(row.id) ?? null,
              })),
            }),
            read: (data) => {
              for (const { id, rev } of data.pushTasks.written) revs.set(id, rev);
              return data.pushTasks.conflicts.map(learn);
            },
          },
          stream: (emit) =>
            endpoint.subscribe((page) => emit({ documents: page.documents.map(learn), checkpoint: page.checkpoint })),
        });
      };
      await scenario(t2, 'over the application’s own queries', {
        handlers,
        write: (id, data, options) => endpoint.write(id, data, options),
        read: (id) => endpoint.read(id),
      });
      await t2.test(
        'the options are checked; errors in the answer are a failure; request() stands in for fetch',
        async () => {
          const pull = {
            query: 'query q($limit: Int) { q(limit: $limit) }',
            variables: (checkpoint, limit) => ({ limit }),
            read: (data) => data.q,
          };
          assert.throws(() => graphql({ pull }), { name: 'TypeError', message: /url or request/ });
          assert.throws(() => graphql({ url: 'x' }), { name: 'TypeError', message: /a pull, a push, or both/ });
          assert.throws(() => graphql({ url: 'x', pull: { query: 'q' } }), { name: 'TypeError', message: /variables/ });
          assert.throws(() => graphql({ url: 'x', pull, stream: 7 }), { name: 'TypeError', message: /stream/ });
          assert.throws(() => graphql({ request: 7, pull }), { name: 'TypeError', message: /request/ });
          const erring = graphql({
            url: 'x',
            fetch: endpoint.fetch,
            pull: { query: 'query nope { nope }', variables: () => ({}), read: (d) => d },
          });
          await assert.rejects(() => erring.pull.handler(null, 10), { message: /GraphQL errors: Unknown operation/ });
          const failing = graphql({ url: 'x', fetch: async () => ({ ok: false, status: 500 }), pull });
          await assert.rejects(() => failing.pull.handler(null, 10), { message: /answered 500/ });
          const own = graphql({
            request: async (query, variables) => ({ q: { documents: [], checkpoint: variables.limit } }),
            pull,
          });
          assert.deepStrictEqual(await own.pull.handler(null, 7), { documents: [], checkpoint: 7 });
          const pushOnly = graphql({
            request: async () => ({ p: null }),
            push: { query: 'mutation p { p }', variables: (rows) => ({ rows }), read: (d) => d.p },
          });
          assert.deepStrictEqual(await pushOnly.push.handler([]), [], 'no conflicts answered is none');
        },
      );
    },
  );

  await t.test(
    'MongoDB: the driver’s collection, _rev the compare-and-set, _updated the position, a change stream the signal',
    async (t2) => {
      const client = createFakeMongo();
      const collection = client.db('app').collection('tasks');
      const now = () => Date.now();
      const write = async (id, data, { deleted = false } = {}) => {
        const held = await collection.findOne({ _id: id });
        const doc = { _id: id, _rev: (held?._rev ?? 0) + 1, _updated: now(), ...(deleted ? { _deleted: true } : data) };
        await collection.replaceOne({ _id: id }, doc, { upsert: true });
      };
      const read = (id) => {
        const doc = collection.docs.get(id);
        if (doc === undefined || doc._deleted === true) return null;
        const { _id, _rev, _updated, ...data } = doc;
        return data;
      };
      // The fake's writes are synchronous enough to read back at once: the scenario reads after the connector settled.
      await scenario(t2, 'over the driver’s collection, _rev as the compare-and-set, a change stream as the signal', {
        handlers: () => mongodb({ collection }),
        write: (id, data, options) => {
          write(id, data, options);
        },
        read,
      });
      await t2.test(
        'the options are checked; without change streams there is no stream; a collision on insert is a conflict',
        async () => {
          assert.throws(() => mongodb({}), { name: 'TypeError', message: /collection/ });
          assert.throws(() => mongodb({ collection, changes: 'yes' }), { name: 'TypeError' });
          const plain = mongodb({ collection, changes: false });
          assert.strictEqual(plain.pull.stream, undefined);
          const other = client.db('app').collection('other');
          await other.replaceOne(
            { _id: 'taken' },
            { _id: 'taken', _rev: 3, _updated: 1, title: 'theirs' },
            { upsert: true },
          );
          const adapter = mongodb({ collection: other, changes: false });
          const conflicts = await adapter.push.handler([
            { id: 'taken', data: { title: 'mine' }, deleted: false, assumed: null },
          ]);
          assert.deepStrictEqual(conflicts, [{ id: 'taken', data: { title: 'theirs' } }]);
          assert.strictEqual(adapter.revisionOf('taken'), 3);
          assert.deepStrictEqual(
            await adapter.push.handler([{ id: 'taken', data: { title: 'mine' }, deleted: false, assumed: null }]),
            [],
          );
          assert.strictEqual(adapter.revisionOf('taken'), 4);
        },
      );
    },
  );

  await t.test(
    'Supabase: PostgREST with the modified column as the compare-and-set, Realtime the signal',
    async (t2) => {
      const client = createFakeSupabase();
      await scenario(t2, 'over PostgREST and Realtime, the modified column as the compare-and-set', {
        handlers: () => supabase({ client, table: 'tasks', now: client.stamp }),
        write: (id, data, options = {}) =>
          client.write('tasks', { id, ...(options.deleted ? {} : data) }, { deleted: options.deleted === true }),
        read: (id) => {
          const row = client.read('tasks', id);
          if (row === null || row.deleted === true) return null;
          const { id: _, updated_at, deleted, ...data } = row;
          return data;
        },
      });
      await t2.test(
        'the options are checked; a client without channels has no stream; an error answer is a failure',
        async () => {
          assert.throws(() => supabase({ table: 'x' }), { name: 'TypeError', message: /client/ });
          assert.throws(() => supabase({ client }), { name: 'TypeError', message: /table/ });
          assert.throws(() => supabase({ client, table: 'x', primaryKey: '' }), {
            name: 'TypeError',
            message: /primaryKey/,
          });
          assert.throws(() => supabase({ client, table: 'x', stream: 'yes' }), { name: 'TypeError' });
          const plain = supabase({ client: { from: client.from }, table: 'tasks' });
          assert.strictEqual(plain.pull.stream, undefined);
          const erring = supabase({
            client: {
              from: () => ({
                select: () => ({
                  gt: () => ({
                    order: () => ({ limit: () => ({ then: (r) => r({ data: null, error: { message: 'nope' } }) }) }),
                  }),
                  order: () => ({ limit: () => ({ then: (r) => r({ data: null, error: { message: 'nope' } }) }) }),
                }),
              }),
            },
            table: 'tasks',
          });
          await assert.rejects(() => erring.pull.handler(null, 10), { message: /Supabase select failed: nope/ });
          const adapter = supabase({ client, table: 'tasks', now: client.stamp });
          assert.strictEqual(adapter.stampOf('b1'), undefined);
          await adapter.pull.handler(null, 100);
          assert.strictEqual(typeof adapter.stampOf('b1'), 'string');
        },
      );
    },
  );
});
