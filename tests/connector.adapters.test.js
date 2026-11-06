'use strict';

// The adapters beside the connector — CouchDB, GraphQL, MongoDB, Supabase,
// Firestore, Appwrite, Google Drive, OneDrive — each over a fake of its backend: one scenario for every one. A local write
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
const { firestore } = require('../src/connector/firestore.js');
const { appwrite } = require('../src/connector/appwrite.js');
const { gdrive } = require('../src/connector/gdrive.js');
const { onedrive } = require('../src/connector/onedrive.js');
const { jsonFile, RETRIES } = require('../src/connector/jsonfile.js');
const { createFakeCouch } = require('./utils/fake-couch.js');
const { createFakeGraphQL } = require('./utils/fake-graphql.js');
const { createFakeMongo } = require('./utils/fake-mongo.js');
const { createFakeSupabase } = require('./utils/fake-supabase.js');
const { createFakeFirestore } = require('./utils/fake-firestore.js');
const { createFakeAppwrite, AppwriteException } = require('./utils/fake-appwrite.js');
const { createFakeDrive, createFakeGraph } = require('./utils/fake-drive.js');
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
  await t.test(
    'Firestore: the server stamp and the tombstone the adapter’s fields, a cursor after the checkpoint, one transaction a push, onSnapshot the signal',
    async (t2) => {
      const fake = createFakeFirestore();
      const options = () => ({ sdk: fake.sdk, database: fake.database, collection: fake.collection });
      await scenario(t2, 'over the modular SDK', {
        handlers: () => firestore(options()),
        write: (id, data, o) => fake.write(id, data, o),
        read: (id) => fake.read(id),
      });
      await t2.test(
        'the options are checked; without onSnapshot no stream; a pending stamp waits; a transaction run again begins afresh',
        async () => {
          assert.throws(() => firestore({}), { name: 'TypeError', message: /sdk/ });
          assert.throws(() => firestore({ ...options(), sdk: { ...fake.sdk, getDocs: 1 } }), {
            name: 'TypeError',
            message: /getDocs/,
          });
          assert.throws(() => firestore({ ...options(), sdk: { ...fake.sdk, Timestamp: {} } }), {
            name: 'TypeError',
            message: /Timestamp/,
          });
          assert.throws(() => firestore({ sdk: fake.sdk, collection: fake.collection }), {
            name: 'TypeError',
            message: /database/,
          });
          assert.throws(() => firestore({ sdk: fake.sdk, database: fake.database }), {
            name: 'TypeError',
            message: /collection/,
          });
          assert.throws(() => firestore({ ...options(), stampField: '' }), {
            name: 'TypeError',
            message: /stampField/,
          });
          assert.throws(() => firestore({ ...options(), deletedField: 7 }), {
            name: 'TypeError',
            message: /deletedField/,
          });
          assert.throws(() => firestore({ ...options(), stream: 'yes' }), { name: 'TypeError', message: /stream/ });
          const { onSnapshot, waitForPendingWrites, ...lean } = fake.sdk;
          assert.throws(() => firestore({ ...options(), sdk: lean }), { name: 'TypeError', message: /onSnapshot/ });
          assert.strictEqual(firestore({ ...options(), sdk: lean, stream: false }).pull.stream, undefined);
          // A pending stamp (the SDK's own write not yet on the server) is left to the next pull.
          const own = createFakeFirestore();
          own.write('p1', { title: 'pending' }, { pending: true });
          own.write('p2', { title: 'landed' });
          const adapter = firestore({ sdk: own.sdk, database: own.database, collection: own.collection });
          const page = await adapter.pull.handler(null, 10);
          assert.deepStrictEqual(page.documents, [{ id: 'p2', data: { title: 'landed' } }]);
          assert.strictEqual(page.checkpoint.id, 'p2');
          assert.strictEqual(own.pendingWaits, 1);
          assert.deepStrictEqual(await adapter.pull.handler(page.checkpoint, 10), {
            documents: [],
            checkpoint: page.checkpoint,
          });
          // A document written between a transaction's reads and its commit: Firestore runs it again, and the second run sees it.
          own.race = () => own.write('p2', { title: 'changed meanwhile' });
          own.attempts = 0;
          let conflicts = await adapter.push.handler([
            { id: 'p2', data: { title: 'mine' }, deleted: false, assumed: { title: 'landed' } },
          ]);
          assert.strictEqual(own.attempts, 2);
          assert.deepStrictEqual(conflicts, [{ id: 'p2', data: { title: 'changed meanwhile' } }]);
          assert.deepStrictEqual(own.read('p2'), { title: 'changed meanwhile' });
          // A row that assumes nothing of a document that is there is a conflict; one that assumes nothing of a tombstone is written.
          own.write('p3', { title: 'there' });
          own.write('p4', null, { deleted: true });
          conflicts = await adapter.push.handler([
            { id: 'p3', data: { title: 'new' }, deleted: false, assumed: null },
            { id: 'p4', data: { title: 'back' }, deleted: false, assumed: null },
          ]);
          assert.deepStrictEqual(conflicts, [{ id: 'p3', data: { title: 'there' } }]);
          assert.deepStrictEqual(own.read('p4'), { title: 'back' });
          // The stream says RESYNC for a confirmed change, and nothing after it is stopped.
          const signals = [];
          const stop = adapter.pull.stream((signal) => signals.push(signal));
          await new Promise((resolve) => setTimeout(resolve, 5));
          own.write('p5', { title: 'live' });
          assert.ok(signals.length >= 2 && signals.every((s) => s === 'RESYNC'));
          stop();
          const count = signals.length;
          own.write('p6', { title: 'after' });
          await new Promise((resolve) => setTimeout(resolve, 5));
          assert.strictEqual(signals.length, count);
        },
      );
    },
  );

  await t.test(
    'Appwrite: $updatedAt the position, a boolean attribute the tombstone, a read then a write the push, Realtime the signal',
    async (t2) => {
      const fake = createFakeAppwrite();
      const options = () => ({
        client: fake.client,
        databases: fake.databases,
        Query: fake.Query,
        databaseId: 'db',
        collectionId: 'tasks',
      });
      await scenario(t2, 'over the Databases service', {
        handlers: () => appwrite(options()),
        write: (id, data, o) => fake.write(id, data, o),
        read: (id) => fake.read(id),
      });
      await t2.test(
        'the options are checked; without a client no stream; made or taken away between the read and the write is a conflict; another failure is thrown',
        async () => {
          assert.throws(() => appwrite({}), { name: 'TypeError', message: /databases/ });
          assert.throws(() => appwrite({ ...options(), databases: { ...fake.databases, getDocument: 1 } }), {
            name: 'TypeError',
            message: /getDocument/,
          });
          assert.throws(() => appwrite({ ...options(), Query: undefined }), { name: 'TypeError', message: /Query/ });
          assert.throws(() => appwrite({ ...options(), Query: { ...fake.Query, or: 1 } }), {
            name: 'TypeError',
            message: /Query\.or/,
          });
          assert.throws(() => appwrite({ ...options(), databaseId: '' }), { name: 'TypeError', message: /databaseId/ });
          assert.throws(() => appwrite({ ...options(), collectionId: undefined }), {
            name: 'TypeError',
            message: /collectionId/,
          });
          assert.throws(() => appwrite({ ...options(), deletedField: 3 }), {
            name: 'TypeError',
            message: /deletedField/,
          });
          assert.throws(() => appwrite({ ...options(), stream: 1 }), { name: 'TypeError', message: /stream/ });
          assert.throws(() => appwrite({ ...options(), client: {} }), { name: 'TypeError', message: /subscribe/ });
          assert.strictEqual(appwrite({ ...options(), client: null }).pull.stream, undefined);
          assert.strictEqual(appwrite({ ...options(), stream: false }).pull.stream, undefined);
          const own = createFakeAppwrite();
          const adapter = appwrite({ ...options(), client: own.client, databases: own.databases });
          // Made between the read and the create: 409, the document as it stands.
          own.race = () => own.write('a1', { title: 'first' });
          let conflicts = await adapter.push.handler([
            { id: 'a1', data: { title: 'mine' }, deleted: false, assumed: null },
          ]);
          assert.deepStrictEqual(conflicts, [{ id: 'a1', data: { title: 'first' } }]);
          // Taken away between the read and the update: 404, a deletion.
          own.race = () => own.remove('a1');
          conflicts = await adapter.push.handler([
            { id: 'a1', data: { title: 'mine' }, deleted: false, assumed: { title: 'first' } },
          ]);
          assert.deepStrictEqual(conflicts, [{ id: 'a1', deleted: true }]);
          // A row that assumes nothing of a tombstone is written; one that assumes nothing of a document there is a conflict.
          own.write('a2', null, { deleted: true });
          own.write('a3', { title: 'there' });
          conflicts = await adapter.push.handler([
            { id: 'a2', data: { title: 'back' }, deleted: false, assumed: null },
            { id: 'a3', data: { title: 'new' }, deleted: false, assumed: null },
          ]);
          assert.deepStrictEqual(conflicts, [{ id: 'a3', data: { title: 'there' } }]);
          assert.deepStrictEqual(own.read('a2'), { title: 'back' });
          // A pull: the documents in the order they were updated, then nothing after the checkpoint.
          const page = await adapter.pull.handler(null, 10);
          assert.deepStrictEqual(
            page.documents.map((d) => d.id),
            ['a3', 'a2'],
          );
          assert.deepStrictEqual(page.checkpoint, { updatedAt: own.docs.get('a2').$updatedAt, id: 'a2' });
          assert.deepStrictEqual(await adapter.pull.handler(page.checkpoint, 10), {
            documents: [],
            checkpoint: page.checkpoint,
          });
          // Another failure is the connector's to retry.
          const erring = appwrite({
            ...options(),
            client: null,
            databases: {
              ...own.databases,
              updateDocument: async () => {
                throw new AppwriteException(500, 'boom');
              },
            },
          });
          await assert.rejects(
            () =>
              erring.push.handler([{ id: 'a3', data: { title: 'x' }, deleted: false, assumed: { title: 'there' } }]),
            {
              name: 'AppwriteException',
              code: 500,
            },
          );
        },
      );
    },
  );

  await t.test(
    'Google Drive: one JSON file of the collection in the application data folder, its ETag the compare-and-set, probed for the stream',
    async (t2) => {
      const drive = createFakeDrive();
      await scenario(t2, 'over the Drive API', {
        handlers: () => gdrive({ fetch: drive.fetch, token: 't', name: 'tasks.json', poll: 10 }),
        write: (id, data, o) => drive.write(id, data, o),
        read: (id) => drive.read(id),
      });
      await t2.test(
        'the options are checked; no file is none, made at the first push; by fileId no search; the ETag from the header alone; a failing request is an error with its status',
        async () => {
          assert.throws(() => gdrive({ fetch: 1, name: 'x' }), { name: 'TypeError', message: /Google Drive: fetch/ });
          assert.throws(() => gdrive({ fetch: drive.fetch }), { name: 'TypeError', message: /name or fileId/ });
          assert.throws(() => gdrive({ fetch: drive.fetch, name: 'x', token: 5 }), {
            name: 'TypeError',
            message: /token/,
          });
          const fresh = createFakeDrive({ name: "it's.json" });
          const adapter = gdrive({ fetch: fresh.fetch, headers: { authorization: 'Bearer h' }, name: "it's.json" });
          assert.strictEqual(adapter.pull.stream, undefined);
          assert.deepStrictEqual(await adapter.pull.handler(null, 10), { documents: [], checkpoint: 0 });
          assert.strictEqual(adapter.fileId(), null);
          assert.deepStrictEqual(
            await adapter.push.handler([{ id: 'd1', data: { a: 1 }, deleted: false, assumed: null }]),
            [],
          );
          assert.match(adapter.fileId(), /^f\d+$/);
          assert.deepStrictEqual(fresh.read('d1'), { a: 1 });
          assert.strictEqual(adapter.positionOf('d1'), 1);
          const byId = gdrive({ fetch: fresh.fetch, token: 't', fileId: adapter.fileId() });
          fresh.calls.length = 0;
          assert.deepStrictEqual((await byId.pull.handler(0, 10)).documents, [{ id: 'd1', data: { a: 1 } }]);
          assert.ok(!fresh.calls.includes('GET /drive/v3/files'));
          fresh.etagInHeader = true;
          fresh.write('d2', { b: 2 });
          assert.deepStrictEqual((await byId.pull.handler(1, 10)).documents, [{ id: 'd2', data: { b: 2 } }]);
          assert.deepStrictEqual(
            await byId.push.handler([{ id: 'd2', data: { b: 3 }, deleted: false, assumed: { b: 2 } }]),
            [],
          );
          assert.deepStrictEqual(fresh.read('d2'), { b: 3 });
          const down = gdrive({ fetch: async () => ({ ok: false, status: 503, text: async () => 'busy' }), name: 'x' });
          await assert.rejects(() => down.pull.handler(null, 10), {
            status: 503,
            message: /Google Drive files\.list answered 503: busy/,
          });
        },
      );
    },
  );

  await t.test(
    'OneDrive: one JSON file of the collection in the drive through Graph, its eTag the compare-and-set',
    async (t2) => {
      const graph = createFakeGraph();
      await scenario(t2, 'over Microsoft Graph', {
        handlers: () => onedrive({ fetch: graph.fetch, token: 't', path: 'syncom/tasks.json', poll: 10 }),
        write: (id, data, o) => graph.write(id, data, o),
        read: (id) => graph.read(id),
      });
      await t2.test(
        'the options are checked; no file is none, made at the first push; a failing request is an error with its status',
        async () => {
          assert.throws(() => onedrive({ fetch: 1, path: 'x' }), { name: 'TypeError', message: /OneDrive: fetch/ });
          assert.throws(() => onedrive({ fetch: graph.fetch }), { name: 'TypeError', message: /path/ });
          assert.throws(() => onedrive({ fetch: graph.fetch, path: 'x', token: 5 }), {
            name: 'TypeError',
            message: /token/,
          });
          const fresh = createFakeGraph({ path: 'a b/c.json' });
          const adapter = onedrive({
            fetch: fresh.fetch,
            headers: { authorization: 'Bearer h' },
            path: 'a b/c.json',
            drive: '/me/drive/',
          });
          assert.strictEqual(adapter.pull.stream, undefined);
          assert.deepStrictEqual(await adapter.pull.handler(null, 10), { documents: [], checkpoint: 0 });
          assert.deepStrictEqual(
            await adapter.push.handler([{ id: 'd1', data: { a: 1 }, deleted: false, assumed: null }]),
            [],
          );
          assert.deepStrictEqual(fresh.read('d1'), { a: 1 });
          assert.strictEqual(adapter.positionOf('d1'), 1);
          const down = onedrive({
            fetch: async () => ({ ok: false, status: 503, text: async () => 'busy' }),
            path: 'x',
          });
          await assert.rejects(() => down.pull.handler(null, 10), {
            status: 503,
            message: /OneDrive item answered 503: busy/,
          });
        },
      );
    },
  );

  await t.test(
    'a collection file: a file that is no collection is refused, never overwritten; a 412 is tried RETRIES times; no probe, no stream',
    async () => {
      assert.throws(() => jsonFile({}), { name: 'TypeError', message: /load/ });
      assert.throws(() => jsonFile({ load() {}, save() {} }, { poll: -1 }), { name: 'TypeError', message: /poll/ });
      const broken = jsonFile({
        load: async () => ({ etag: '"1"', text: 'not json' }),
        save: async () => ({ etag: '"2"' }),
      });
      await assert.rejects(() => broken.pull.handler(null, 10), { message: /not JSON/ });
      const shaped = jsonFile({
        load: async () => ({ etag: '"1"', text: '[1]' }),
        save: async () => ({ etag: '"2"' }),
      });
      await assert.rejects(() => shaped.push.handler([{ id: 'x', data: {}, deleted: false, assumed: null }]), {
        message: /collection file/,
      });
      let saves = 0;
      const contended = jsonFile({
        load: async () => null,
        save: async () => {
          saves++;
          const error = new Error('412');
          error.status = 412;
          throw error;
        },
      });
      await assert.rejects(() => contended.push.handler([{ id: 'x', data: { a: 1 }, deleted: false, assumed: null }]), {
        status: 412,
      });
      assert.strictEqual(saves, RETRIES + 1);
      const other = jsonFile({
        load: async () => null,
        save: async () => {
          throw new Error('boom');
        },
      });
      await assert.rejects(() => other.push.handler([{ id: 'x', data: { a: 1 }, deleted: false, assumed: null }]), {
        message: 'boom',
      });
      assert.strictEqual(
        jsonFile({ load: async () => null, save: async () => ({ etag: null }) }, { poll: 10 }).pull.stream,
        undefined,
      );
      // Nothing to write: nothing saved; a probe that fails is the next probe's business.
      let probes = 0;
      const store = {
        load: async () => null,
        save: async () => {
          throw new Error('never');
        },
        probe: async () => {
          probes++;
          throw new Error('down');
        },
      };
      const idle = jsonFile(store, { poll: 5 });
      assert.deepStrictEqual(
        await idle.push.handler([{ id: 'x', data: { a: 1 }, deleted: false, assumed: { a: 0 } }]),
        [{ id: 'x', deleted: true }],
      );
      const signals = [];
      const stop = idle.pull.stream((s) => signals.push(s));
      await new Promise((resolve) => setTimeout(resolve, 30));
      stop();
      assert.ok(probes >= 2);
      assert.deepStrictEqual(signals, []);
      // A probe that moved says RESYNC; one that did not is quiet, and the pull reads nothing again.
      let etag = '"a"';
      let loads = 0;
      const text = JSON.stringify({ seq: 1, docs: { y: { n: 1, data: { b: 1 } } } });
      const live = jsonFile(
        {
          load: async () => {
            loads++;
            return { etag, text };
          },
          save: async () => ({ etag }),
          probe: async () => etag,
        },
        { poll: 5 },
      );
      assert.deepStrictEqual((await live.pull.handler(null, 10)).documents, [{ id: 'y', data: { b: 1 } }]);
      await live.pull.handler(1, 10);
      assert.strictEqual(loads, 1);
      const seen = [];
      const off = live.pull.stream((s) => seen.push(s));
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.deepStrictEqual(seen, []);
      etag = '"b"';
      await new Promise((resolve) => setTimeout(resolve, 20));
      off();
      assert.ok(seen.length >= 1);
      assert.strictEqual(live.positionOf('y'), 1);
      assert.strictEqual(live.positionOf('z'), undefined);
    },
  );
});
