'use strict';

// A writer and a follower hub over one MongoDB database, sharing its log
// (`mongoSharedLog`): the follower hosts — its hello answers the vector as the
// log moved it, a client's push is forwarded to the inbox and landed by the
// writer, `changes` comes from the log; a fresh client bootstraps from the
// writer (a follower serves no snapshot) — over the driver in memory.

const test = require('node:test');
const assert = require('node:assert');
const syncom = require('../src/all/all.js');
const { packOps } = require('../src/ops.js');
const { mongoEngine, mongoSharedLog } = require('../src/mongodb/mongodb.js');
const { createFakeMongo } = require('./utils/fake-mongo.js');
const { MemoryLink } = require('./utils/memory-link.js');
const { waitUntil } = require('./utils/mesh.js');
const { createSigner, forge } = require('./utils/signed.js');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const base = { logger: false, defer: 0 };

test('A writer and a follower hub over one MongoDB database', async (t) => {
  await t.test(
    'the follower hosts over the shared log: hello with the vector as the log moved it, a push forwarded to the inbox and landed by the writer, changes from the log; the bootstrap is the writer’s',
    async (t2) => {
      const client = createFakeMongo();
      const log = () => mongoSharedLog({ client, poll: 20 });
      const writer = await syncom.createDatabase({
        ...base,
        path: 'hub',
        engine: mongoEngine({ client }),
        sync: { sharedLog: log() },
      });
      t2.after(() => writer.close().catch(() => {}));
      const seeded = await writer.insert({ from: 'W', n: 0 });
      const follower = await syncom.createDatabase({
        ...base,
        path: 'hub',
        engine: mongoEngine({ client }),
        readOnly: true,
        sync: { sharedLog: log() },
      });
      t2.after(() => follower.close().catch(() => {}));
      assert.strictEqual(follower.readOnly, true);
      assert.strictEqual(follower.nodeId, writer.nodeId, 'one database, one node');
      const units = new Map([
        ['W', writer.sync.unit({ access: 'public' })],
        ['F', follower.sync.unit({ access: 'public' })],
      ]);
      // The load balancer: a fresh client lands on the writer (a follower serves no snapshot), then on any hub.
      units.set('LB', units.get('W'));
      const connect = (node) => new MemoryLink(units.get(node.url.slice('mem://'.length)));
      const client1 = await syncom.createDatabase({
        ...base,
        path: 'c1',
        engine: syncom.memoryEngine(),
        sync: { connect, autoStart: false },
      });
      t2.after(() => client1.close().catch(() => {}));
      const client2 = await syncom.createDatabase({
        ...base,
        path: 'c2',
        engine: syncom.memoryEngine(),
        sync: { connect, autoStart: false },
      });
      t2.after(() => client2.close().catch(() => {}));
      await client1.sync.addNode({ url: 'mem://LB' });
      await client2.sync.addNode({ url: 'mem://W' });
      await client1.sync.start();
      await client2.sync.start();
      await waitUntil(() => [client1, client2].every((c) => c.sync.peers()[0]?.subscribed));
      // Both bootstrapped from the writer: its record came with the snapshot, positioned in the shared log.
      assert.deepStrictEqual(await client1.get(seeded), { from: 'W', n: 0 });
      assert.deepStrictEqual(await client2.get(seeded), { from: 'W', n: 0 });
      assert.strictEqual(client1.sync.listNodes()[0].remote.epoch, 'shared:syncom');
      assert.match(client1.sync.listNodes()[0].cursor, /^[a-z0-9]+\.\d+$/);
      // The load balancer moves client1 to the follower: the same epoch, so it resumes from its cursor there.
      await client1.sync.stop();
      units.set('LB', units.get('F'));
      await client1.sync.start();
      await waitUntil(() => client1.sync.peers()[0]?.subscribed && follower.sync.hosted().length >= 1);

      // A client of the follower writes: forwarded to the inbox, landed by the writer, out through the log.
      const a = await client1.insert({ from: 'C1', n: 1 });
      await waitUntil(() => writer.hasRecord(a));
      assert.deepStrictEqual(await writer.get(a), { from: 'C1', n: 1 });
      await waitUntil(() => client2.hasRecord(a));
      assert.deepStrictEqual(
        await client2.get(a),
        { from: 'C1', n: 1 },
        'through the writer’s log to the other client',
      );
      await waitUntil(() => follower.hasRecord(a));
      assert.deepStrictEqual(
        await follower.get(a),
        { from: 'C1', n: 1 },
        'the follower hears the record through the engine',
      );
      assert.ok(follower.sync.shared().forwarded >= 1);
      assert.strictEqual(follower.sync.shared().shadow, true, 'the follower keeps the vector as the log moves it');
      assert.ok(writer.sync.shared().applied >= 1, 'the writer applied the inbox');

      // The writer writes: both clients hear it — one from the writer's feed, one from the follower's, both from the log.
      const b = await writer.insert({ from: 'W', n: 2 });
      await waitUntil(() => client1.hasRecord(b) && client2.hasRecord(b));
      const c = await client2.insert({ from: 'C2', n: 3 });
      await waitUntil(() => client1.hasRecord(c));
      assert.deepStrictEqual(await client1.get(c), { from: 'C2', n: 3 });

      // The follower's hello answers the vector as the log moved it — the writer's own stream included.
      const link = new MemoryLink(units.get('F'));
      const hello = await link.call('syncom/hello', { node: 'probe', version: 1 });
      assert.strictEqual(hello.epoch, 'shared:syncom');
      assert.strictEqual(hello.vector[writer.nodeId], writer.vector[writer.nodeId], 'as the writer’s log stands');
      assert.strictEqual(hello.vector[client1.nodeId], client1.vector[client1.nodeId]);
      // A push to the follower is forwarded; a duplicate and a gap are told apart by the shadow vector.
      const op = (seq, id, data) => ({ origin: 'probe', seq, ts: Date.now() + seq, type: 'write', id, data });
      const first = await link.call('syncom/push', { ops: packOps([op(1, 'p1', { n: 1 }), op(2, 'p2', { n: 2 })]) });
      assert.strictEqual(first.forwarded, true);
      assert.strictEqual(first.applied, 2);
      assert.deepStrictEqual(first.vector, { probe: 2 });
      const again = await link.call('syncom/push', { ops: packOps([op(2, 'p2', { n: 2 }), op(4, 'p4', { n: 4 })]) });
      assert.strictEqual(again.duplicates, 1);
      assert.strictEqual(again.gaps, 1);
      assert.strictEqual(again.applied, 0);
      const malformed = await link.call('syncom/push', {
        ops: packOps([{ origin: 'probe', seq: 3, ts: 1, type: 'write' }]),
      });
      assert.strictEqual(malformed.malformed, 1);
      await waitUntil(() => writer.hasRecord('p2'));
      assert.deepStrictEqual(await writer.get('p1'), { n: 1 });

      // A fresh client of the writer bootstraps from its snapshot, positioned in the log, and goes on from there.
      const client3 = await syncom.createDatabase({
        ...base,
        path: 'c3',
        engine: syncom.memoryEngine(),
        sync: { connect, autoStart: false },
      });
      t2.after(() => client3.close().catch(() => {}));
      const bootstraps = [];
      client3.sync.on('bootstrap', (event) => bootstraps.push(event));
      await client3.sync.addNode({ url: 'mem://W' });
      await client3.sync.start();
      await waitUntil(() => client3.sync.peers()[0]?.subscribed && client3.hasRecord(c));
      assert.strictEqual(bootstraps.length, 1);
      assert.deepStrictEqual(await client3.get('p2'), { n: 2 });
      const d = await writer.insert({ from: 'W', n: 4 });
      await waitUntil(() => client3.hasRecord(d));
      assert.deepStrictEqual(await client3.get(d), { from: 'W', n: 4 });
      assert.strictEqual(follower.sync.hosted().length >= 1, true);
    },
  );

  await t.test(
    'a read-only hub serves no snapshot: 403 READ_ONLY; the client bootstraps from a hub that writes',
    async (t2) => {
      const client = createFakeMongo();
      const log = () => mongoSharedLog({ client, poll: 20 });
      const writer = await syncom.createDatabase({
        ...base,
        path: 'hub',
        engine: mongoEngine({ client }),
        sync: { sharedLog: log() },
      });
      t2.after(() => writer.close().catch(() => {}));
      const seeded = await writer.insert({ n: 0 });
      const follower = await syncom.createDatabase({
        ...base,
        path: 'hub',
        engine: mongoEngine({ client }),
        readOnly: true,
        sync: { sharedLog: log() },
      });
      t2.after(() => follower.close().catch(() => {}));
      const units = new Map([
        ['W', writer.sync.unit({ access: 'public' })],
        ['F', follower.sync.unit({ access: 'public' })],
      ]);
      // The follower refuses the snapshot by code: its shadow of the vector runs ahead of its engine.
      const link = new MemoryLink(units.get('F'));
      await link.call('syncom/hello', { node: 'probe', version: 1 });
      await assert.rejects(
        () => link.call('syncom/snapshot', { cursor: null }),
        (error) => error.code === 403 && error.reason === 'READ_ONLY',
      );
      // A fresh client the load balancer sent to the follower is told so, holds nothing, and bootstraps once it
      // lands on the writer; from then on it follows on any hub.
      units.set('LB', units.get('F'));
      const connect = (node) => new MemoryLink(units.get(node.url.slice('mem://'.length)));
      const c = await syncom.createDatabase({
        ...base,
        path: 'c',
        engine: syncom.memoryEngine(),
        sync: { connect, autoStart: false },
      });
      t2.after(() => c.close().catch(() => {}));
      const errors = [];
      c.sync.on('error', (error) => errors.push(error));
      await c.sync.addNode({ url: 'mem://LB' });
      await c.sync.start();
      await waitUntil(() => errors.some((error) => error.code === 403 && error.reason === 'READ_ONLY'), {
        timeout: 5000,
      });
      assert.strictEqual(c.hasRecord(seeded), false);
      await c.sync.stop();
      units.set('LB', units.get('W'));
      await c.sync.start();
      await waitUntil(() => c.hasRecord(seeded), { timeout: 5000 });
      await c.sync.stop();
      units.set('LB', units.get('F'));
      await c.sync.start();
      await waitUntil(() => c.sync.peers()[0]?.subscribed);
      const b = await writer.insert({ n: 2 });
      await waitUntil(() => c.hasRecord(b), { timeout: 5000 });
      assert.deepStrictEqual(await c.get(b), { n: 2 });
    },
  );

  await t.test(
    'a hole in the topic is told (SHARED_LOG_FAILED hole) and the hubs go on; the writer trims the inbox past its cursor alone',
    async (t2) => {
      const client = createFakeMongo();
      const log = () => mongoSharedLog({ client, poll: 20, gapTimeout: 60 });
      const writer = await syncom.createDatabase({
        ...base,
        path: 'hub',
        engine: mongoEngine({ client }),
        sync: { sharedLog: log() },
      });
      t2.after(() => writer.close().catch(() => {}));
      const follower = await syncom.createDatabase({
        ...base,
        path: 'hub',
        engine: mongoEngine({ client }),
        readOnly: true,
        sync: { sharedLog: log() },
      });
      t2.after(() => follower.close().catch(() => {}));
      const errors = { writer: [], follower: [] };
      writer.sync.on('error', (error) => errors.writer.push(error));
      follower.sync.on('error', (error) => errors.follower.push(error));
      const a = await writer.insert({ n: 1 });
      await waitUntil(() => follower.sync.shared().entries >= 1);
      // An appender that took a number and died before its insert: the next entry sits past a hole.
      const heads = client.db('syncom').collection('shared_heads');
      await heads.updateOne({ _id: 'syncom' }, { $inc: { next: 1 } });
      const b = await writer.insert({ n: 2 });
      await waitUntil(
        () => errors.follower.some((error) => error.code === 'SHARED_LOG_FAILED' && error.reason === 'hole'),
        {
          timeout: 5000,
        },
      );
      const hole = errors.follower.find((error) => error.reason === 'hole');
      assert.strictEqual(hole.topic, 'syncom');
      assert.match(hole.cursor, /^[a-z0-9]+\.\d+$/);
      assert.strictEqual(follower.sync.shared().holes, 1);
      // The hubs go on: the entry past the hole is read and the follower's shadow moved by it.
      await waitUntil(() => follower.sync.shared().shadow === true && follower.sync.shared().entries >= 2);
      const link = new MemoryLink(follower.sync.unit({ access: 'public' }));
      const hello = await link.call('syncom/hello', { node: 'probe', version: 1 });
      assert.strictEqual(hello.vector[writer.nodeId], writer.vector[writer.nodeId]);
      assert.ok(a !== b);
      // Pushes forwarded through the follower land at the writer; every 64 inbox entries the writer trims the inbox
      // past its cursor — the topic is not retention's to trim here.
      const op = (seq) => ({
        origin: 'probe',
        seq,
        ts: Date.now() + seq,
        type: 'write',
        id: `p${seq}`,
        data: { n: seq },
      });
      for (let seq = 1; seq <= 70; seq++) await link.call('syncom/push', { ops: packOps([op(seq)]) });
      await waitUntil(() => writer.hasRecord('p70'), { timeout: 5000 });
      await waitUntil(async () => ((await log().head('syncom.inbox'))?.first ?? 1) > 1, { timeout: 5000 });
      const inbox = await log().head('syncom.inbox');
      assert.ok(inbox.first >= 64, `trimmed past what the writer landed (first ${inbox.first})`);
      assert.strictEqual((await log().head('syncom')).first, 1, 'the topic is left as it is');
    },
  );

  // A writer and a follower over one fake MongoDB, sharing its log; `sync` is spread into both.
  const pair = async (t2, sync = {}) => {
    const client = createFakeMongo();
    const log = () => mongoSharedLog({ client, poll: 20 });
    const writer = await syncom.createDatabase({
      ...base,
      path: 'hub',
      engine: mongoEngine({ client }),
      sync: { ...sync, sharedLog: log() },
    });
    t2.after(() => writer.close().catch(() => {}));
    const follower = await syncom.createDatabase({
      ...base,
      path: 'hub',
      engine: mongoEngine({ client }),
      readOnly: true,
      sync: { ...sync, sharedLog: log() },
    });
    t2.after(() => follower.close().catch(() => {}));
    const probe = async (node = 'probe', hello = {}) => {
      const link = new MemoryLink(follower.sync.unit({ access: 'public' }));
      const answer = await link.call('syncom/hello', { node, version: 1, ...hello });
      return { link, answer };
    };
    return { client, log, writer, follower, probe };
  };
  const op = (seq, id, data, more = {}) => ({
    origin: 'probe',
    seq,
    ts: Date.now() + seq,
    type: 'write',
    id,
    data,
    ...more,
  });

  await t.test(
    'authorizeWrite rules the inbox too: a push forwarded by a follower is refused by the writer’s rule, logged as a scrub, told',
    async (t2) => {
      const authorizeWrite = ({ op: pushed }) => !(pushed.type === 'write' && pushed.data?.forbidden === true);
      const { writer, follower, probe } = await pair(t2, { authorizeWrite });
      const refused = [];
      writer.sync.on('refused', (event) => refused.push(event));
      const { link } = await probe();
      const answer = await link.call('syncom/push', {
        ops: packOps([op(1, 'ok1', { n: 1 }), op(2, 'bad', { forbidden: true })]),
      });
      assert.strictEqual(answer.forwarded, true);
      assert.strictEqual(answer.applied, 2, 'forwarded both: the rule is the writer’s');
      await waitUntil(() => writer.hasRecord('ok1'), { timeout: 5000 });
      await waitUntil(() => refused.some((event) => event.via === 'inbox' && event.reason === 'rule'), {
        timeout: 5000,
      });
      assert.deepStrictEqual(
        refused.filter((event) => event.via === 'inbox'),
        [{ node: 'probe', reason: 'rule', count: 1, via: 'inbox' }],
      );
      assert.strictEqual(writer.hasRecord('bad'), false);
      const held = writer.log.entriesOf('bad');
      assert.strictEqual(held.length, 1, 'logged as a scrub leaves it: no gap in the stream');
      assert.strictEqual(held[0].skipped, true);
      assert.strictEqual(held[0].scrubbed, true);
      // The scrub reaches the topic: the follower's shadow moves past it, nothing is dropped.
      await waitUntil(async () => (await probe('late')).answer.vector.probe === 2, { timeout: 5000 });
      assert.strictEqual(follower.hasRecord('bad'), false);
      // The manager's rule is every unit's: a push to the writer itself is refused the same way.
      const direct = new MemoryLink(writer.sync.unit({ access: 'public' }));
      await direct.call('syncom/hello', { node: 'direct', version: 1 });
      const own = await direct.call('syncom/push', {
        ops: packOps([{ ...op(1, 'bad2', { forbidden: true }), origin: 'direct' }]),
      });
      assert.strictEqual(own.refused.length, 1);
      assert.strictEqual(writer.hasRecord('bad2'), false);
      // A unit that names its own rule stands over the manager's.
      const lax = new MemoryLink(writer.sync.unit({ access: 'public', authorizeWrite: () => true }));
      await lax.call('syncom/hello', { node: 'lax', version: 1 });
      await lax.call('syncom/push', { ops: packOps([{ ...op(1, 'bad3', { forbidden: true }), origin: 'lax' }]) });
      assert.strictEqual(writer.hasRecord('bad3'), true);
      await assert.rejects(
        () => syncom.createDatabase({ ...base, path: 'x', engine: syncom.memoryEngine(), sync: { authorizeWrite: 7 } }),
        { name: 'TypeError' },
      );
    },
  );

  await t.test(
    'a follower verifies what it forwards: a forged op is refused at the follower, never forwarded',
    async (t2) => {
      const { writer, follower } = await pair(t2, { signatures: 'require' });
      const refused = [];
      follower.sync.on('refused', (event) => refused.push(event));
      const signer = await createSigner();
      // The proof of the key is another rule's (SEC-4): off here, so the signatures alone are under test.
      const link = new MemoryLink(follower.sync.unit({ access: 'public', prove: false }));
      await link.call('syncom/hello', { node: signer.id, version: 1 });
      const good = await signer.sign({ seq: 1, ts: Date.now(), type: 'write', id: 'g1', data: { n: 1 } });
      const forged = forge(await signer.sign({ seq: 2, ts: Date.now() + 1, type: 'write', id: 'f2', data: { n: 2 } }));
      const unsigned = { origin: signer.id, seq: 3, ts: Date.now() + 2, type: 'write', id: 'u3', data: { n: 3 } };
      const answer = await link.call('syncom/push', { ops: packOps([good, forged, unsigned]) });
      assert.strictEqual(answer.forwarded, true);
      assert.strictEqual(answer.applied, 1, 'the signed op alone went to the inbox');
      assert.strictEqual(answer.forged, 1);
      assert.strictEqual(answer.unsigned, 1);
      assert.deepStrictEqual(refused.map((event) => [event.reason, event.count]).sort(), [
        ['forged', 1],
        ['unsigned', 1],
      ]);
      await waitUntil(() => writer.hasRecord('g1'), { timeout: 5000 });
      assert.strictEqual(writer.hasRecord('f2'), false);
      assert.strictEqual(writer.hasRecord('u3'), false);
      assert.strictEqual(writer.sync.shared().applied, 1, 'the writer found one op in the inbox');
    },
  );

  await t.test(
    'a forwarded op the writer did not take is told in the topic (dropped) and the follower’s hold on the stream let go; the client’s genuine op is forwarded then',
    async (t2) => {
      const scope = (id, data) => data.$type ?? '*';
      const { client, writer, follower, probe } = await pair(t2, { scope });
      const refused = [];
      writer.sync.on('refused', (event) => refused.push(event));
      const { link } = await probe('probe', { scopes: ['A'] });
      // Declared in scope A, the record scopes to B: the writer refuses it as out of scope — not logged, a gap.
      const first = await link.call('syncom/push', { ops: packOps([op(1, 'out', { $type: 'B' }, { scope: 'A' })]) });
      assert.strictEqual(first.applied, 1, 'forwarded: the follower cannot read the record');
      await waitUntil(() => refused.some((event) => event.via === 'inbox' && event.reason === 'scope'), {
        timeout: 5000,
      });
      assert.strictEqual(writer.hasRecord('out'), false);
      // The writer told the topic, the follower let go: its shadow never moved past the op.
      const entries = client.db('syncom').collection('shared');
      const droppedEntries = async () =>
        (await entries.find({ topic: 'syncom' }).toArray()).filter(
          (doc) => typeof doc.v === 'string' && doc.v.includes('"dropped"'),
        );
      await waitUntil(async () => (await droppedEntries()).length >= 1, { timeout: 5000 });
      const [told] = await droppedEntries();
      const parsed = JSON.parse(told.v);
      assert.deepStrictEqual(parsed.dropped, [['probe@A', 1]]);
      assert.match(parsed.inbox, /^[a-z0-9]+\.\d+$/);
      assert.strictEqual(writer.sync.shared().dropped, 1);
      await waitUntil(async () => follower.sync.shared().entries >= 1);
      const { answer } = await probe('again', { scopes: ['A'] });
      assert.strictEqual(answer.vector['probe@A'], undefined, 'the shadow holds nothing of the dropped op');
      // The client's genuine op at that seq is forwarded, and lands.
      const second = await link.call('syncom/push', { ops: packOps([op(1, 'in', { $type: 'A' }, { scope: 'A' })]) });
      assert.strictEqual(second.applied, 1, 'not a duplicate: the hold was let go');
      await waitUntil(() => writer.hasRecord('in'), { timeout: 5000 });
      assert.deepStrictEqual(await writer.get('in'), { $type: 'A' });
    },
  );

  await t.test(
    'a follower’s shadow moves on topic entries alone; a forwarded op is held until it lands',
    async (t2) => {
      const { writer, follower, probe } = await pair(t2);
      const seeded = await writer.insert({ n: 0 });
      await waitUntil(() => follower.sync.shared().entries >= 1);
      // The writer's consumer stopped: the inbox is read by nobody.
      await writer.sync.stop();
      const { link } = await probe();
      const first = await link.call('syncom/push', { ops: packOps([op(1, 'p1', { n: 1 })]) });
      assert.strictEqual(first.applied, 1);
      assert.deepStrictEqual(first.vector, { probe: 1 }, 'the answer says the op went in');
      assert.strictEqual((await probe('other')).answer.vector.probe, undefined, 'the shadow moves on the topic alone');
      // Held: the same op again is a duplicate, the next one follows at once.
      const again = await link.call('syncom/push', { ops: packOps([op(1, 'p1', { n: 1 }), op(2, 'p2', { n: 2 })]) });
      assert.strictEqual(again.duplicates, 1);
      assert.strictEqual(again.applied, 1);
      // The writer lands the inbox: the topic shows the ops, the shadow moves past them.
      await writer.sync.start();
      await waitUntil(() => writer.hasRecord('p2'), { timeout: 5000 });
      await waitUntil(async () => (await probe('late')).answer.vector.probe === 2, { timeout: 5000 });
      assert.strictEqual(follower.hasRecord(seeded), true);
    },
  );

  await t.test(
    'a follower without an inbox refuses a push with 503 READ_ONLY; without a shared log it does not host',
    async (t2) => {
      const client = createFakeMongo();
      const writer = await syncom.createDatabase({ ...base, path: 'hub', engine: mongoEngine({ client }) });
      t2.after(() => writer.close().catch(() => {}));
      const plain = await syncom.createDatabase({
        ...base,
        path: 'hub',
        engine: mongoEngine({ client }),
        readOnly: true,
      });
      t2.after(() => plain.close().catch(() => {}));
      assert.throws(() => plain.sync.unit(), { code: 'READ_ONLY', reason: 'hosting', message: /without a shared log/ });
      const log = mongoSharedLog({ client, poll: 20 });
      const follower = await syncom.createDatabase({
        ...base,
        path: 'hub',
        engine: mongoEngine({ client }),
        readOnly: true,
        sync: { sharedLog: { log, inbox: false } },
      });
      t2.after(() => follower.close().catch(() => {}));
      assert.strictEqual(follower.sync.shared().inbox, false);
      const link = new MemoryLink(follower.sync.unit({ access: 'public' }));
      await link.call('syncom/hello', { node: 'probe', version: 1 });
      await assert.rejects(
        () =>
          link.call('syncom/push', {
            ops: packOps([{ origin: 'probe', seq: 1, ts: Date.now(), type: 'write', id: 'x', data: {} }]),
          }),
        (error) => error.code === 503 && error.reason === 'READ_ONLY',
      );
      // A follower serves no snapshot, inbox or not.
      await assert.rejects(
        () => link.call('syncom/snapshot', { cursor: null }),
        (error) => error.code === 403 && error.reason === 'READ_ONLY',
      );
      await sleep(10);
    },
  );
});
