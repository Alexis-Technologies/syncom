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
const { kvNamespace } = require('../src/engine.js');
const { DB } = require('../src/symbols.js');

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
      assert.strictEqual(errors[0].connector, 'main');
      assert.strictEqual(errors[0].name, 'SyncomError');
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
      // A conflict whose resolution the engine refuses (the validator says no to the backend's state): nobody wins —
      // the row is said (refused, direction push) and parked, the backend's state is not learned, the local record
      // stands and the backend keeps its own (once, the local record went over it with that state assumed).
      backend.set(id, { title: 'bad' });
      await a.Task.update(id, { title: 'A v3' });
      await replication.awaitInSync();
      await waitUntil(() => refused.length === 1);
      assert.strictEqual(refused[0].direction, 'push');
      assert.strictEqual(refused[0].id, id);
      assert.strictEqual(refused[0].reason, 'VALIDATION_FAILED');
      assert.strictEqual(conflicts.length, 2);
      assert.strictEqual(replication.stats().parked, 1);
      await new Promise((resolve) => setTimeout(resolve, 120));
      assert.deepStrictEqual(backend.read(id), { title: 'bad' }, 'the backend’s state, never overwritten');
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
    'a pulled document the database refuses is not learned — nobody wins: a local edit of it is a conflict resolve decides, never a silent overwrite of the backend; reSync() asks the backend for it again, across a restart',
    async (t2) => {
      const rules = { strict: true };
      const validated = {
        '~standard': {
          version: 1,
          vendor: 'test',
          validate: (value) =>
            rules.strict && value.title === 'bad' ? { issues: [{ message: 'no', path: ['title'] }] } : { value },
        },
      };
      const a = await open(t2, 'A', { schema: { entities: { Task: { schema: validated }, Note: {} } } });
      const backend = createFakeBackend();
      backend.write('t1', { title: 'fine', n: 1 });
      backend.write('t2', { title: 'fine', n: 1 });
      const rows = [];
      const handlers = backend.handlers();
      const push = handlers.push.handler;
      handlers.push.handler = async (batch) => {
        for (const row of batch) rows.push([row.id, row.assumed]);
        return push(batch);
      };
      const options = {
        name: 'main',
        collection: 'Task',
        ...handlers,
        live: false,
        retryTime: 50,
        resolve: ({ local, remote }) => (remote?.title === 'bad' ? { title: 'fixed', n: local.n } : undefined),
      };
      const refused = [];
      const conflicts = [];
      const start = () => {
        const replication = replicate(a, options);
        t2.after(() => replication.cancel().catch(() => {}));
        replication.on('refused', (event) => refused.push([event.direction, event.id, event.reason]));
        replication.on('conflict', (event) => conflicts.push(event));
        return replication;
      };
      let replication = start();
      await replication.awaitInitialReplication();
      // Another client writes states this node's schema refuses: refused, and not taken as the backend's state.
      backend.write('t1', { title: 'bad', n: 2 });
      backend.write('t2', { title: 'bad', n: 2 });
      await replication.reSync();
      await replication.awaitInSync();
      assert.deepStrictEqual(refused, [
        ['pull', 't1', 'VALIDATION_FAILED'],
        ['pull', 't2', 'VALIDATION_FAILED'],
      ]);
      assert.deepStrictEqual(rows, [], 'nothing pushed');
      // An edit of t1 goes out assuming what this node last landed: the backend's refused state is a conflict, and
      // resolve decides — its answer lands, then goes to the backend with the backend's state assumed.
      await a.Task.update('t1', { n: 3 });
      await replication.awaitInSync();
      assert.deepStrictEqual(rows[0], ['t1', { title: 'fine', n: 1 }]);
      assert.strictEqual(conflicts.length, 1);
      assert.deepStrictEqual(conflicts[0].remote, { title: 'bad', n: 2 });
      assert.deepStrictEqual(await a.get('t1'), { title: 'fixed', n: 3, $type: 'Task' });
      assert.deepStrictEqual(backend.read('t1'), { title: 'fixed', n: 3 });
      assert.deepStrictEqual(rows[1], ['t1', { title: 'bad', n: 2 }]);
      // reSync() asks the backend for t2 again — a probe, nothing written — and it is refused again while the rule holds.
      rows.length = 0;
      await replication.reSync();
      await replication.awaitInSync();
      assert.deepStrictEqual(rows, [['t2', undefined]]);
      assert.deepStrictEqual(refused.slice(2), [['pull', 't2', 'VALIDATION_FAILED']]);
      assert.deepStrictEqual(backend.read('t2'), { title: 'bad', n: 2 });
      // An ask that fails is told (the pull's, no retry of its own) and the id is asked again by the next reSync().
      const errors = [];
      replication.on('error', (error) => errors.push(error));
      backend.fail('push', 1);
      await replication.reSync();
      await replication.awaitInSync();
      assert.strictEqual(errors.length, 1);
      assert.strictEqual(errors[0].direction, 'pull');
      assert.strictEqual(errors[0].retryIn, null);
      assert.strictEqual(refused.length, 3);
      // The refused ids are kept with the checkpoint: after a restart, reSync() asks again, and the document lands
      // once the database takes it — no conflict, the record was never edited here.
      await replication.cancel();
      const store = kvNamespace(a[DB].kv, 'connector');
      assert.deepStrictEqual(JSON.parse(await store.get('main')).refused, ['t2']);
      rules.strict = false;
      replication = start();
      await replication.awaitInitialReplication();
      await replication.reSync();
      await replication.awaitInSync();
      assert.deepStrictEqual(await a.get('t2'), { title: 'bad', n: 2, $type: 'Task' });
      assert.strictEqual(conflicts.length, 1);
      assert.strictEqual(refused.length, 3);
      await replication.cancel();
      assert.deepStrictEqual(JSON.parse(await store.get('main')).refused, []);
    },
  );

  await t.test(
    'a resolution the database refuses is not learned either — nobody wins: the row is parked, the backend keeps its state, reSync() asks again with the state known assumed; a newer state of the backend over that edit is a conflict, never a silent landing',
    async (t2) => {
      const validated = {
        '~standard': {
          version: 1,
          vendor: 'test',
          validate: (value) => (value.title === 'bad' ? { issues: [{ message: 'no', path: ['title'] }] } : { value }),
        },
      };
      const a = await open(t2, 'A', { schema: { entities: { Task: { schema: validated }, Note: {} } } });
      const backend = createFakeBackend();
      const refused = [];
      const conflicts = [];
      const errors = [];
      const start = () => {
        const replication = connect(t2, a, backend, { live: false });
        replication.on('refused', (event) => refused.push([event.direction, event.reason]));
        replication.on('conflict', (event) => conflicts.push(event));
        replication.on('error', (error) => errors.push(error));
        return replication;
      };
      let replication = start();
      await replication.awaitInitialReplication();
      const id = await a.insert({ $type: 'Task', title: 'v1' });
      await replication.awaitInSync();
      // The backend moves to a state this node refuses, behind the connector's back; then the record is edited here.
      backend.set(id, { title: 'bad' });
      await a.Task.update(id, { title: 'mine' });
      await replication.awaitInSync();
      assert.deepStrictEqual(refused, [['push', 'VALIDATION_FAILED']]);
      assert.strictEqual(conflicts.length, 1);
      assert.strictEqual(replication.stats().parked, 1);
      assert.strictEqual(replication.stats().pending, 0, 'no loop: parked, not pending');
      assert.deepStrictEqual(backend.read(id), { title: 'bad' });
      assert.deepStrictEqual(await a.get(id), { title: 'mine', $type: 'Task' });
      // reSync(): the pull brings the refused state over the edit — a conflict, refused again (the fake's feed answers
      // a row per change) — and the parked row goes again with the state known assumed: the same conflict, refused
      // again. Nothing is overwritten either side.
      await replication.reSync();
      await replication.awaitInSync();
      const directions = [];
      for (const [direction, reason] of refused) if (reason === 'VALIDATION_FAILED') directions.push(direction);
      assert.strictEqual(directions.length, refused.length);
      assert.deepStrictEqual([directions[0], directions[1], directions.at(-1)], ['push', 'pull', 'push']);
      assert.strictEqual(directions.filter((direction) => direction === 'push').length, 2);
      assert.strictEqual(replication.stats().parked, 1);
      assert.deepStrictEqual(backend.read(id), { title: 'bad' });
      assert.deepStrictEqual(await a.get(id), { title: 'mine', $type: 'Task' });
      // A restart keeps the parked row and the refusal: nothing is pushed by it, and reSync() pushes the row with the
      // state known assumed — the same conflict, refused again, the row parked again.
      await replication.cancel();
      replication = start();
      await replication.awaitInitialReplication();
      assert.strictEqual(replication.stats().parked, 1);
      assert.deepStrictEqual(replication.parked, [{ id, reason: 'VALIDATION_FAILED' }]);
      const pushes = refused.length;
      await replication.reSync();
      await replication.awaitInSync();
      assert.deepStrictEqual(refused.slice(pushes), [['push', 'VALIDATION_FAILED']]);
      assert.strictEqual(replication.stats().parked, 1);
      assert.deepStrictEqual(backend.read(id), { title: 'bad' });
      assert.deepStrictEqual(await a.get(id), { title: 'mine', $type: 'Task' });
      // A newer state of the backend, one the database takes, over the edit still waiting: a conflict (the backend
      // wins here), never a silent landing; then nothing is left to push.
      const before = conflicts.length;
      backend.set(id, { title: 'theirs' });
      await replication.reSync();
      await replication.awaitInSync();
      assert.strictEqual(conflicts.length, before + 1);
      assert.deepStrictEqual(conflicts[before].local, { title: 'mine' });
      assert.deepStrictEqual(conflicts[before].remote, { title: 'theirs' });
      assert.deepStrictEqual(await a.get(id), { title: 'theirs', $type: 'Task' });
      assert.deepStrictEqual(backend.read(id), { title: 'theirs' });
      assert.strictEqual(replication.stats().parked, 0);
      assert.deepStrictEqual(errors, []);
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

  // A backend whose pushes are recorded (`seen` called with each batch), and which contradicts itself on the ids of
  // `contradicting`: a conflict answered with exactly what the row assumed.
  const recording = (backend, pushed, contradicting = new Set(), seen = () => {}) => {
    const handlers = backend.handlers();
    const push = handlers.push.handler;
    handlers.push.handler = async (batch) => {
      seen(batch);
      const answers = [];
      const rest = [];
      for (const row of batch) {
        pushed.push(row.id);
        if (contradicting.has(row.id) && row.assumed) answers.push({ id: row.id, data: row.assumed });
        else rest.push(row);
      }
      return answers.concat(await push(rest));
    };
    return handlers;
  };

  await t.test(
    'a parked row survives a restart — refused by name, or by a backend contradicting itself: kept with the checkpoint with why, still parked and listed, not pushed by the restart, pushed by reSync() and by a change to the record; one the backend takes leaves the checkpoint',
    async (t2) => {
      const backend = createFakeBackend();
      let a = await open(t2, 'A');
      const pushed = [];
      const refused = [];
      const contradicting = new Set();
      // What stats() and the list say while a push is with the backend.
      const during = [];
      const start = () => {
        const replication = replicate(a, {
          name: 'main',
          collection: 'Task',
          ...recording(backend, pushed, contradicting, () =>
            during.push([replication.stats().pending, replication.stats().parked, replication.parked.length]),
          ),
          live: false,
          retryTime: 50,
          // This node's edit stands: the row goes again, and a backend that answers the same again contradicts itself.
          resolve: ({ local }) => local ?? undefined,
        });
        t2.after(() => replication.cancel().catch(() => {}));
        replication.on('refused', (event) => refused.push([event.id, event.reason]));
        return replication;
      };
      const saved = async () => JSON.parse(await kvNamespace(a[DB].kv, 'connector').get('main')).parked;
      let replication = start();
      await replication.awaitInitialReplication();
      await a.Task.set('twice', { title: 'v1' });
      await replication.awaitInSync();
      // One row refused by name, one a conflict over exactly what it assumed, twice in a row: both parked.
      backend.refuse('_bad', { code: 'bad_id', message: 'an id may not start with _' });
      contradicting.add('twice');
      await a.transact(async (tx) => {
        await tx.set('_bad', { $type: 'Task', title: 'refused by name' });
        await tx.set('twice', { $type: 'Task', title: 'v2' });
        await tx.set('fine', { $type: 'Task', title: 'fine' });
      });
      await replication.awaitInSync();
      const both = [
        { id: '_bad', reason: 'bad_id' },
        { id: 'twice', reason: 'conflict' },
      ];
      assert.deepStrictEqual(replication.parked, both);
      assert.deepStrictEqual(refused, [
        ['_bad', 'bad_id'],
        ['twice', 'conflict'],
      ]);
      await replication.cancel();
      assert.deepStrictEqual(await saved(), { _bad: 'bad_id', twice: 'conflict' });
      // A restart, the database reopened: still parked, listed with why, nothing of them pushed, nothing told again.
      await a.close();
      a = await open(t2, 'A');
      pushed.length = 0;
      refused.length = 0;
      replication = start();
      await replication.awaitInitialReplication();
      await replication.awaitInSync();
      assert.strictEqual(replication.stats().parked, 2);
      assert.strictEqual(replication.stats().pending, 0);
      assert.deepStrictEqual(replication.parked, both);
      assert.deepStrictEqual(pushed, [], 'the restart pushes no parked row');
      assert.deepStrictEqual(refused, []);
      // The restart's pull brought the backend's v1 again — the state known: skipped over the parked edit.
      assert.deepStrictEqual(await a.get('twice'), { title: 'v2', $type: 'Task' });
      // reSync() pushes them: refused again, parked again — and counted as pending, not parked, while they go.
      during.length = 0;
      await replication.reSync();
      await replication.awaitInSync();
      assert.deepStrictEqual(during[0], [2, 0, 0]);
      assert.ok(pushed.includes('_bad') && pushed.includes('twice'), pushed.join());
      assert.deepStrictEqual(refused, [
        ['_bad', 'bad_id'],
        ['twice', 'conflict'],
      ]);
      assert.deepStrictEqual(replication.parked, both);
      assert.deepStrictEqual(backend.read('twice'), { title: 'v1' });
      // Another restart; a change to a parked record pushes it, the other stays parked and unpushed.
      await replication.cancel();
      replication = start();
      await replication.awaitInitialReplication();
      pushed.length = 0;
      await a.Task.update('_bad', { title: 'again' });
      await replication.awaitInSync();
      assert.deepStrictEqual(pushed, ['_bad']);
      assert.deepStrictEqual(replication.parked, [
        { id: 'twice', reason: 'conflict' },
        { id: '_bad', reason: 'bad_id' },
      ]);
      // A change made while no connector ran is a turn the log holds: the restart itself pushes that row.
      await replication.cancel();
      backend.refuse('_bad', { code: 'still_bad' });
      await a.Task.update('_bad', { title: 'offline' });
      pushed.length = 0;
      replication = start();
      await replication.awaitInitialReplication();
      await replication.awaitInSync();
      assert.deepStrictEqual(pushed, ['_bad']);
      assert.deepStrictEqual(replication.parked, [
        { id: 'twice', reason: 'conflict' },
        { id: '_bad', reason: 'still_bad' },
      ]);
      // The backend takes them: no longer parked, gone from the checkpoint.
      backend.refuse('_bad', null);
      contradicting.clear();
      await replication.reSync();
      await replication.awaitInSync();
      assert.deepStrictEqual(backend.read('_bad'), { title: 'offline' });
      assert.deepStrictEqual(backend.read('twice'), { title: 'v2' });
      assert.deepStrictEqual(replication.parked, []);
      assert.strictEqual(replication.stats().parked, 0);
      await replication.cancel();
      assert.deepStrictEqual(await saved(), {});
    },
  );

  await t.test(
    'a purge made while no connector ran reaches the backend as a deletion at the next start, as a deletion made meanwhile does; a purged record the backend never held is not sent; a purge whose push failed before the stop goes too',
    async (t2) => {
      const backend = createFakeBackend();
      let a = await open(t2, 'A');
      const rows = [];
      const start = (options = {}) => {
        const handlers = backend.handlers();
        const push = handlers.push.handler;
        handlers.push.handler = async (batch) => {
          const answer = await push(batch);
          for (const row of batch) rows.push([row.id, row.deleted, row.assumed === undefined ? 'probe' : 'row']);
          return answer;
        };
        const replication = replicate(a, {
          name: 'main',
          collection: 'Task',
          ...handlers,
          live: false,
          retryTime: 50,
          ...options,
        });
        t2.after(() => replication.cancel().catch(() => {}));
        return replication;
      };
      const known = async () => JSON.parse(await kvNamespace(a[DB].kv, 'connector').get('main')).known;
      let replication = start();
      await replication.awaitInitialReplication();
      await a.transact(async (tx) => {
        await tx.set('purged', { $type: 'Task', title: 'purged while away' });
        await tx.set('deleted', { $type: 'Task', title: 'deleted while away' });
        await tx.set('failing', { $type: 'Task', title: 'purged while the backend was down' });
      });
      await replication.awaitInSync();
      await replication.cancel();
      assert.deepStrictEqual(Object.keys(await known()).sort(), ['deleted', 'failing', 'purged']);
      // While no connector runs: one record purged, one deleted, one made and purged before any push.
      await a.purge('purged');
      await a.Task.delete('deleted');
      await a.Task.set('never', { title: 'never pushed' });
      await a.purge('never');
      // The database reopened, the connector started anew: the purge goes as the deletion does — the backend asked
      // what it holds first (a probe: its state is known by digest alone), then told of the deletion.
      await a.close();
      a = await open(t2, 'A');
      rows.length = 0;
      replication = start();
      await replication.awaitInitialReplication();
      await replication.awaitInSync();
      assert.strictEqual(backend.docs.get('deleted').deleted, true);
      assert.strictEqual(backend.docs.get('purged').deleted, true, 'the purge reached the backend as a deletion');
      const sent = (id) => rows.filter((row) => row[0] === id).map(([, deleted, kind]) => [deleted, kind]);
      assert.deepStrictEqual(sent('purged'), [
        [true, 'probe'],
        [true, 'row'],
      ]);
      assert.deepStrictEqual(sent('purged'), sent('deleted'), 'exactly as the deletion goes');
      assert.strictEqual(backend.docs.has('never'), false, 'nothing of a record the backend never held');
      assert.ok(rows.every(([id]) => id !== 'never'));
      // Gone on both sides: no digest is kept of either.
      await replication.cancel();
      assert.deepStrictEqual(Object.keys(await known()), ['failing']);
      // A purge heard while the backend was down, the connector stopped before the retry: the next start sends it.
      replication = start({ retryTime: 5000 });
      await replication.awaitInitialReplication();
      const errors = [];
      replication.on('error', (error) => errors.push(error));
      backend.fail('push', 1);
      await a.purge('failing');
      await waitUntil(() => errors.length === 1);
      await replication.cancel();
      assert.strictEqual(backend.docs.get('failing').deleted, false);
      replication = start();
      await replication.awaitInitialReplication();
      await replication.awaitInSync();
      assert.strictEqual(backend.docs.get('failing').deleted, true);
      await replication.cancel();
      assert.deepStrictEqual(await known(), {});
    },
  );

  await t.test(
    'a record modifier.push throws on is parked — said (refused, direction push, reason modifier), listed, kept with the checkpoint — the rest of its batch goes, a pull never lands the backend’s state over it, and reSync() or a change to the record tries it again',
    async (t2) => {
      const backend = createFakeBackend();
      const a = await open(t2, 'A');
      const pushed = [];
      const refused = [];
      let broken = true;
      const start = () => {
        const replication = replicate(a, {
          name: 'main',
          collection: 'Task',
          ...recording(backend, pushed),
          modifier: {
            // The application's own shaping, with a bug for one title.
            push: (data) => {
              if (broken && data.title === 'boom') throw new Error('cannot shape this one');
              return data;
            },
          },
          live: false,
          retryTime: 50,
        });
        t2.after(() => replication.cancel().catch(() => {}));
        replication.on('refused', (event) => refused.push([event.direction, event.id, event.reason, event.cause]));
        return replication;
      };
      let replication = start();
      await replication.awaitInitialReplication();
      await a.transact(async (tx) => {
        await tx.set('bad', { $type: 'Task', title: 'fine' });
        await tx.set('ok', { $type: 'Task', title: 'v1' });
      });
      await replication.awaitInSync();
      // One transaction, two rows: the modifier throws on one — parked, said — and the other goes.
      await a.transact(async (tx) => {
        await tx.set('bad', { $type: 'Task', title: 'boom' });
        await tx.set('ok', { $type: 'Task', title: 'v2' });
      });
      await replication.awaitInSync();
      assert.strictEqual(refused.length, 1);
      assert.deepStrictEqual(refused[0].slice(0, 3), ['push', 'bad', 'modifier']);
      assert.strictEqual(refused[0][3].message, 'cannot shape this one');
      assert.deepStrictEqual(replication.parked, [{ id: 'bad', reason: 'modifier' }]);
      assert.deepStrictEqual([replication.stats().parked, replication.stats().pending], [1, 0]);
      assert.deepStrictEqual(backend.read('ok'), { title: 'v2' }, 'the rest of the batch went');
      assert.deepStrictEqual(backend.read('bad'), { title: 'fine' });
      // reSync(): the pull hands back the backend's state of the record — the state known, over an edit that waits:
      // not landed — and the row is tried again: the modifier throws again, said again, parked still.
      pushed.length = 0;
      await replication.reSync();
      await replication.awaitInSync();
      assert.deepStrictEqual(await a.get('bad'), { title: 'boom', $type: 'Task' }, 'the edit stands');
      assert.deepStrictEqual(pushed, [], 'no row of it could be made');
      assert.strictEqual(refused.length, 2);
      assert.deepStrictEqual(replication.parked, [{ id: 'bad', reason: 'modifier' }]);
      // Kept with the checkpoint: a connector started anew holds it parked, and says nothing of it by itself.
      await replication.cancel();
      const text = JSON.parse(await kvNamespace(a[DB].kv, 'connector').get('main'));
      assert.deepStrictEqual(text.parked, { bad: 'modifier' });
      replication = start();
      await replication.awaitInitialReplication();
      await replication.awaitInSync();
      assert.deepStrictEqual(replication.parked, [{ id: 'bad', reason: 'modifier' }]);
      assert.strictEqual(refused.length, 2);
      // A change to the record tries it again; with the modifier mended, it goes and is parked no more.
      await a.Task.update('bad', { n: 1 });
      await replication.awaitInSync();
      assert.strictEqual(refused.length, 3);
      broken = false;
      await replication.reSync();
      await replication.awaitInSync();
      assert.deepStrictEqual(backend.read('bad'), { title: 'boom', n: 1 });
      assert.deepStrictEqual(replication.parked, []);
      assert.deepStrictEqual(
        pushed,
        ['bad', 'bad'],
        'asked what the backend holds (a probe after the restart), then sent',
      );
    },
  );

  await t.test(
    'a parked row whose retry is cut short stays parked; one deleted or purged goes as a deletion; a newer state of the backend over one is a conflict; an id that is another collection’s by now parks nothing',
    async (t2) => {
      const backend = createFakeBackend();
      const a = await open(t2, 'A');
      const pushed = [];
      const conflicts = [];
      const start = (options = {}) => {
        const replication = replicate(a, {
          name: 'main',
          collection: 'Task',
          ...recording(backend, pushed),
          live: false,
          retryTime: 50,
          ...options,
        });
        t2.after(() => replication.cancel().catch(() => {}));
        replication.on('conflict', (event) => conflicts.push([event.id, event.local, event.resolved]));
        return replication;
      };
      const saved = async () => JSON.parse(await kvNamespace(a[DB].kv, 'connector').get('main')).parked;
      // No retry of a failed push within the test: the stop comes first.
      let replication = start({ retryTime: 5000 });
      await replication.awaitInitialReplication();
      for (const id of ['cut', 'gone', 'purged', 'theirs', 'moved']) backend.refuse(id, { code: 'no' });
      await a.transact(async (tx) => {
        for (const id of ['cut', 'gone', 'purged', 'theirs', 'moved']) await tx.set(id, { $type: 'Task', title: id });
      });
      await replication.awaitInSync();
      assert.strictEqual(replication.stats().parked, 5);
      // A retry whose push fails, then a stop before the next try: the rows are still parked in the checkpoint — the
      // position they wait since names no turn of theirs, so nothing else would remember them.
      const errors = [];
      replication.on('error', (error) => errors.push(error));
      backend.fail('push', 1);
      await replication.reSync();
      await waitUntil(() => errors.length === 1);
      assert.strictEqual(replication.stats().pending, 5);
      await replication.cancel();
      assert.deepStrictEqual(Object.keys(await saved()).sort(), ['cut', 'gone', 'moved', 'purged', 'theirs']);
      // While no connector runs: one record deleted, one purged, one deleted and made again as another collection's,
      // and the backend takes a state of its own for a fourth.
      await a.Task.delete('gone');
      await a.purge('purged');
      await a.Task.delete('moved');
      await a.set('moved', { $type: 'Note', title: 'a note now' });
      backend.refuse('theirs', null);
      backend.write('theirs', { title: 'the backend’s' });
      pushed.length = 0;
      replication = start();
      await replication.awaitInitialReplication();
      await replication.awaitInSync();
      // The deletion is a turn the log holds — pushed by the restart, refused again; the backend's newer state over
      // the parked edit is a conflict, which the backend wins here — told, and nothing is parked of it any more; the
      // id that is a Note's is forgotten; the purge waits for reSync().
      assert.deepStrictEqual(pushed, ['gone']);
      assert.deepStrictEqual(conflicts, [['theirs', { title: 'theirs' }, { title: 'the backend’s' }]]);
      assert.deepStrictEqual(await a.get('theirs'), { title: 'the backend’s', $type: 'Task' });
      assert.deepStrictEqual(replication.parked, [
        { id: 'cut', reason: 'no' },
        { id: 'purged', reason: 'no' },
        { id: 'gone', reason: 'no' },
      ]);
      // reSync(): each goes again — the two that are gone here as deletions — and the backend takes them now.
      for (const id of ['cut', 'gone', 'purged']) backend.refuse(id, null);
      pushed.length = 0;
      const rows = [];
      await replication.cancel();
      const handlers = recording(backend, pushed);
      const push = handlers.push.handler;
      handlers.push.handler = async (batch) => {
        for (const row of batch) rows.push([row.id, row.deleted]);
        return push(batch);
      };
      replication = start({ ...handlers, pull: undefined });
      await replication.awaitInitialReplication();
      assert.strictEqual(replication.stats().parked, 3);
      await replication.reSync();
      await replication.awaitInSync();
      assert.deepStrictEqual(rows.sort(), [
        ['cut', false],
        ['gone', true],
        ['purged', true],
      ]);
      assert.deepStrictEqual(backend.read('cut'), { title: 'cut' });
      assert.strictEqual(backend.docs.get('purged').deleted, true, 'the purge reached the backend as a deletion');
      assert.strictEqual(backend.docs.get('gone').deleted, true);
      assert.deepStrictEqual(replication.parked, []);
      // A parked id that becomes another collection's while the connector runs is forgotten by reSync().
      backend.refuse('late', { code: 'no' });
      await a.Task.set('late', { title: 'late' });
      await replication.awaitInSync();
      await a.Task.delete('late');
      await waitUntil(() => pushed.filter((id) => id === 'late').length === 2);
      await replication.awaitInSync();
      assert.deepStrictEqual(replication.parked, [{ id: 'late', reason: 'no' }], 'the deletion, refused too');
      await a.set('late', { $type: 'Note', title: 'a note now' });
      pushed.length = 0;
      await replication.reSync();
      await replication.awaitInSync();
      assert.deepStrictEqual(pushed, []);
      assert.deepStrictEqual(replication.parked, []);
      await replication.cancel();
      assert.deepStrictEqual(await saved(), {});
      // A checkpoint text whose parked rows do not all read: an entry that is no id, or has no reason, is left out;
      // a reason is kept to 64 characters. The row that reads is the backend's already: reSync() asks, and it has
      // nothing to say — no longer parked.
      const store = kvNamespace(a[DB].kv, 'connector');
      const text = JSON.parse(await store.get('main'));
      text.parked = { 'not an id': 'no', gone: 7, cut: 'x'.repeat(100) };
      await store.put('main', JSON.stringify(text));
      replication = start({ pull: undefined });
      await replication.awaitInitialReplication();
      assert.deepStrictEqual(replication.parked, [{ id: 'cut', reason: 'x'.repeat(64) }]);
      pushed.length = 0;
      await replication.reSync();
      await replication.awaitInSync();
      assert.deepStrictEqual(pushed, ['cut'], 'asked what the backend holds: a probe, nothing written');
      assert.deepStrictEqual(replication.parked, []);
    },
  );

  await t.test(
    'a handler that looks back says what it read again (reread): a state known is passed over — not landed, not counted, no event — a late arrival lands, an old tombstone deletes nothing made here since, a document refused as it was told is not said again until reSync(), a wrong reread is a failure',
    async (t2) => {
      const rules = { strict: true };
      const validated = {
        '~standard': {
          version: 1,
          vendor: 'test',
          validate: (value) =>
            rules.strict && value.title === 'bad' ? { issues: [{ message: 'no', path: ['title'] }] } : { value },
        },
      };
      const malformed = [];
      const logger = {
        debug() {},
        info() {},
        error() {},
        warn: (entry) => entry.event === 'connector.document.malformed' && malformed.push(entry.id),
      };
      const a = await open(t2, 'A', { schema: { entities: { Task: { schema: validated }, Note: {} } }, logger });
      await a.set('n1', { $type: 'Note', title: 'a note of this node’s' });
      // A backend that resumes by a stamp, in memory, and a handler that looks back over it by hand: the rows stamped
      // later than 5000 before the checkpoint, the checkpoint the newest stamp pulled through — never behind the one
      // handed in — and `reread` the rows at or behind it.
      const rows = new Map();
      const put = (id, data, at) => rows.set(id, { id, data, at });
      let answer = (page) => page;
      const handler = async (checkpoint, batchSize) => {
        const mark = checkpoint ?? 0;
        const list = [...rows.values()]
          .filter((row) => row.at > mark - 5000)
          .sort((x, y) => x.at - y.at)
          .slice(0, batchSize);
        return answer({
          documents: list.map(({ id, data }) => (data === null ? { id, deleted: true } : { id, data })),
          checkpoint: Math.max(mark, list.at(-1)?.at ?? 0),
          reread: list.filter((row) => row.at <= mark).length,
        });
      };
      put('t1', { title: 'fine' }, 1000);
      put('n1', { title: 'a task of the backend’s' }, 2000);
      put('x1', null, 2900);
      put('t2', { title: 'bad' }, 3000);
      // An id this node cannot carry is no document at all: logged, and where it is read again, logged once.
      put('no:id', { title: 'an id with a colon' }, 2950);
      const replication = replicate(a, {
        name: 'main',
        collection: 'Task',
        pull: { handler },
        live: false,
        retryTime: 5000,
      });
      t2.after(() => replication.cancel().catch(() => {}));
      const refused = [];
      const received = [];
      const errors = [];
      replication.on('refused', (event) => refused.push([event.id, event.reason]));
      replication.on('received', (event) => received.push(event));
      replication.on('error', (error) => errors.push(error));
      await replication.awaitInitialReplication();
      assert.deepStrictEqual(refused, [
        ['n1', 'collection'],
        ['t2', 'VALIDATION_FAILED'],
      ]);
      assert.deepStrictEqual(received, [{ documents: 3, applied: 1 }]);
      const before = replication.stats();
      assert.deepStrictEqual([before.pulled, before.applied, before.refused], [5, 1, 2]);
      assert.deepStrictEqual(malformed, ['no:id']);
      const length = a.log.length;
      // An edit here that no push carries (a pull alone): the record reads otherwise than the state known. And a
      // record made here under an id the backend holds a tombstone of — of which nothing is known any more.
      await a.Task.update('t1', { title: 'edited here' });
      await a.Task.set('x1', { title: 'made here since' });
      // reSync() reads the four again and has them judged anew. The state known is passed over — even over a record
      // that reads otherwise: nothing landed, nothing counted — and so is the old tombstone: no deletion of the
      // record made since. What is refused again is said again, as reSync() asks.
      await replication.reSync();
      let stats = replication.stats();
      assert.deepStrictEqual(refused.slice(2), [
        ['n1', 'collection'],
        ['t2', 'VALIDATION_FAILED'],
      ]);
      assert.deepStrictEqual([stats.pulled, stats.applied, stats.refused], [8, 1, 4]);
      assert.deepStrictEqual(malformed, ['no:id', 'no:id']);
      assert.deepStrictEqual(await a.get('t1'), { title: 'edited here', $type: 'Task' }, 'no landing over the edit');
      assert.deepStrictEqual(await a.get('x1'), { title: 'made here since', $type: 'Task' });
      assert.deepStrictEqual(received.slice(1), [{ documents: 1, applied: 0 }], 't2 alone was judged');
      assert.strictEqual(a.log.length, length + 2, 'the two writes here, and nothing of the pull');
      assert.deepStrictEqual(replication.checkpoint.pull, 3000);
      // A document that arrives late — stamped behind the checkpoint — lands; one that arrives late and is refused
      // is said.
      put('t3', { title: 'late' }, 1500);
      put('t4', { title: 'bad' }, 2500);
      await replication.reSync();
      stats = replication.stats();
      assert.deepStrictEqual([stats.pulled, stats.applied], [13, 2], 'n1, no:id, t2 again, and the two late ones');
      assert.deepStrictEqual(await a.get('t3'), { title: 'late', $type: 'Task' });
      assert.ok(refused.some(([id]) => id === 't4'));
      assert.deepStrictEqual(replication.checkpoint.pull, 3000, 'the checkpoint did not move back');
      assert.deepStrictEqual(errors, []);
      // A wrong `reread` is the handler's failure: told, the page not landed.
      answer = (page) => ({ ...page, reread: -1 });
      put('t5', { title: 'not yet' }, 4000);
      await replication.reSync();
      assert.strictEqual(errors.length, 1);
      assert.strictEqual(errors[0].direction, 'pull');
      assert.match(errors[0].cause.message, /reread/);
      assert.strictEqual(await a.get('t5'), null);
      await replication.cancel();
      // Without reSync() — a connector whose pulls a stream asks for — what was told is not said again, pull after
      // pull, and what is known moves no count.
      answer = (page) => page;
      let signal = null;
      const live = replicate(a, {
        name: 'main',
        collection: 'Task',
        pull: {
          handler,
          stream: (emit) => {
            signal = emit;
            return () => {};
          },
        },
        retryTime: 5000,
        safetyTime: 0,
      });
      t2.after(() => live.cancel().catch(() => {}));
      const told = [];
      const events = [];
      live.on('refused', (event) => told.push([event.id, event.reason]));
      live.on('received', (event) => events.push(event));
      await live.awaitInitialReplication();
      assert.deepStrictEqual(await a.get('t5'), { title: 'not yet', $type: 'Task' });
      // A connector started anew is told once of what its window holds that cannot land.
      assert.deepStrictEqual(told.sort(), [
        ['n1', 'collection'],
        ['t2', 'VALIDATION_FAILED'],
        ['t4', 'VALIDATION_FAILED'],
      ]);
      const quiet = live.stats();
      assert.deepStrictEqual(events, [{ documents: 3, applied: 1 }]);
      for (let i = 0; i < 3; i++) {
        signal('RESYNC');
        await waitUntil(() => live.stats().pulls === quiet.pulls + i + 1);
        await live.awaitInSync();
      }
      assert.deepStrictEqual(live.stats(), { ...quiet, pulls: quiet.pulls + 3 });
      assert.strictEqual(told.length, 3);
      assert.strictEqual(events.length, 1);
      assert.strictEqual(malformed.length, 4, 'logged once by the connector started anew, not at every pull');
      // A refused document that changes behind the checkpoint — the same stamp, another state — is judged again, and
      // said for what it holds now; one the database takes lands.
      put('t2', { title: 'bad', n: 2 }, 3000);
      put('t4', { title: 'good now' }, 2500);
      signal('RESYNC');
      await waitUntil(async () => (await a.get('t4')) !== null);
      await live.awaitInSync();
      assert.deepStrictEqual(told.slice(3), [['t2', 'VALIDATION_FAILED']]);
      assert.deepStrictEqual(await a.get('t4'), { title: 'good now', $type: 'Task' });
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

  await t.test(
    'modifier.pull runs before the JSON check, on a pull and on a conflict alike: what it answers must be JSON; the backend’s state is known by the raw value’s text — a Date by its JSON, a BigInt refused',
    async (t2) => {
      class Stamp {
        constructor(ms) {
          this.ms = ms;
        }
      }
      // What a backend's SDK hands over, made JSON by the application's modifier — once per document.
      const calls = [];
      const modifier = {
        pull: (data, id) => {
          calls.push(id);
          const out = {};
          for (const key of Object.keys(data)) {
            const value = data[key];
            if (value instanceof Date) out[key] = value.toISOString();
            else if (value instanceof Stamp) out[key] = value.ms;
            else if (key === 'n') out[key] = value * 10;
            else out[key] = value;
          }
          // A modifier that leaves a Date in is held to JSON all the same.
          if (id === 'd4') out.left = new Date(0);
          return out;
        },
        push: (data) => (typeof data.n === 'number' ? { ...data, n: data.n / 10 } : data),
      };
      const a = await open(t2, 'A');
      const pages = [
        [
          { id: 'd1', data: { title: 'date', due: new Date(0) } },
          { id: 'd2', data: { title: 'bigint', size: 10n } },
          { id: 'd3', data: { title: 'class', at: new Stamp(5) } },
          { id: 'd4', data: { title: 'left a date' } },
        ],
        // The same document with another date: another state, not an echo (every Date once read as `{}`).
        [{ id: 'd1', data: { title: 'date', due: new Date(1000) } }],
      ];
      let page = 0;
      const typed = replicate(a, {
        name: 'typed',
        collection: 'Task',
        live: false,
        pull: {
          handler: async (checkpoint) => {
            const at = typeof checkpoint === 'number' ? checkpoint : 0;
            if (at >= page) return { documents: [], checkpoint: at };
            return { documents: pages[at], checkpoint: at + 1 };
          },
        },
        modifier,
      });
      t2.after(() => typed.cancel().catch(() => {}));
      const refused = [];
      typed.on('refused', (event) => refused.push([event.direction, event.id, event.reason]));
      page = 1;
      await typed.awaitInitialReplication();
      assert.deepStrictEqual(await a.get('d1'), { title: 'date', due: '1970-01-01T00:00:00.000Z', $type: 'Task' });
      assert.deepStrictEqual(await a.get('d3'), { title: 'class', at: 5, $type: 'Task' });
      assert.strictEqual(await a.get('d2'), null, 'a BigInt has no JSON text: refused before the modifier');
      assert.strictEqual(await a.get('d4'), null, 'what the modifier answers must be JSON');
      assert.deepStrictEqual(refused, [
        ['pull', 'd2', 'value'],
        ['pull', 'd4', 'value'],
      ]);
      assert.deepStrictEqual(calls, ['d1', 'd3', 'd4']);
      page = 2;
      await typed.reSync();
      assert.deepStrictEqual(await a.get('d1'), { title: 'date', due: '1970-01-01T00:00:01.000Z', $type: 'Task' });
      await typed.cancel();

      // A conflict is judged the same way: through modifier.pull once, held to JSON — never flattened.
      const backend = createFakeBackend();
      const replication = connect(t2, a, backend, { name: 'conflicts', modifier, retryTime: 1500 });
      const conflicts = [];
      const errors = [];
      const parked = [];
      replication.on('conflict', (event) => conflicts.push(event));
      replication.on('error', (error) => errors.push(error));
      replication.on('refused', (event) => parked.push([event.direction, event.id, event.reason]));
      await replication.awaitInitialReplication();
      const id = await a.insert({ $type: 'Task', title: 'v1', n: 10 });
      await replication.awaitInSync();
      assert.deepStrictEqual(backend.read(id), { title: 'v1', n: 1 });
      // On the pull path (the backend moved under an unpushed edit): the remote comes through the modifier once.
      backend.fail('push', 1);
      await a.Task.update(id, { title: 'v2' });
      await waitUntil(() => errors.length === 1);
      calls.length = 0;
      backend.write(id, { title: 'backend v2', n: 2 });
      await waitUntil(() => conflicts.length === 1);
      assert.deepStrictEqual(conflicts[0].remote, { title: 'backend v2', n: 20 });
      assert.deepStrictEqual(calls, [id], 'modifier.pull once for the conflict');
      await waitUntil(async () => (await a.get(id))?.title === 'backend v2');
      assert.deepStrictEqual(await a.get(id), { title: 'backend v2', n: 20, $type: 'Task' });
      await replication.awaitInSync();
      // On the push path: a conflict answered with a Date lands through a modifier that converts it, and without one
      // is refused (value) — parked, never flattened into the record.
      for (const converted of [true, false]) {
        const db = await open(t2, converted ? 'converted' : 'raw');
        let answered = false;
        const dated = replicate(db, {
          name: 'dated',
          collection: 'Task',
          live: false,
          retryTime: 1500,
          ...(converted ? { modifier: { pull: (data) => ({ ...data, when: data.when.toISOString() }) } } : {}),
          push: {
            handler: async (rows) => {
              if (answered) return [];
              answered = true;
              return [{ id: rows[0].id, data: { title: 'remote', when: new Date(0) } }];
            },
          },
        });
        t2.after(() => dated.cancel().catch(() => {}));
        const told = [];
        dated.on('refused', (event) => told.push([event.direction, event.reason]));
        await dated.awaitInitialReplication();
        const { id: local } = await db.Task.insert({ title: 'local' });
        await dated.awaitInSync();
        if (converted) {
          assert.deepStrictEqual(told, []);
          assert.deepStrictEqual(await db.get(local), {
            title: 'remote',
            when: '1970-01-01T00:00:00.000Z',
            $type: 'Task',
          });
        } else {
          assert.deepStrictEqual(told, [['push', 'value']]);
          assert.strictEqual(dated.stats().parked, 1);
          assert.deepStrictEqual(await db.get(local), { title: 'local', $type: 'Task' }, 'never flattened');
        }
      }
    },
  );

  await t.test(
    'a restart carries what the backend was assumed to hold: an offline edit lands through the compare-and-set, a backend that moved meanwhile is a conflict — the digests kept with the checkpoint',
    async (t2) => {
      const backend = createFakeBackend();
      const a = await open(t2, 'A');
      const store = kvNamespace(a[DB].kv, 'connector');
      const first = connect(t2, a, backend, { live: false });
      await first.awaitInitialReplication();
      const id = await a.insert({ $type: 'Task', title: 'v1' });
      await first.awaitInSync();
      await first.cancel();
      const saved = JSON.parse(await store.get('main'));
      assert.deepStrictEqual(Object.keys(saved).sort(), ['known', 'parked', 'pull', 'pushed', 'refused']);
      assert.deepStrictEqual(saved.refused, []);
      assert.deepStrictEqual(saved.parked, {});
      assert.match(saved.known[id], /^[A-Za-z0-9_-]{22}$/, 'the digest of what the backend holds, with the checkpoint');
      // An edit while no connector runs; the pull cursor is before this node's own echo. A restart: the echo is
      // skipped, the edit lands through the compare-and-set — no conflict, nothing lost.
      await a.Task.update(id, { title: 'v2-local-edit' });
      const second = connect(t2, a, backend, { live: false });
      const conflicts = [];
      second.on('conflict', (event) => conflicts.push(event));
      await second.awaitInitialReplication();
      await second.awaitInSync();
      assert.deepStrictEqual(conflicts, []);
      assert.deepStrictEqual(await a.get(id), { title: 'v2-local-edit', $type: 'Task' });
      assert.deepStrictEqual(backend.read(id), { title: 'v2-local-edit' });
      // The same with the echo consumed before the stop (the pull cursor past it).
      await second.reSync();
      await second.cancel();
      await a.Task.update(id, { title: 'v3-local-edit' });
      const third = connect(t2, a, backend, { live: false });
      third.on('conflict', (event) => conflicts.push(event));
      await third.awaitInitialReplication();
      await third.awaitInSync();
      assert.deepStrictEqual(conflicts, []);
      assert.deepStrictEqual(backend.read(id), { title: 'v3-local-edit' });
      await third.cancel();
      // A backend that moved while no connector ran, under an offline edit: a conflict — the backend wins, told —
      // never the edit pushed over it, never the backend's state laid over the edit in silence.
      backend.set(id, { title: 'backend v4' });
      await a.Task.update(id, { title: 'v4-local-edit' });
      const fourth = connect(t2, a, backend, { live: false });
      fourth.on('conflict', (event) => conflicts.push(event));
      await fourth.awaitInitialReplication();
      await fourth.awaitInSync();
      assert.strictEqual(conflicts.length, 1);
      assert.deepStrictEqual(conflicts[0].local, { title: 'v4-local-edit' });
      assert.deepStrictEqual(conflicts[0].remote, { title: 'backend v4' });
      assert.deepStrictEqual(await a.get(id), { title: 'backend v4', $type: 'Task' });
      assert.deepStrictEqual(backend.read(id), { title: 'backend v4' });
      // A record deleted on both sides leaves no digest behind.
      await a.Task.delete(id);
      await fourth.awaitInSync();
      await fourth.cancel();
      assert.deepStrictEqual(JSON.parse(await store.get('main')).known, {});
    },
  );

  await t.test(
    'pushed never passes a pending turn: 25 records, batch 10, the second push failing, a restart pushes the fifteen',
    async (t2) => {
      const backend = createFakeBackend();
      const a = await open(t2, 'A');
      const first = connect(t2, a, backend, { live: false });
      await first.awaitInitialReplication();
      await first.cancel();
      for (let i = 0; i < 25; i++) await a.insert({ $type: 'Task', n: i });
      const { pull, push } = backend.handlers();
      let calls = 0;
      const failing = {
        pull,
        push: {
          handler: (rows) => {
            if (++calls === 2) throw new Error('backend down (push)');
            return push.handler(rows);
          },
        },
      };
      const second = connect(t2, a, backend, { ...failing, live: false, batchSize: 10, retryTime: 60_000 });
      const errors = [];
      second.on('error', (error) => errors.push(error));
      await waitUntil(() => errors.length === 1);
      assert.strictEqual(backend.docs.size, 10, 'the first batch landed');
      assert.strictEqual(second.stats().pending, 15);
      // The checkpoint stands before the oldest pending turn: a restart finds the fifteen in the log.
      assert.strictEqual(a.log.since(second.checkpoint.pushed).length, 15);
      await second.cancel();
      const third = connect(t2, a, backend, { live: false, batchSize: 10 });
      await third.awaitInitialReplication();
      await third.awaitInSync();
      assert.strictEqual(backend.docs.size, 25);
      assert.strictEqual(third.stats().pushed, 15, 'the fifteen, and nothing twice');
      assert.strictEqual(a.log.since(third.checkpoint.pushed).length, 0);
    },
  );

  await t.test(
    'a rebuild asks the backend what it holds: equal records are silent, differing ones conflicts, unknown ones made; sealed records never go',
    async (t2) => {
      const backend = createFakeBackend();
      backend.write('e1', { title: 'equal' });
      backend.write('d1', { title: 'backend' });
      const a = await open(t2, 'A');
      await a.set('e1', { $type: 'Task', title: 'equal' });
      await a.set('d1', { $type: 'Task', title: 'local' });
      await a.set('n1', { $type: 'Task', title: 'new' });
      const sealed = await a.insert({ $type: 'Task', title: 'secret' }, { encrypted: true });
      // A fresh connector with both halves: the backend pulled first, then every record asked about.
      const both = connect(t2, a, backend, { name: 'both', live: false });
      const conflicts = [];
      both.on('conflict', (event) => conflicts.push(event));
      await both.awaitInitialReplication();
      await both.awaitInSync();
      assert.deepStrictEqual(
        conflicts.map(({ id, local, remote }) => ({ id, local, remote })),
        [{ id: 'd1', local: { title: 'local' }, remote: { title: 'backend' } }],
      );
      assert.deepStrictEqual(await a.get('d1'), { title: 'backend', $type: 'Task' });
      assert.deepStrictEqual(backend.read('n1'), { title: 'new' });
      assert.deepStrictEqual(backend.read('e1'), { title: 'equal' });
      assert.strictEqual(backend.docs.get('e1').rev, 1, 'equal: nothing written');
      assert.strictEqual(backend.docs.get('d1').rev, 1, 'the backend won: nothing written');
      assert.strictEqual(backend.docs.has(sealed), false, 'a sealed record never goes');
      await both.cancel();
      // A push-only connector: every record is a probe — what the backend holds judged against the record.
      backend.set('e2', { title: 'equal' });
      backend.set('d2', { title: 'backend' });
      await a.set('e2', { $type: 'Task', title: 'equal' });
      await a.set('d2', { $type: 'Task', title: 'local' });
      await a.set('n2', { $type: 'Task', title: 'new' });
      const pushOnly = connect(t2, a, backend, { name: 'push-only', live: false, pull: undefined });
      const judged = [];
      pushOnly.on('conflict', (event) => judged.push(event));
      await pushOnly.awaitInitialReplication();
      await pushOnly.awaitInSync();
      const ids = judged.map(({ id }) => id).sort();
      assert.deepStrictEqual(ids, ['d2'], 'the differing record alone');
      assert.deepStrictEqual(await a.get('d2'), { title: 'backend', $type: 'Task' });
      assert.deepStrictEqual(backend.read('n2'), { title: 'new' });
      assert.strictEqual(backend.docs.get('e2').rev, 1, 'equal: silent');
      assert.strictEqual(backend.docs.has(sealed), false);
      assert.strictEqual(backend.docs.size, 6);
    },
  );

  await t.test(
    'the checkpoint is saved coalesced — one write in flight, the next after a gap — and cancel() saves what is dirty',
    async (t2) => {
      const backend = createFakeBackend();
      for (let i = 0; i < 35; i++) backend.write(`d${i}`, { n: i });
      const a = await open(t2, 'A');
      const kv = a[DB].kv;
      const puts = [];
      const put = kv.put.bind(kv);
      // A slow store: pages land while a write is in flight.
      kv.put = async (ns, key, value, options) => {
        if (ns === 'connector' && key === 'main') {
          puts.push(JSON.parse(value).pull);
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        return put(ns, key, value, options);
      };
      const store = kvNamespace(kv, 'connector');
      const replication = connect(t2, a, backend, { live: false, batchSize: 10 });
      await replication.awaitInitialReplication();
      assert.strictEqual(replication.checkpoint.pull, 35);
      assert.ok(puts.length <= 3, `four pages, ${puts.length} writes: ${puts.join(', ')}`);
      assert.strictEqual(puts[puts.length - 1], 35, 'the last write holds the end of the run');
      assert.strictEqual(JSON.parse(await store.get('main')).pull, 35);
      // A run cut short by cancel(): what landed is saved before cancel() resolves.
      for (let i = 35; i < 60; i++) backend.write(`d${i}`, { n: i });
      const resync = replication.reSync();
      await waitUntil(() => replication.stats().pulled > 35);
      await replication.cancel();
      await resync.catch(() => {});
      const text = JSON.parse(await store.get('main'));
      assert.strictEqual(text.pull, replication.checkpoint.pull, 'what was dirty at cancel is saved');
      assert.ok(text.pull > 35);
    },
  );

  await t.test(
    'stream pages and pulls run one after another: a RESYNC during a pull pulls again after it; a stream page never moves the checkpoint, the next pull does; awaitInSync and cancel wait for all of it',
    async (t2) => {
      const backend = createFakeBackend();
      backend.write('t1', { title: 'one' });
      const a = await open(t2, 'A');
      const { pull, push } = backend.handlers();
      let gate = null;
      let emitter = null;
      const gated = {
        pull: {
          handler: async (checkpoint, batchSize) => {
            if (gate !== null) await gate;
            return pull.handler(checkpoint, batchSize);
          },
          stream: (emit, context) => {
            emitter = emit;
            assert.ok(Object.hasOwn(context, 'checkpoint'), 'the stream is told the checkpoint');
            return pull.stream(emit, context);
          },
        },
        push,
      };
      const replication = connect(t2, a, backend, { ...gated, retryTime: 30 });
      await replication.awaitInitialReplication();
      assert.strictEqual(replication.checkpoint.pull, 1);
      // A page of the stream lands; the checkpoint stays where the last pull left it.
      backend.write('s1', { title: 'streamed' });
      await waitUntil(async () => (await a.get('s1')) !== null);
      assert.strictEqual(replication.checkpoint.pull, 1, 'a stream page never moves the checkpoint');
      // A pull held at the backend: a stream page and a RESYNC come meanwhile. The page waits behind the pull, the
      // RESYNC makes the pull run again after it, and the checkpoint ends past everything.
      let release = null;
      gate = new Promise((resolve) => {
        release = resolve;
      });
      const pulls = backend.calls.pull;
      const resync = replication.reSync();
      let inSync = false;
      replication.awaitInSync().then(() => {
        inSync = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      backend.write('s2', { title: 'behind the pull' });
      emitter('RESYNC');
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.strictEqual(await a.get('s2'), null, 'the stream page waits for the pull in flight');
      assert.strictEqual(inSync, false, 'awaitInSync waits for the queue');
      gate = null;
      release();
      await resync;
      await waitUntil(() => inSync);
      assert.deepStrictEqual((await a.get('s2')).title, 'behind the pull');
      assert.strictEqual(replication.checkpoint.pull, backend.changes.length, 'the pull after the RESYNC moved it');
      assert.ok(backend.calls.pull - pulls >= 2, `the RESYNC pulled again: ${backend.calls.pull - pulls} pulls`);
      // cancel() waits for the run in flight too.
      gate = new Promise((resolve) => {
        release = resolve;
      });
      replication.reSync().catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 10));
      let canceled = false;
      const canceling = replication.cancel().then(() => {
        canceled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.strictEqual(canceled, false);
      gate = null;
      release();
      await canceling;
      assert.strictEqual(replication.canceled, true);
    },
  );

  await t.test(
    'awaitInitialReplication resolves on success alone: a first pull that fails keeps it waiting until the retry lands',
    async (t2) => {
      const backend = createFakeBackend();
      backend.write('t1', { title: 'one' });
      const a = await open(t2, 'A');
      backend.fail('pull', 1);
      const replication = connect(t2, a, backend, { live: false, retryTime: 30 });
      const errors = [];
      replication.on('error', (error) => errors.push(error));
      let done = false;
      replication.awaitInitialReplication().then(() => {
        done = true;
      });
      await waitUntil(() => errors.length === 1);
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.strictEqual(done, false, 'the first pull failed: not initial yet');
      await waitUntil(() => done, { timeout: 5000 });
      assert.deepStrictEqual((await a.get('t1')).title, 'one');
      await replication.cancel();
      // The push half the same: an offline record whose first push fails keeps the initial replication waiting.
      await a.insert({ $type: 'Task', title: 'offline' });
      backend.fail('push', 1);
      const second = connect(t2, a, backend, { live: false, retryTime: 30 });
      const failures = [];
      second.on('error', (error) => failures.push(error));
      let settled = false;
      second.awaitInitialReplication().then(() => {
        settled = true;
      });
      await waitUntil(() => failures.length === 1);
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.strictEqual(settled, false);
      await waitUntil(() => settled, { timeout: 5000 });
      assert.strictEqual(backend.docs.size, 2);
    },
  );

  await t.test(
    'a stream that ends (END) is followed again after a backoff, from the checkpoint; a safety pull runs every safetyTime meanwhile',
    async (t2) => {
      const backend = createFakeBackend();
      backend.write('t1', { title: 'one' });
      const a = await open(t2, 'A');
      const { pull, push } = backend.handlers();
      const subscriptions = [];
      const emitters = [];
      let stops = 0;
      const quiet = {
        pull: {
          handler: pull.handler,
          stream: (emit, { checkpoint }) => {
            subscriptions.push(checkpoint);
            emitters.push(emit);
            return () => {
              stops++;
            };
          },
        },
        push,
      };
      assert.throws(() => replicate(a, { name: 'x', collection: 'Task', ...quiet, safetyTime: -1 }), {
        name: 'TypeError',
        message: /safetyTime/,
      });
      const replication = connect(t2, a, backend, { ...quiet, retryTime: 30, safetyTime: 40 });
      await replication.awaitInitialReplication();
      await waitUntil(() => subscriptions.length === 1);
      assert.strictEqual(subscriptions[0], 1, 'followed from the checkpoint');
      // The stream ends: stopped, followed again after the backoff from the checkpoint as it then stands, and pulled.
      backend.write('t2', { title: 'two' });
      const pulls = backend.calls.pull;
      emitters[0]('END');
      await waitUntil(() => subscriptions.length === 2, { timeout: 5000 });
      assert.strictEqual(stops, 1);
      assert.strictEqual(subscriptions[1], 1, 'followed again from the checkpoint as it stood: nothing in a gap');
      await waitUntil(async () => (await a.get('t2')) !== null, { timeout: 5000 });
      assert.ok(backend.calls.pull > pulls, 'pulled after the stream came back');
      await waitUntil(() => replication.checkpoint.pull === 2);
      // The stream is quiet; the safety pull lands what it missed.
      backend.write('t3', { title: 'three' });
      await waitUntil(async () => (await a.get('t3')) !== null, { timeout: 5000 });
      await replication.cancel();
      assert.strictEqual(stops, 2);
      // Without a safety pull a quiet stream is trusted.
      const trusting = connect(t2, a, backend, { ...quiet, name: 'trusting', retryTime: 30, safetyTime: 0 });
      await trusting.awaitInitialReplication();
      backend.write('t4', { title: 'four' });
      await new Promise((resolve) => setTimeout(resolve, 120));
      assert.strictEqual(await a.get('t4'), null);
    },
  );

  await t.test(
    'the database’s close cancels the connector: no timer, no stream, no handler called after',
    async (t2) => {
      const backend = createFakeBackend();
      const a = await open(t2, 'A');
      const { pull, push } = backend.handlers();
      let stops = 0;
      const polling = replicate(a, {
        name: 'poll',
        collection: 'Task',
        pull: { handler: pull.handler },
        push,
        retryTime: 20,
      });
      const streaming = replicate(a, {
        name: 'stream',
        collection: 'Task',
        pull: {
          handler: pull.handler,
          stream: () => () => {
            stops++;
          },
        },
        push,
      });
      await polling.awaitInitialReplication();
      await streaming.awaitInitialReplication();
      await a.close();
      assert.strictEqual(polling.canceled, true);
      assert.strictEqual(streaming.canceled, true);
      assert.strictEqual(polling.active, false);
      assert.strictEqual(stops, 1);
      const calls = backend.calls.pull;
      backend.write('t1', { title: 'after close' });
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.strictEqual(backend.calls.pull, calls, 'no handler called after the close');
      await assert.rejects(polling.awaitInSync(), { code: 'REPLICATION_FAILED' });
    },
  );
});
