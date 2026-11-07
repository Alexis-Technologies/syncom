'use strict';

// The host's rules and the dialer's: a write a host refuses (`authorizeWrite`)
// is scrubbed, relayed as a no-op and reverted by the pusher; an op a dialer
// withholds (`beforeSend`) goes as its header; a peer proves it holds the key
// that is its id (`prove`); a host takes scopes back (`revoke`) and the peer
// forgets what it held of them; a thin client queries a host (`query`,
// `count`) in its scopes; `forget(id)` is a record gone here with no op.

const test = require('node:test');
const assert = require('node:assert');
const syncom = require('../src/all/all.js');
const { packOps } = require('../src/ops.js');
const { createMesh, settle, waitUntil } = require('./utils/mesh.js');
const { MemoryLink } = require('./utils/memory-link.js');
const { createSigner } = require('./utils/signed.js');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const scope = (id, data) => data.$type ?? '*';

test('Rules on the host and on the dialer', async (t) => {
  const engine = syncom.memoryEngine();
  const createStorage = async (t2, name, options = {}) => {
    const storage = await syncom.createDatabase({
      engine,
      path: `${t2.name}/${name}`,
      logger: false,
      defer: 0,
      ...options,
    });
    t2.after(() => storage.close().catch(() => {}));
    return storage;
  };

  await t.test(
    'authorizeWrite: a refused op is logged as a scrub, relayed as a no-op to the nodes behind the host, and the pusher reverts to what the host holds (WRITE_REFUSED)',
    async (t2) => {
      let admin = null;
      const authorizeWrite = ({ op, peer, current, after }) => {
        // Only the admin deletes; nobody writes a `locked` field; a new record needs a title.
        if (op.type === 'delete' && peer?.node !== admin) return false;
        if (after !== null && after.locked === true && current?.locked !== true) return false;
        if (current === null && after !== null && after.title === undefined) return false;
        return true;
      };
      const mesh = await createMesh(
        t2,
        ['H', 'A', 'B'],
        [
          ['A', 'H'],
          ['B', 'H'],
        ],
        createStorage,
        {
          unit: { access: 'public', authorizeWrite },
        },
      );
      const [h, a, b] = ['H', 'A', 'B'].map((name) => mesh.get(name));
      admin = b.nodeId;
      await a.sync.awaitInitialReplication();
      await b.sync.awaitInitialReplication();
      const errors = [];
      a.sync.on('error', (error) => errors.push(error));
      const refusedAtHost = [];
      h.sync.on('refused', (event) => refusedAtHost.push(event));
      const id = await a.insert({ title: 'kept', n: 1 });
      await settle([h, a, b]);
      assert.deepStrictEqual(await b.get(id), { title: 'kept', n: 1 });

      // A delete by a node that may not: refused at the host, B never sees it, A gets its record back.
      await a.delete(id);
      await waitUntil(() => errors.some((error) => error.code === 'WRITE_REFUSED'));
      await settle([h, a, b]);
      assert.deepStrictEqual(await h.get(id), { title: 'kept', n: 1 }, 'the host kept the record');
      assert.deepStrictEqual(await b.get(id), { title: 'kept', n: 1 }, 'nothing of the delete reached B');
      assert.deepStrictEqual(await a.get(id), { title: 'kept', n: 1 }, 'A was set back to what the host holds');
      const [refusal] = errors.filter((error) => error.code === 'WRITE_REFUSED');
      assert.strictEqual(refusal.origin, a.nodeId);
      assert.strictEqual(refusal.id, id);
      assert.strictEqual(refusal.own, true);
      assert.deepStrictEqual(refusal.current, { title: 'kept', n: 1 });
      assert.deepStrictEqual(refusedAtHost, [{ node: a.nodeId, reason: 'rule', count: 1 }]);
      // The host logged the refused op as a scrub leaves it — skipped, no payload — and relayed it so: no gap.
      const held = h.log.entriesOf(id).filter((entry) => entry.op.type === 'delete' && entry.op.origin === a.nodeId);
      assert.strictEqual(held.length, 1);
      assert.strictEqual(held[0].skipped, true);
      assert.strictEqual(held[0].scrubbed, true);
      assert.strictEqual(held[0].op.scrubbed, true);
      assert.deepStrictEqual(a.vector, h.vector, 'no gap: every stream read to its end on both sides');
      assert.deepStrictEqual(b.vector, h.vector);
      // The admin deletes: allowed everywhere.
      await b.delete(id);
      await settle([h, a, b]);
      assert.strictEqual(await a.get(id), null);

      // A refused insert: the host holds nothing, so the pusher deletes its own copy.
      const titleless = await a.insert({ n: 2 });
      await waitUntil(() => errors.filter((error) => error.code === 'WRITE_REFUSED').length >= 2);
      await settle([h, a, b]);
      assert.strictEqual(await a.get(titleless), null, 'reverted: forgotten here, no op (the host holds nothing)');
      assert.strictEqual(
        a.log.entriesOf(titleless).every((entry) => entry.skipped === true),
        true,
      );
      assert.strictEqual(await h.get(titleless), null);
      assert.strictEqual(await b.get(titleless), null);
      // A field the rule forbids on a record that stands: the host and B keep the record as it was, A is set back.
      const other = await a.insert({ title: 'other' });
      await settle([h, a, b]);
      await a.update(other, { locked: true, n: 3 });
      await waitUntil(() => errors.filter((error) => error.code === 'WRITE_REFUSED').length >= 3);
      await settle([h, a, b]);
      assert.deepStrictEqual(await a.get(other), { title: 'other' });
      assert.deepStrictEqual(await b.get(other), { title: 'other' });
      assert.strictEqual(
        errors.filter((error) => error.code === 'WRITE_REFUSED').length,
        3,
        'a revert is never reverted again',
      );
    },
  );

  await t.test(
    'authorizeWrite that throws fails the page; a refusal of a relayed op is reported, not reverted',
    async (t2) => {
      const host = await createStorage(t2, 'H');
      const unit = host.sync.unit({
        access: 'public',
        authorizeWrite: ({ op }) => {
          if (op.id === 'boom') throw new Error('rule broke');
          return op.id !== 'no';
        },
      });
      const link = new MemoryLink(unit);
      await link.call('syncom/hello', { node: 'peer', version: 1 });
      const op = (seq, id) => ({ origin: 'other', seq, ts: Date.now() + seq, type: 'write', id, data: { n: seq } });
      await assert.rejects(() => link.call('syncom/push', { ops: packOps([op(1, 'boom')]) }), /rule broke/);
      const answer = await link.call('syncom/push', { ops: packOps([op(1, 'yes'), op(2, 'no'), op(3, 'also')]) });
      assert.strictEqual(answer.applied, 3, 'the refused op is accepted (logged, skipped): the stream moves on');
      assert.strictEqual(answer.skipped, 1);
      assert.deepStrictEqual(answer.refused, [{ origin: 'other', seq: 2, scope: null, id: 'no', current: null }]);
      assert.deepStrictEqual(answer.vector, { other: 3 });
      assert.deepStrictEqual(await host.get('yes'), { n: 1 });
      assert.strictEqual(await host.get('no'), null);
      assert.deepStrictEqual(await host.get('also'), { n: 3 });
      assert.throws(() => host.sync.unit({ authorizeWrite: 'no' }), { name: 'TypeError' });
    },
  );

  await t.test(
    'beforeSend: an op the dialer withholds goes as its header — a no-op at the host, no gap in the stream, the payload kept in the dialer’s log',
    async (t2) => {
      const mesh = await createMesh(t2, ['H', 'A'], [['A', 'H']], createStorage, {
        nodes: {
          A: { sync: { hooks: { beforeSend: ({ op, peer }) => !(op.data?.secret === true && peer.node !== null) } } },
        },
      });
      const [h, a] = ['H', 'A'].map((name) => mesh.get(name));
      await a.sync.awaitInitialReplication();
      const open = await a.insert({ n: 1 });
      const secret = await a.insert({ n: 2, secret: true });
      const after = await a.insert({ n: 3 });
      await settle([h, a]);
      assert.deepStrictEqual(await h.get(open), { n: 1 });
      assert.strictEqual(await h.get(secret), null, 'the withheld op landed nothing');
      assert.deepStrictEqual(await h.get(after), { n: 3 }, 'the stream went on past it');
      assert.deepStrictEqual(a.vector, h.vector, 'no gap');
      const entries = h.log.entriesOf(secret);
      assert.strictEqual(entries.length, 1);
      assert.strictEqual(entries[0].scrubbed, true);
      assert.strictEqual(entries[0].skipped, true);
      assert.strictEqual(entries[0].op.data, undefined);
      assert.strictEqual(entries[0].op.scrubbed, true);
      assert.deepStrictEqual(a.log.entriesOf(secret)[0].op.data, { n: 2, secret: true }, 'the dialer’s log is whole');
      assert.deepStrictEqual(await a.get(secret), { n: 2, secret: true });
      // The host relays the header on: a node behind it sees no gap either.
      const b = await createStorage(t2, 'B', { sync: { connect: mesh.connect } });
      await b.sync.addNode({ url: 'mem://H' });
      await waitUntil(() => b.hasRecord(after));
      assert.strictEqual(await b.get(secret), null);
      assert.deepStrictEqual(await b.get(after), { n: 3 });
      assert.deepStrictEqual(b.vector, h.vector);
    },
  );

  await t.test(
    'prove: a require host hands a challenge, refuses push, snapshot and changes until it is signed under the peer’s key (UNPROVEN), a wrong signature is BAD_PROOF; the dialer proves on its own',
    async (t2) => {
      const host = await createStorage(t2, 'H', { sync: { signatures: 'require' } });
      const unit = host.sync.unit({ access: 'public' });
      const peer = await createSigner();
      const link = new MemoryLink(unit);
      const hello = await link.call('syncom/hello', { node: peer.id, version: 1 });
      assert.match(hello.challenge, /^[A-Za-z0-9_-]{43}$/);
      const op = await peer.sign({ seq: 1, ts: Date.now(), type: 'write', id: 'p1', data: { n: 1 } });
      const unproven = (error) => error.code === 403 && error.reason === 'UNPROVEN';
      await assert.rejects(() => link.call('syncom/push', { ops: packOps([op]) }), unproven);
      await assert.rejects(() => link.call('syncom/snapshot', { cursor: null }), unproven);
      const failures = [];
      link.subscribe('syncom/changes', {}, { onError: (error) => failures.push(error) });
      await waitUntil(() => failures.length === 1);
      assert.ok(unproven(failures[0]));
      // A signature over another message, or under another key, proves nothing.
      const wrong = peer.signMessage(JSON.stringify([1, 'prove', 'other', host.nodeId, peer.id]));
      await assert.rejects(
        () => link.call('syncom/prove', { sig: wrong }),
        (error) => error.code === 403 && error.reason === 'BAD_PROOF',
      );
      await assert.rejects(
        () => link.call('syncom/prove', {}),
        (error) => error.code === 400 && error.reason === 'BAD_PROOF',
      );
      const other = await createSigner();
      const stranger = other.signMessage(JSON.stringify([1, 'prove', hello.challenge, host.nodeId, peer.id]));
      await assert.rejects(
        () => link.call('syncom/prove', { sig: stranger }),
        (error) => error.code === 403 && error.reason === 'BAD_PROOF',
      );
      const sig = peer.signMessage(JSON.stringify([1, 'prove', hello.challenge, host.nodeId, peer.id]));
      assert.deepStrictEqual(await link.call('syncom/prove', { sig }), { proven: true });
      assert.strictEqual((await link.call('syncom/push', { ops: packOps([op]) })).applied, 1);
      assert.deepStrictEqual(await host.get('p1'), { n: 1 });
      // A second hello is a new challenge: proven again, or refused again.
      await link.call('syncom/hello', { node: peer.id, version: 1 });
      await assert.rejects(() => link.call('syncom/snapshot', { cursor: null }), unproven);

      // The dialing side proves by itself: two signing nodes under 'require' converge.
      const mesh = await createMesh(t2, ['S', 'C'], [['C', 'S']], createStorage, {
        sync: { signatures: 'require' },
      });
      const [s, c] = ['S', 'C'].map((name) => mesh.get(name));
      const id = await c.insert({ n: 2 });
      await settle([s, c]);
      assert.deepStrictEqual(await s.get(id), { n: 2 });
      // `prove: true` on a verify host asks the same; without the signing plugin it cannot be asked.
      const verifying = await createStorage(t2, 'V');
      const asking = new MemoryLink(verifying.sync.unit({ access: 'public', prove: true }));
      const greeted = await asking.call('syncom/hello', { node: peer.id, version: 1 });
      assert.match(greeted.challenge, /^[A-Za-z0-9_-]{43}$/);
      assert.throws(() => verifying.sync.unit({ prove: 'yes' }), { name: 'TypeError' });
      // The lean core with the sync plugin alone: no key to prove.
      const { createDatabase: lean } = require('../src/index.js');
      const { sync: syncPlugin } = require('../src/sync/sync.js');
      const unsigned = await lean({ engine, path: `${t2.name}/U`, logger: false, plugins: [syncPlugin] });
      t2.after(() => unsigned.close().catch(() => {}));
      assert.throws(() => unsigned.sync.unit({ prove: true }), { name: 'TypeError', message: /signing plugin/ });
      assert.strictEqual(typeof unsigned.sync.unit({}).hello, 'object', 'off by default without require');
    },
  );

  await t.test(
    'revoke: the host takes scopes back — the peer is told (REVOKED), its grant and its registry entry narrow, what it held of them is forgotten, the next hello says revoked',
    async (t2) => {
      const mesh = await createMesh(t2, ['H', 'C'], [['C', 'H']], createStorage, {
        sync: { scope },
        scopes: { C: ['A', 'B'] },
      });
      const [h, c] = ['H', 'C'].map((name) => mesh.get(name));
      await c.sync.awaitInitialReplication();
      const a1 = await h.insert({ $type: 'A', n: 1 });
      const b1 = await h.insert({ $type: 'B', n: 1 });
      const mine = await c.insert({ $type: 'B', n: 2 });
      await settle([h, c]);
      assert.deepStrictEqual(await c.get(b1), { $type: 'B', n: 1 });
      assert.deepStrictEqual(await h.get(mine), { $type: 'B', n: 2 });
      const errors = [];
      c.sync.on('error', (error) => errors.push(error));
      const revokes = [];
      h.sync.on('revoke', (event) => revokes.push(event));
      assert.throws(() => h.sync.revoke('', ['B']), { name: 'TypeError' });
      assert.throws(() => h.sync.revoke(c.nodeId, []), { name: 'TypeError' });
      assert.throws(() => h.sync.revoke(c.nodeId, [7]), { name: 'TypeError' });
      h.sync.revoke(c.nodeId, ['B']);
      assert.deepStrictEqual(revokes, [{ node: c.nodeId, scopes: ['B'] }]);
      await waitUntil(() => errors.some((error) => error.code === 'REVOKED'));
      const [revoked] = errors.filter((error) => error.code === 'REVOKED');
      assert.deepStrictEqual(revoked.scopes, ['B']);
      assert.strictEqual(revoked.node, h.nodeId);
      assert.deepStrictEqual(c.sync.listNodes()[0].scopes, ['A'], 'the registry entry narrowed');
      await waitUntil(() => !c.hasRecord(b1) && !c.hasRecord(mine));
      assert.strictEqual(await c.get(b1), null, 'forgotten here');
      assert.strictEqual(await c.get(mine), null, 'its own too');
      assert.deepStrictEqual(await c.get(a1), { $type: 'A', n: 1 }, 'the other scope stays');
      assert.deepStrictEqual(await h.get(mine), { $type: 'B', n: 2 }, 'no op reached the host: it keeps the record');
      // The feed is open again under the new grant: A ops come, B ops do not.
      await waitUntil(() => c.sync.peers()[0].subscribed);
      const a2 = await h.insert({ $type: 'A', n: 2 });
      const b2 = await h.insert({ $type: 'B', n: 2 });
      await waitUntil(() => c.hasRecord(a2));
      await sleep(30);
      assert.strictEqual(c.hasRecord(b2), false);
      // A hello after the fact says what was taken back, and grants less: the registry stays narrow.
      await c.sync.enableNode('mem://H', false);
      await c.sync.addNode({ url: 'mem://H2' }).catch(() => {});
      await c.sync.removeNode('mem://H2').catch(() => {});
      await c.sync.enableNode('mem://H', true);
      await c.sync.awaitInitialReplication();
      assert.deepStrictEqual(c.sync.listNodes()[0].scopes, ['A']);
      const probe = new MemoryLink(mesh.units.get('H'));
      const hello = await probe.call('syncom/hello', { node: c.nodeId, version: 1, scopes: ['A', 'B'] });
      assert.deepStrictEqual(hello.revoked, ['B']);
      assert.strictEqual(
        h.sync.hosted().some((feed) => feed.node === c.nodeId && feed.scopes?.includes('B')),
        false,
      );
      // A peer with an `onRevoke` hook decides itself: nothing is forgotten without its say.
      const keeping = [];
      const k = await createStorage(t2, 'K', {
        sync: { connect: mesh.connect, scope, hooks: { onRevoke: (event) => void keeping.push(event) } },
      });
      await k.sync.addNode({ url: 'mem://H', scopes: ['A', 'B'] });
      await k.sync.awaitInitialReplication();
      assert.deepStrictEqual(await k.get(b1), { $type: 'B', n: 1 });
      h.sync.revoke(k.nodeId, ['B']);
      await waitUntil(() => keeping.length === 1);
      assert.deepStrictEqual(keeping[0], { url: 'mem://H', node: h.nodeId, scopes: ['B'] });
      await sleep(30);
      assert.deepStrictEqual(await k.get(b1), { $type: 'B', n: 1 }, 'kept: the hook said nothing of forgetting');
      assert.deepStrictEqual(k.sync.listNodes()[0].scopes, ['A']);
    },
  );

  await t.test(
    'query and count: a thin client reads a host’s records in its scopes, capped by rowsPerQuery; off by default',
    async (t2) => {
      const schema = { entities: { Task: { index: ['status', 'priority'] } } };
      const host = await createStorage(t2, 'H', { schema, sync: { scope } });
      for (let i = 1; i <= 6; i++) {
        await host.insert({ $type: 'Task', status: i % 2 ? 'open' : 'done', priority: i, tenant: i <= 3 ? 'A' : 'B' });
      }
      const off = new MemoryLink(host.sync.unit({ access: 'public' }));
      await off.call('syncom/hello', { node: 'thin', version: 1 });
      assert.strictEqual(off.call.length, 2);
      await assert.rejects(
        () => off.call('syncom/query', { entity: 'Task' }),
        (error) => error.code === 404,
      );
      const unit = host.sync.unit({ access: 'public', query: true, limits: { rowsPerQuery: 4 } });
      const link = new MemoryLink(unit);
      await link.call('syncom/hello', { node: 'thin', version: 1 });
      const { rows } = await link.call('syncom/query', {
        entity: 'Task',
        query: { status: 'open' },
        order: [{ field: 'priority', desc: true }],
        limit: 2,
      });
      assert.deepStrictEqual(
        rows.map((row) => row.priority),
        [5, 3],
      );
      assert.ok(typeof rows[0].id === 'string');
      const page = await link.call('syncom/query', { entity: 'Task', order: ['priority'], limit: 2, offset: 2 });
      assert.deepStrictEqual(
        page.rows.map((row) => row.priority),
        [3, 4],
      );
      const capped = await link.call('syncom/query', { entity: 'Task', order: ['priority'], limit: 100 });
      assert.strictEqual(capped.rows.length, 4, 'rowsPerQuery caps the window');
      assert.deepStrictEqual(await link.call('syncom/count', { entity: 'Task', query: { status: 'done' } }), {
        count: 3,
      });
      assert.deepStrictEqual(await link.call('syncom/count', { entity: 'Task' }), { count: 6 });
      // A scoped peer reads its scope's rows alone — by the host's scope function over the row.
      const scoped = new MemoryLink(host.sync.unit({ access: 'public', query: true }));
      await scoped.call('syncom/hello', { node: 'tenant', version: 1, scopes: ['Task'] });
      assert.strictEqual((await scoped.call('syncom/query', { entity: 'Task' })).rows.length, 6);
      const elsewhere = new MemoryLink(host.sync.unit({ access: 'public', query: true }));
      await elsewhere.call('syncom/hello', { node: 'other', version: 1, scopes: ['Other'] });
      assert.deepStrictEqual(await elsewhere.call('syncom/query', { entity: 'Task' }), { rows: [] });
      assert.deepStrictEqual(await elsewhere.call('syncom/count', { entity: 'Task' }), { count: 0 });
      // Refusals by code: no entity, a query that is no object, an order that is no field.
      const bad = (error) => error.code === 400 && error.reason === 'BAD_QUERY';
      await assert.rejects(() => link.call('syncom/query', {}), bad);
      await assert.rejects(() => link.call('syncom/query', { entity: 'Task', query: 7 }), bad);
      await assert.rejects(() => link.call('syncom/query', { entity: 'Task', order: [7] }), bad);
      assert.throws(() => host.sync.unit({ query: 'yes' }), { name: 'TypeError' });
      assert.throws(() => host.sync.unit({ limits: { rowsPerQuery: 0 } }), { name: 'TypeError' });
      // Without the query plugin the host answers QUERY_DISABLED… through the same door: the unit has no procedures.
      assert.strictEqual(host.sync.unit({ access: 'public' }).query, undefined);
    },
  );

  await t.test(
    'query and count hand no sealed record to a peer: a collection with sealed records answers the plain ones alone, its count too',
    async (t2) => {
      const schema = { entities: { Note: { index: ['tag'] } } };
      const host = await createStorage(t2, 'HS', { schema, sync: {} });
      await host.insert({ $type: 'Note', tag: 'a', secret: 'plain' });
      const sealed = await host.insert({ $type: 'Note', tag: 'b', secret: 'SEALED' }, { encrypted: true });
      assert.strictEqual((await host.get(sealed)).secret, 'SEALED', 'the key holder reads it');
      assert.strictEqual(await host.Note.count({}), 2, 'the facade counts it');
      const link = new MemoryLink(host.sync.unit({ access: 'public', query: true }));
      await link.call('syncom/hello', { node: 'thin', version: 1 });
      const { rows } = await link.call('syncom/query', { entity: 'Note' });
      assert.deepStrictEqual(
        rows.map((row) => row.secret),
        ['plain'],
      );
      const ordered = await link.call('syncom/query', { entity: 'Note', order: ['tag'], limit: 10 });
      assert.deepStrictEqual(
        ordered.rows.map((row) => row.tag),
        ['a'],
      );
      assert.deepStrictEqual(await link.call('syncom/count', { entity: 'Note' }), { count: 1 });
      // No oracle: a query by the sealed record's field counts nothing.
      assert.deepStrictEqual(await link.call('syncom/count', { entity: 'Note', query: { secret: 'SEALED' } }), {
        count: 0,
      });
      assert.deepStrictEqual(await link.call('syncom/query', { entity: 'Note', query: { tag: 'b' } }), { rows: [] });
      // A scoped peer the same.
      const scoped = new MemoryLink(host.sync.unit({ access: 'public', query: true }));
      await scoped.call('syncom/hello', { node: 'tenant', version: 1, scopes: ['Note'] });
      assert.strictEqual((await scoped.call('syncom/query', { entity: 'Note' })).rows.length, 1);
      assert.deepStrictEqual(await scoped.call('syncom/count', { entity: 'Note' }), { count: 1 });
    },
  );

  await t.test(
    'forget(id): the record is gone here with no op — a replay brings nothing back, a peer is untouched, a later op of a peer makes it again',
    async (t2) => {
      const mesh = await createMesh(t2, ['H', 'C'], [['C', 'H']], createStorage);
      const [h, c] = ['H', 'C'].map((name) => mesh.get(name));
      await c.sync.awaitInitialReplication();
      const id = await c.insert({ n: 1 });
      await c.update(id, { n: 2 });
      await settle([h, c]);
      const before = c.log.length;
      await c.forget(id);
      assert.strictEqual(await c.get(id), null);
      assert.strictEqual(c.hasRecord(id), false);
      assert.strictEqual(c.log.length, before, 'no op');
      const entries = c.log.entriesOf(id);
      assert.strictEqual(entries.length, 2);
      assert.ok(
        entries.every((entry) => entry.scrubbed === true && entry.skipped === true && entry.op.data === undefined),
      );
      await sleep(30);
      assert.deepStrictEqual(await h.get(id), { n: 2 }, 'the host keeps it: nothing was sent');
      assert.deepStrictEqual(c.vector, h.vector);
      await assert.rejects(() => c.forget('bad id!'), { code: 'INVALID_ID' });
      await c.forget(id);
      // A reopen replays the unsealed tail: the forgotten record stays forgotten.
      await c.close();
      const again = await createStorage(t2, 'C', { sync: { connect: mesh.connect, autoStart: false } });
      assert.strictEqual(await again.get(id), null);
      assert.strictEqual(again.hasRecord(id), false);
      // A later op from the host makes the record again, from that op on.
      await again.sync.start();
      await again.sync.awaitInitialReplication();
      await h.update(id, { n: 3 });
      await waitUntil(() => again.hasRecord(id));
      assert.deepStrictEqual(await again.get(id), { n: 3 });
    },
  );
});
