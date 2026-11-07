'use strict';

// Connectors: a collection kept in step with a backend of its own through
// pull and push handlers — what comes in lands as this node's writes and
// reaches its peers, what this node (or a peer) writes goes out, an echo makes
// no op, a conflict is the backend's to win, a restart resumes from the
// checkpoint, a failing handler is tried again.

const test = require('node:test');
const assert = require('node:assert');
const syncom = require('../src/all/all.js');
const { replicate, Replication } = require('../src/connector/connector.js');
const { createFakeBackend } = require('./utils/fake-backend.js');
const { createMesh, settle, waitUntil } = require('./utils/mesh.js');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const schema = { entities: { Task: {}, Note: {} } };

test('Connectors', async (t) => {
  const engine = syncom.memoryEngine();
  const open = async (t2, name, options = {}) => {
    const db = await syncom.createDatabase({
      engine,
      path: `${t2.name}/${name}`,
      logger: false,
      defer: 0,
      schema,
      ...options,
    });
    t2.after(() => db.close().catch(() => {}));
    return db;
  };
  const connect = (t2, db, backend, options = {}) => {
    const replication = replicate(db, {
      name: 'main',
      collection: 'Task',
      ...backend.handlers(),
      retryTime: 50,
      ...options,
    });
    t2.after(() => replication.cancel().catch(() => {}));
    return replication;
  };

  await t.test(
    'a pulled document lands as this node’s write and reaches a peer; a local write goes to the backend; an echo makes no op; the checkpoint moves',
    async (t2) => {
      const backend = createFakeBackend();
      backend.write('t1', { title: 'from the backend' });
      backend.write('n1', { note: 'another collection’s' });
      const mesh = await createMesh(t2, ['A', 'B'], [['A', 'B']], open);
      const [a, b] = ['A', 'B'].map((name) => mesh.get(name));
      await a.sync.awaitInitialReplication();
      const received = [];
      const sent = [];
      const replication = connect(t2, a, backend);
      assert.ok(replication instanceof Replication);
      replication.on('received', (event) => received.push(event));
      replication.on('sent', (event) => sent.push(event));
      await replication.awaitInitialReplication();
      assert.deepStrictEqual(
        await a.get('t1'),
        { title: 'from the backend', $type: 'Task' },
        'landed in the collection',
      );
      assert.deepStrictEqual(
        await a.get('n1'),
        { note: 'another collection’s', $type: 'Task' },
        'every pulled document is the collection’s',
      );
      await settle([a, b]);
      assert.deepStrictEqual(
        await b.get('t1'),
        { title: 'from the backend', $type: 'Task' },
        'and at the peer, as an op of A',
      );
      assert.deepStrictEqual(received, [{ documents: 2, applied: 2 }]);
      assert.deepStrictEqual(replication.checkpoint.pull, 2);
      assert.match(replication.checkpoint.pushed, /^[a-z0-9]+\.\d+$/);
      const before = a.log.length;
      // A local write goes out; what the backend's stream then hands back is the same reading: no op.
      const id = await a.insert({ $type: 'Task', title: 'from A' });
      await replication.awaitInSync();
      assert.deepStrictEqual(backend.read(id), { title: 'from A' }, 'without $type');
      assert.deepStrictEqual(sent, [{ rows: 1 }]);
      await sleep(30);
      assert.strictEqual(a.log.length, before + 1, 'the echo of the push made no op');
      // A peer's write is a turn here too, and goes to the backend.
      const fromB = await b.insert({ $type: 'Task', title: 'from B' });
      await settle([a, b]);
      await waitUntil(() => backend.read(fromB) !== null);
      assert.deepStrictEqual(backend.read(fromB), { title: 'from B' });
      // Another collection's record is not the connector's business.
      await a.insert({ $type: 'Note', title: 'not replicated' });
      await replication.awaitInSync();
      assert.strictEqual(backend.docs.size, 4);
      // The backend's own write comes down the stream; a deletion too.
      backend.write('t1', { title: 'changed on the backend' });
      await waitUntil(async () => (await a.get('t1'))?.title === 'changed on the backend');
      backend.write('t1', null, { deleted: true });
      await waitUntil(async () => (await a.get('t1')) === null);
      await settle([a, b]);
      assert.strictEqual(await b.get('t1'), null);
      // A local delete goes out as a deletion.
      await a.Task.delete(id);
      await replication.awaitInSync();
      assert.strictEqual(backend.read(id), null);
      assert.strictEqual(backend.docs.get(id).deleted, true);
      const stats = replication.stats();
      assert.ok(stats.pulled >= 2 && stats.pushed >= 3 && stats.pending === 0, JSON.stringify(stats));
      assert.strictEqual(replication.active, true);
      await replication.cancel();
      assert.strictEqual(replication.canceled, true);
      assert.strictEqual(replication.active, false);
      await replication.cancel();
      assert.throws(() => replication.start(), { code: 'REPLICATION_FAILED' });
    },
  );

  await t.test(
    'a conflict is the backend’s to win — the record is set to its state and both converge — unless resolve says otherwise',
    async (t2) => {
      const backend = createFakeBackend();
      const a = await open(t2, 'A');
      const replication = connect(t2, a, backend);
      const conflicts = [];
      replication.on('conflict', (event) => conflicts.push(event));
      await replication.awaitInitialReplication();
      const id = await a.insert({ $type: 'Task', title: 'v1', n: 1 });
      await replication.awaitInSync();
      // The backend changes behind the connector's back (no stream event: a stale assumption), then A writes.
      backend.set(id, { title: 'backend v2', n: 2 });
      await a.Task.update(id, { title: 'A v2' });
      await replication.awaitInSync();
      await waitUntil(() => conflicts.length === 1);
      assert.deepStrictEqual(conflicts[0].local, { title: 'A v2', n: 1 });
      assert.deepStrictEqual(conflicts[0].remote, { title: 'backend v2', n: 2 });
      assert.deepStrictEqual(conflicts[0].resolved, { title: 'backend v2', n: 2 });
      await waitUntil(async () => (await a.get(id)).title === 'backend v2');
      assert.deepStrictEqual(await a.get(id), { title: 'backend v2', n: 2, $type: 'Task' }, 'the backend won');
      await replication.awaitInSync();
      assert.deepStrictEqual(backend.read(id), { title: 'backend v2', n: 2 }, 'nothing of A’s went back');
      assert.strictEqual(replication.stats().conflicts, 1);

      // With `resolve`, the application decides: here, the local title with the backend's counter.
      await replication.cancel();
      const resolving = connect(t2, a, backend, {
        name: 'resolving',
        resolve: ({ local, remote }) => ({ ...remote, title: local.title }),
      });
      await resolving.awaitInitialReplication();
      backend.set(id, { title: 'backend v3', n: 3 });
      await a.Task.update(id, { title: 'A v3' });
      await waitUntil(() => backend.read(id)?.title === 'A v3' && backend.read(id)?.n === 3, { timeout: 5000 });
      assert.deepStrictEqual(await a.get(id), { title: 'A v3', n: 3, $type: 'Task' });
      assert.deepStrictEqual(backend.read(id), { title: 'A v3', n: 3 }, 'the resolution went back to the backend');
      // `resolve` answering null deletes.
      await resolving.cancel();
      const deleting = connect(t2, a, backend, { name: 'deleting', resolve: () => null });
      await deleting.awaitInitialReplication();
      backend.set(id, { title: 'backend v4', n: 4 });
      await a.Task.update(id, { title: 'A v4' });
      await waitUntil(async () => (await a.get(id)) === null, { timeout: 5000 });
      await deleting.awaitInSync();
      assert.strictEqual(backend.read(id), null);
    },
  );

  await t.test(
    'a restart resumes: the backend pulled from its checkpoint, what the log holds since the push checkpoint pushed; without a checkpoint every record once',
    async (t2) => {
      const backend = createFakeBackend();
      backend.write('t1', { title: 'one' });
      const a = await open(t2, 'A');
      const first = connect(t2, a, backend, { live: false });
      await first.awaitInitialReplication();
      assert.deepStrictEqual((await a.get('t1')).title, 'one');
      await first.cancel();
      // While the connector is off: the backend moves on, this node writes.
      backend.write('t2', { title: 'two' });
      const mine = await a.insert({ $type: 'Task', title: 'mine' });
      const pulls = backend.calls.pull;
      const second = connect(t2, a, backend, { live: false });
      await second.awaitInitialReplication();
      assert.deepStrictEqual((await a.get('t2')).title, 'two', 'pulled from the checkpoint');
      assert.deepStrictEqual(backend.read(mine), { title: 'mine' }, 'pushed from the log since the checkpoint');
      assert.strictEqual(backend.calls.pull - pulls, 1, 'one pull, from the checkpoint');
      await second.cancel();
      // A reopen of the database: the checkpoint is in its kv.
      await a.close();
      const again = await open(t2, 'A');
      const third = connect(t2, again, backend, { live: false });
      await third.awaitInitialReplication();
      assert.deepStrictEqual(third.checkpoint.pull, backend.changes.length);
      await third.cancel();
      // Another name is another checkpoint: every record of the collection pushed once, the backend pulled from the start.
      const fresh = createFakeBackend();
      const rebuilt = connect(t2, again, fresh, { name: 'fresh', live: false });
      await rebuilt.awaitInitialReplication();
      assert.deepStrictEqual(fresh.read(mine), { title: 'mine' });
      assert.deepStrictEqual(fresh.read('t1'), { title: 'one' });
      assert.strictEqual(fresh.docs.size, 3);
    },
  );

  await t.test(
    'a failing handler is told (REPLICATION_FAILED) and tried again after retryTime; nothing is skipped; a malformed document is left out',
    async (t2) => {
      const backend = createFakeBackend();
      const a = await open(t2, 'A');
      const errors = [];
      backend.fail('pull', 1);
      const replication = connect(t2, a, backend, { autoStart: false });
      replication.on('error', (error) => errors.push(error));
      assert.strictEqual(replication.active, false);
      await replication.start();
      await waitUntil(() => errors.length === 1);
      assert.strictEqual(errors[0].code, 'REPLICATION_FAILED');
      assert.strictEqual(errors[0].direction, 'pull');
      assert.strictEqual(errors[0].name, 'main');
      assert.match(errors[0].cause.message, /backend down/);
      assert.strictEqual(replication.errors.length, 1);
      // Tried again after retryTime: the pull goes through.
      backend.write('t1', { title: 'late' });
      await waitUntil(async () => (await a.get('t1')) !== null, { timeout: 5000 });
      backend.fail('push', 2);
      const id = await a.insert({ $type: 'Task', title: 'kept pending' });
      await waitUntil(() => errors.length === 3, { timeout: 5000 });
      assert.strictEqual(errors[2].direction, 'push');
      await waitUntil(() => backend.read(id) !== null, { timeout: 5000 });
      assert.deepStrictEqual(backend.read(id), { title: 'kept pending' }, 'pushed once the backend answered');
      await replication.awaitInSync();
      // A document that is no document (no id, no data) is left out, the rest of the page lands.
      backend.changes.push({ id: 'bad id!', data: {}, deleted: false });
      backend.set('ok', { title: 'fine' });
      backend.changes.push({ id: 'nodata' });
      await replication.reSync();
      assert.deepStrictEqual((await a.get('ok'))?.title, 'fine');
      assert.strictEqual(await a.get('nodata'), null);
    },
  );

  await t.test('without a stream a live connector pulls every retryTime; the options are checked', async (t2) => {
    const backend = createFakeBackend();
    const a = await open(t2, 'A');
    const { pull, push } = backend.handlers();
    const polling = replicate(a, {
      name: 'poll',
      collection: 'Task',
      pull: { handler: pull.handler },
      push,
      retryTime: 30,
    });
    t2.after(() => polling.cancel().catch(() => {}));
    await polling.awaitInitialReplication();
    backend.write('t1', { title: 'polled' });
    await waitUntil(async () => (await a.get('t1')) !== null, { timeout: 5000 });
    await polling.cancel();
    // Pull alone, push alone.
    const pullOnly = replicate(a, { name: 'pull', collection: 'Task', pull, live: false });
    await pullOnly.awaitInitialReplication();
    await pullOnly.cancel();
    const pushOnly = replicate(a, { name: 'push', collection: 'Task', push, live: false });
    await pushOnly.awaitInitialReplication();
    await pushOnly.cancel();
    const bad = (options, message) => assert.throws(() => replicate(a, options), { name: 'TypeError', message });
    bad({ collection: 'Task', pull }, /takes a name/);
    bad({ name: 'x', pull }, /takes a collection/);
    bad({ name: 'x', collection: 'Task' }, /a pull, a push, or both/);
    bad({ name: 'x', collection: 'Task', pull: { handler: 7 } }, /pull.handler must be a function/);
    bad({ name: 'x', collection: 'Task', pull, live: 'yes' }, /live must be a boolean/);
    bad({ name: 'x', collection: 'Task', pull, retryTime: 0 }, /retryTime/);
    bad({ name: 'x', collection: 'Task', pull, batchSize: 0 }, /batchSize/);
    bad({ name: 'x', collection: 'Task', pull, modifier: { pull: 7 } }, /modifier.pull/);
    bad({ name: 'x', collection: 'Task', pull, resolve: 'no' }, /resolve/);
    bad({ name: 'x', collection: 'Task', pull, autoStart: 'now' }, /autoStart/);
    assert.throws(() => replicate({}, { name: 'x', collection: 'Task', pull }), {
      name: 'TypeError',
      message: /takes a database/,
    });
    // A modifier reshapes what goes out and what comes in.
    const shaped = createFakeBackend();
    const modified = replicate(a, {
      name: 'shaped',
      collection: 'Task',
      ...shaped.handlers(),
      live: false,
      batchSize: 1,
      modifier: { push: (data) => ({ ...data, shaped: true }), pull: ({ shaped: _, ...data }) => data },
    });
    t2.after(() => modified.cancel().catch(() => {}));
    await modified.awaitInitialReplication();
    const id = await a.insert({ $type: 'Task', title: 'shape me' });
    await modified.awaitInSync();
    assert.deepStrictEqual(shaped.read(id), { title: 'shape me', shaped: true });
    await modified.reSync();
    assert.deepStrictEqual(
      await a.get(id),
      { title: 'shape me', $type: 'Task' },
      'the pull modifier took the mark off: no op of it',
    );
    // A signal cuts a wait short (a connector not started is not in sync).
    const idle = replicate(a, { name: 'idle', collection: 'Task', pull, autoStart: false });
    const controller = new AbortController();
    const waiting = idle.awaitInSync({ signal: controller.signal });
    controller.abort(new Error('enough'));
    await assert.rejects(waiting, { message: 'enough' });
    const aborted = new AbortController();
    aborted.abort(new Error('already'));
    await assert.rejects(idle.awaitInitialReplication({ signal: aborted.signal }), { message: 'already' });
    await idle.cancel();
    await assert.rejects(idle.awaitInSync(), { code: 'REPLICATION_FAILED' });
    await assert.rejects(idle.reSync(), { code: 'REPLICATION_FAILED' });
  });

  await t.test(
    'a pulled document that cannot land is refused and said — another collection’s record, a sealed one, a validator’s no, a field the engine refuses — and the rest of the page lands; the checkpoint moves',
    async (t2) => {
      const backend = createFakeBackend();
      const validated = {
        '~standard': {
          version: 1,
          vendor: 'test',
          validate: (value) => (value.title === 'bad' ? { issues: [{ message: 'no', path: ['title'] }] } : { value }),
        },
      };
      const a = await open(t2, 'A', { schema: { entities: { Task: { schema: validated }, Note: {} } } });
      const note = (await a.Note.insert({ text: 'mine' })).id;
      const sealed = await a.insert({ $type: 'Task', title: 'secret' }, { encrypted: true });
      backend.write('t1', { title: 'fine' });
      backend.write(note, { title: 'adopt me' });
      backend.write(sealed, { title: 'leaked' });
      backend.write('t2', { title: 'bad' });
      backend.write('t3', { title: 'ok', ['__proto__']: { polluted: true } });
      backend.write(note, null, { deleted: true });
      backend.write('ghost', null, { deleted: true });
      backend.write('t4', { title: 'last' });
      const replication = connect(t2, a, backend, { live: false });
      const refused = [];
      const errors = [];
      replication.on('refused', (event) => refused.push(event));
      replication.on('error', (error) => errors.push(error));
      await replication.awaitInitialReplication();
      assert.deepStrictEqual(errors, []);
      assert.deepStrictEqual((await a.get('t1')).title, 'fine', 'the page landed around the refusals');
      assert.deepStrictEqual((await a.get('t4')).title, 'last');
      assert.strictEqual(await a.get('t2'), null, 'the validator said no');
      assert.strictEqual(await a.get('t3'), null, 'the engine refused the field');
      assert.strictEqual(Object.prototype.polluted, undefined);
      assert.deepStrictEqual(await a.get(note), { text: 'mine', $type: 'Note' }, 'another collection’s record, kept');
      assert.deepStrictEqual((await a.get(sealed)).title, 'secret', 'the sealed record, kept');
      assert.strictEqual(replication.checkpoint.pull, backend.changes.length, 'the checkpoint moved past the page');
      const seen = [];
      for (const event of refused) seen.push([event.direction, event.id, event.reason]);
      seen.sort((x, y) => (x[1] < y[1] ? -1 : x[1] > y[1] ? 1 : 0));
      const expected = [
        ['pull', note, 'collection'],
        ['pull', note, 'collection'],
        ['pull', sealed, 'sealed'],
        ['pull', 't2', 'VALIDATION_FAILED'],
        ['pull', 't3', 'TypeError'],
      ].sort((x, y) => (x[1] < y[1] ? -1 : x[1] > y[1] ? 1 : 0));
      assert.deepStrictEqual(seen, expected);
      assert.ok(refused.every((event) => event.cause === undefined || event.cause instanceof Error));
      assert.strictEqual(replication.stats().refused, 5);
      await replication.cancel();
      // A value that is no JSON (a Date, a class instance) is refused on pull, never flattened into the record.
      const typed = replicate(a, {
        name: 'typed',
        collection: 'Task',
        live: false,
        pull: {
          handler: async () => ({
            documents: [
              { id: 'd1', data: { when: new Date(0) } },
              { id: 'd2', data: { n: 1 } },
            ],
            checkpoint: 1,
          }),
        },
      });
      t2.after(() => typed.cancel().catch(() => {}));
      const typedRefusals = [];
      typed.on('refused', (event) => typedRefusals.push(event));
      await typed.awaitInitialReplication();
      assert.strictEqual(await a.get('d1'), null);
      assert.deepStrictEqual((await a.get('d2')).n, 1);
      assert.deepStrictEqual(
        typedRefusals.map(({ direction, id, reason }) => ({ direction, id, reason })),
        [{ direction: 'pull', id: 'd1', reason: 'value' }],
      );
    },
  );

  await t.test(
    'a landing that fails whole is a pull failure: told as REPLICATION_FAILED, tried again, the checkpoint unmoved, active still true',
    async (t2) => {
      const backend = createFakeBackend();
      backend.write('t1', { title: 'one' });
      const a = await open(t2, 'A');
      const original = a.transact.bind(a);
      let failures = 1;
      a.transact = async (...args) => {
        if (failures > 0) {
          failures--;
          throw new Error('engine hiccup');
        }
        return original(...args);
      };
      const replication = connect(t2, a, backend, { live: false });
      const errors = [];
      replication.on('error', (error) => errors.push(error));
      await waitUntil(() => errors.length === 1);
      assert.strictEqual(errors[0].code, 'REPLICATION_FAILED');
      assert.strictEqual(errors[0].direction, 'pull');
      assert.match(errors[0].cause.message, /engine hiccup/);
      assert.strictEqual(replication.checkpoint.pull, null, 'the checkpoint did not move past the page');
      assert.strictEqual(replication.active, true);
      assert.strictEqual(await a.get('t1'), null);
      // Tried again after retryTime: the page lands and the checkpoint moves.
      await waitUntil(async () => (await a.get('t1')) !== null, { timeout: 5000 });
      await waitUntil(() => replication.checkpoint.pull === 1);
      assert.strictEqual(replication.errors.length, 1);
    },
  );

  await t.test(
    'a failure after the push handler — a throwing resolve, a landing refused — keeps the rows pending, is told, and nothing is unhandled',
    async (t2) => {
      const unhandled = [];
      const onUnhandled = (reason) => unhandled.push(reason);
      process.on('unhandledRejection', onUnhandled);
      t2.after(() => process.off('unhandledRejection', onUnhandled));
      const backend = createFakeBackend();
      const validated = {
        '~standard': {
          version: 1,
          vendor: 'test',
          validate: (value) => (value.title === 'bad' ? { issues: [{ message: 'no', path: ['title'] }] } : { value }),
        },
      };
      const a = await open(t2, 'A', { schema: { entities: { Task: { schema: validated }, Note: {} } } });
      let throwing = true;
      const replication = connect(t2, a, backend, {
        resolve: () => {
          if (!throwing) return undefined;
          throwing = false;
          throw new Error('resolve exploded');
        },
      });
      const conflicts = [];
      const refused = [];
      const errors = [];
      replication.on('conflict', (event) => conflicts.push(event));
      replication.on('refused', (event) => refused.push(event));
      replication.on('error', (error) => errors.push(error));
      await replication.awaitInitialReplication();
      const id = await a.insert({ $type: 'Task', title: 'v1' });
      await replication.awaitInSync();
      // A throwing resolve: said, the backend wins, the connector goes on.
      backend.set(id, { title: 'backend v2' });
      await a.Task.update(id, { title: 'A v2' });
      await replication.awaitInSync();
      await waitUntil(async () => (await a.get(id))?.title === 'backend v2');
      assert.strictEqual(conflicts.length, 1);
      assert.deepStrictEqual(conflicts[0].resolved, { title: 'backend v2' });
      // A conflict whose resolution the engine refuses (the validator says no to the backend's state): the row is
      // said (refused, direction push), the local record stands and goes to the backend with its state assumed.
      backend.set(id, { title: 'bad' });
      await a.Task.update(id, { title: 'A v3' });
      await replication.awaitInSync();
      await waitUntil(() => refused.length === 1);
      assert.strictEqual(refused[0].direction, 'push');
      assert.strictEqual(refused[0].id, id);
      assert.strictEqual(refused[0].reason, 'VALIDATION_FAILED');
      assert.strictEqual(conflicts.length, 2);
      await waitUntil(() => backend.read(id)?.title === 'A v3', { timeout: 5000 });
      assert.deepStrictEqual(await a.get(id), { title: 'A v3', $type: 'Task' }, 'the local record stood');
      // A landing that fails whole after the handler: the rows stay pending, the failure is told, tried again.
      const original = a.transact.bind(a);
      let failures = 1;
      a.transact = async (fn, options) => {
        if (failures > 0 && typeof options?.source === 'string' && options.source.endsWith(':resolve')) {
          failures--;
          throw new Error('engine hiccup');
        }
        return original(fn, options);
      };
      backend.set(id, { title: 'backend v4' });
      await a.Task.update(id, { title: 'A v4' });
      await waitUntil(() => errors.length === 1, { timeout: 5000 });
      assert.strictEqual(errors[0].direction, 'push');
      assert.match(errors[0].cause.message, /engine hiccup/);
      assert.ok(replication.stats().pending >= 1, 'the row stays pending');
      await waitUntil(async () => (await a.get(id))?.title === 'backend v4', { timeout: 5000 });
      await replication.awaitInSync();
      assert.deepStrictEqual(backend.read(id), { title: 'backend v4' });
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepStrictEqual(unhandled, []);
    },
  );

  await t.test(
    'a row the backend refuses by name is parked and said (refused, direction push); the rest of the batch lands; a new turn of the record or reSync() tries it again',
    async (t2) => {
      const backend = createFakeBackend();
      const a = await open(t2, 'A');
      const replication = connect(t2, a, backend);
      const refused = [];
      const errors = [];
      replication.on('refused', (event) => refused.push(event));
      replication.on('error', (error) => errors.push(error));
      await replication.awaitInitialReplication();
      backend.refuse('_bad', { code: 'bad_id', message: 'an id may not start with _' });
      await a.transact(async (tx) => {
        await tx.set('_bad', { $type: 'Task', title: 'refused by name' });
        await tx.set('fine', { $type: 'Task', title: 'fine' });
      });
      await replication.awaitInSync();
      assert.deepStrictEqual(backend.read('fine'), { title: 'fine' }, 'the rest of the batch landed');
      assert.strictEqual(backend.read('_bad'), null);
      assert.deepStrictEqual(
        refused.map(({ direction, id, reason }) => ({ direction, id, reason })),
        [{ direction: 'push', id: '_bad', reason: 'bad_id' }],
      );
      assert.deepStrictEqual(refused[0].cause, { code: 'bad_id', message: 'an id may not start with _' });
      assert.deepStrictEqual(errors, [], 'no failure: the backend answered');
      const stats = replication.stats();
      assert.strictEqual(stats.parked, 1);
      assert.strictEqual(stats.pending, 0);
      const pushes = backend.calls.push;
      await new Promise((resolve) => setTimeout(resolve, 120));
      assert.strictEqual(backend.calls.push, pushes, 'a parked row is not tried again on its own');
      // A new turn of the record tries it again (and is refused again).
      await a.Task.update('_bad', { title: 'again' });
      await replication.awaitInSync();
      assert.strictEqual(refused.length, 2);
      assert.strictEqual(replication.stats().parked, 1);
      // reSync() tries the parked rows again: the backend takes it now.
      backend.refuse('_bad', null);
      await replication.reSync();
      await replication.awaitInSync();
      assert.deepStrictEqual(backend.read('_bad'), { title: 'again' });
      assert.strictEqual(replication.stats().parked, 0);
    },
  );

  await t.test(
    'retries back off: doubling from retryTime to maxRetryTime with jitter, reset by a success',
    async (t2) => {
      const backend = createFakeBackend();
      const a = await open(t2, 'A');
      assert.throws(
        () => replicate(a, { name: 'x', collection: 'Task', ...backend.handlers(), retryTime: 20, maxRetryTime: 10 }),
        {
          name: 'TypeError',
          message: /maxRetryTime/,
        },
      );
      backend.fail('pull', 4);
      const replication = connect(t2, a, backend, { retryTime: 20, maxRetryTime: 80, live: false });
      const errors = [];
      replication.on('error', (error) => errors.push(error));
      await waitUntil(() => backend.calls.pull === 5, { timeout: 5000 });
      assert.strictEqual(errors.length, 4);
      const within = (value, low, high) => value >= low && value <= high;
      const delays = errors.map((error) => error.retryIn);
      assert.ok(within(delays[0], 15, 25), `first ${delays[0]}`);
      assert.ok(within(delays[1], 30, 50), `second ${delays[1]}`);
      assert.ok(within(delays[2], 60, 100), `third ${delays[2]} (capped at 80)`);
      assert.ok(within(delays[3], 60, 100), `fourth ${delays[3]} (capped at 80)`);
      // Reset by the success: the next failure waits retryTime again.
      await waitUntil(() => replication.stats().pulls === 1);
      backend.fail('pull', 1);
      replication.reSync().catch(() => {});
      await waitUntil(() => errors.length === 5, { timeout: 5000 });
      assert.ok(within(errors[4].retryIn, 15, 25), `after a success ${errors[4].retryIn}`);
      // The push direction backs off on its own count.
      await waitUntil(() => backend.calls.pull === 7, { timeout: 5000 });
      backend.fail('push', 2);
      await a.insert({ $type: 'Task', title: 'kept pending' });
      await waitUntil(() => errors.length === 7, { timeout: 5000 });
      assert.strictEqual(errors[5].direction, 'push');
      assert.ok(within(errors[5].retryIn, 15, 25), `push first ${errors[5].retryIn}`);
      assert.ok(within(errors[6].retryIn, 30, 50), `push second ${errors[6].retryIn}`);
      await replication.awaitInSync();
    },
  );

  await t.test(
    'a row equal to what the backend was assumed to hold is not pushed: a resolution the backend won goes nowhere',
    async (t2) => {
      const backend = createFakeBackend();
      const a = await open(t2, 'A');
      const replication = connect(t2, a, backend);
      const conflicts = [];
      replication.on('conflict', (event) => conflicts.push(event));
      await replication.awaitInitialReplication();
      const id = await a.insert({ $type: 'Task', title: 'v1' });
      await replication.awaitInSync();
      backend.set(id, { title: 'backend v2' });
      await a.Task.update(id, { title: 'A v2' });
      await replication.awaitInSync();
      await waitUntil(() => conflicts.length === 1);
      await waitUntil(async () => (await a.get(id))?.title === 'backend v2');
      await replication.awaitInSync();
      const pushes = backend.calls.push;
      const { rev } = backend.docs.get(id);
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.strictEqual(backend.calls.push, pushes, 'the resolution the backend won was not pushed back');
      assert.strictEqual(backend.docs.get(id).rev, rev, 'no revision made of it');
      // A turn that leaves the record as the backend holds it has nothing to say either.
      await a.set(id, { $type: 'Task', title: 'backend v2' });
      await replication.awaitInSync();
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.strictEqual(backend.calls.push, pushes);
      assert.strictEqual(backend.docs.get(id).rev, rev);
      assert.strictEqual(replication.stats().pushed, 2, 'the insert and the edit went; nothing else');
    },
  );

  await t.test(
    'a pull over an unpushed local change: an echo of what was assumed is skipped, a backend that moved is a conflict (resolve, the conflict event), never a silent overwrite',
    async (t2) => {
      const backend = createFakeBackend();
      const a = await open(t2, 'A');
      // The retry is late enough for the stream to land a page while the row waits.
      const replication = connect(t2, a, backend, { retryTime: 1500 });
      const conflicts = [];
      const errors = [];
      replication.on('conflict', (event) => conflicts.push(event));
      replication.on('error', (error) => errors.push(error));
      await replication.awaitInitialReplication();
      const id = await a.insert({ $type: 'Task', title: 'v1' });
      await replication.awaitInSync();
      // A local edit whose push fails: the row waits for the retry. Meanwhile the backend's stream hands the
      // record back as it was assumed to be (an echo): skipped — the local edit stands, no conflict.
      backend.fail('push', 1);
      await a.Task.update(id, { title: 'v2-local' });
      await waitUntil(() => errors.length === 1);
      const pulled = replication.stats().pulled;
      backend.write(id, { title: 'v1' });
      await waitUntil(() => replication.stats().pulled > pulled);
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.deepStrictEqual(await a.get(id), { title: 'v2-local', $type: 'Task' }, 'the echo did not overwrite');
      assert.deepStrictEqual(conflicts, []);
      // The retry pushes the edit against what was assumed: it lands.
      await waitUntil(() => backend.read(id)?.title === 'v2-local', { timeout: 5000 });
      await replication.awaitInSync();
      // The same, with a backend that moved meanwhile: a conflict — the backend wins, told — never a silent write
      // of the backend's state over the edit, and the edit never pushed over the backend.
      backend.fail('push', 1);
      await a.Task.update(id, { title: 'v3-local' });
      await waitUntil(() => errors.length === 2);
      backend.write(id, { title: 'backend v3' });
      await waitUntil(() => conflicts.length === 1);
      assert.deepStrictEqual(conflicts[0], {
        id,
        local: { title: 'v3-local' },
        remote: { title: 'backend v3' },
        deleted: false,
        resolved: { title: 'backend v3' },
      });
      assert.deepStrictEqual(await a.get(id), { title: 'backend v3', $type: 'Task' });
      const pushes = backend.calls.push;
      await waitUntil(() => replication.stats().pending === 0, { timeout: 5000 });
      await replication.awaitInSync();
      assert.deepStrictEqual(backend.read(id), { title: 'backend v3' });
      assert.strictEqual(backend.calls.push, pushes, 'nothing to say after the backend won');
      // With `resolve`, the application decides over the pull path too, and its answer goes to the backend.
      await replication.cancel();
      const resolving = connect(t2, a, backend, {
        name: 'resolving',
        retryTime: 1500,
        resolve: ({ local, remote }) => ({ title: `${local.title}+${remote.title}` }),
      });
      const resolved = [];
      const failures = [];
      resolving.on('conflict', (event) => resolved.push(event));
      resolving.on('error', (error) => failures.push(error));
      await resolving.awaitInitialReplication();
      backend.fail('push', 1);
      await a.Task.update(id, { title: 'v4-local' });
      await waitUntil(() => failures.length === 1);
      backend.write(id, { title: 'backend v4' });
      await waitUntil(() => resolved.length === 1);
      assert.deepStrictEqual(resolved[0].resolved, { title: 'v4-local+backend v4' });
      assert.deepStrictEqual(await a.get(id), { title: 'v4-local+backend v4', $type: 'Task' });
      await waitUntil(() => backend.read(id)?.title === 'v4-local+backend v4', { timeout: 5000 });
      assert.strictEqual(resolved.length, 1);
    },
  );

  await t.test(
    'with a modifier the backend’s shape is what is assumed and compared; a conflict’s remote comes through modifier.pull and the resolution goes back through modifier.push',
    async (t2) => {
      const backend = createFakeBackend();
      const a = await open(t2, 'A');
      const replication = connect(t2, a, backend, {
        retryTime: 1500,
        modifier: { push: (data) => ({ ...data, shaped: true }), pull: ({ shaped: _, ...data }) => data },
        resolve: ({ local, remote }) => ({ title: `${local.title}|${remote.title}` }),
      });
      const conflicts = [];
      const errors = [];
      const rows = [];
      replication.on('conflict', (event) => conflicts.push(event));
      replication.on('error', (error) => errors.push(error));
      const { handler } = backend.handlers().push;
      backend.handlers = () => ({ pull: backend.handlers().pull, push: { handler } });
      await replication.awaitInitialReplication();
      const id = await a.insert({ $type: 'Task', title: 'v1' });
      await replication.awaitInSync();
      assert.deepStrictEqual(backend.read(id), { title: 'v1', shaped: true });
      // The backend's write comes down the stream in its shape: an echo of what was pushed, no op.
      await replication.reSync();
      assert.deepStrictEqual(await a.get(id), { title: 'v1', $type: 'Task' });
      // An edit after the pull assumes the backend's shape: the compare-and-set lands, no conflict.
      await a.Task.update(id, { title: 'v2' });
      await replication.awaitInSync();
      assert.deepStrictEqual(backend.read(id), { title: 'v2', shaped: true });
      assert.deepStrictEqual(conflicts, []);
      // A conflict on the push path: the remote through modifier.pull, the resolution landed in the local shape and
      // pushed back through modifier.push.
      backend.set(id, { title: 'backend v3', shaped: true });
      await a.Task.update(id, { title: 'v3' });
      await waitUntil(() => conflicts.length === 1);
      assert.deepStrictEqual(conflicts[0].remote, { title: 'backend v3' });
      assert.deepStrictEqual(conflicts[0].local, { title: 'v3' });
      assert.deepStrictEqual(conflicts[0].resolved, { title: 'v3|backend v3' });
      await waitUntil(() => backend.read(id)?.title === 'v3|backend v3', { timeout: 5000 });
      assert.deepStrictEqual(await a.get(id), { title: 'v3|backend v3', $type: 'Task' });
      assert.deepStrictEqual(backend.read(id), { title: 'v3|backend v3', shaped: true });
      // A conflict on the pull path (the backend moved under an unpushed edit): the same shapes.
      backend.fail('push', 1);
      await a.Task.update(id, { title: 'v4' });
      await waitUntil(() => errors.length === 1);
      backend.write(id, { title: 'backend v4', shaped: true });
      await waitUntil(() => conflicts.length === 2);
      assert.deepStrictEqual(conflicts[1].remote, { title: 'backend v4' });
      assert.deepStrictEqual(conflicts[1].resolved, { title: 'v4|backend v4' });
      assert.deepStrictEqual(await a.get(id), { title: 'v4|backend v4', $type: 'Task' });
      await waitUntil(() => backend.read(id)?.title === 'v4|backend v4', { timeout: 5000 });
      assert.deepStrictEqual(backend.read(id), { title: 'v4|backend v4', shaped: true });
      assert.strictEqual(conflicts.length, 2);
      assert.deepStrictEqual(rows, []);
    },
  );
});
