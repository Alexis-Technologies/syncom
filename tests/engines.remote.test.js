'use strict';

// An engine served over a message port and used from the other side: the
// contract suite over a MessageChannel, a database over it with the chain,
// pieces, tags and a reopen, a failed append and a scrub crossing the port,
// errors with their codes, a change stream and a lease pushed back — and a
// worker thread serving the engine in memory.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { createDatabase, memoryEngine, filesEngine } = require('../src/all/all.js');
const { memory } = require('../src/memory/memory.js');
const { mongoEngine } = require('../src/mongodb/mongodb.js');
const { createFakeMongo } = require('./utils/fake-mongo.js');
const { serveEngine, remoteEngine, connectEngine } = require('../src/engines/engines.js');
const { runEngineTests, stored } = require('./suites/engine.js');

let n = 0;
const vroot = async () => `/remote-${++n}`;
const settle = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

// The log files under `dir`, by name, each as the seqs its lines hold.
const seqsOn = async (fsi, dir) => {
  const out = {};
  for (const name of (await fsi.list(dir)).sort()) {
    if (!name.endsWith('.json') && !name.endsWith('.jsonl')) continue;
    const seqs = [];
    for (const line of (await fsi.read(dir, name)).split('\n')) {
      if (!line.startsWith('{"e":')) continue;
      for (const entry of JSON.parse(line).e) seqs.push(entry[0]);
    }
    out[name] = seqs;
  }
  return out;
};

// An engine served over a fresh channel, and the proxy over the other end.
const served = (inner = memoryEngine()) => {
  const { port1, port2 } = new MessageChannel();
  const server = serveEngine(inner, port1);
  const engine = remoteEngine(port2, { name: inner.name, capabilities: inner.capabilities });
  return { inner, server, engine };
};

test('an engine over a message port', async (t) => {
  const open = [];
  t.after(async () => {
    for (const { server, engine } of open) {
      await engine.close();
      await server.close();
    }
  });
  await t.test('the contract, over a MessageChannel', async (t2) => {
    await runEngineTests(t2, {
      create: () => {
        const pair = served();
        open.push(pair);
        return pair.engine;
      },
      root: vroot,
    });
  });

  await t.test(
    'a database over the proxy: writes, pieces, tags, the chain, a reopen; the served side holds it all',
    async () => {
      const { inner, server, engine } = served();
      const options = { path: 'app', engine, logger: false, defer: 0, lock: false };
      const db = await createDatabase(options);
      const id = await db.insert({ title: 'Draft' });
      await db.push(id, 'body', 'x'.repeat(3000));
      await db.tag('v1');
      await db.update(id, { title: 'Final' });
      await db.close();
      const again = await createDatabase(options);
      assert.strictEqual(again.nodeId, db.nodeId);
      assert.strictEqual((await again.get(id)).title, 'Final');
      assert.strictEqual((await again.get(id)).body.length, 3000);
      assert.deepStrictEqual((await again.at('v1').get(id)).title, 'Draft');
      assert.strictEqual(await again.validate(), true);
      await again.close();
      const local = await inner.open('app');
      assert.deepStrictEqual((await local.records.get(id)).data.title, 'Final', 'the served engine holds the record');
      assert.strictEqual(await local.kv.has('', 'node.json'), true);
      await engine.remove('app');
      assert.strictEqual(await (await inner.open('app')).records.get(id), null, 'removed on the served side');
      await engine.close();
      await server.close();
    },
  );

  await t.test(
    'the log over the port: a reopen replays, a roll seals, compaction drops, a scrub rewrites',
    async () => {
      const { server, engine } = served();
      const options = {
        path: '/log',
        engine,
        logger: false,
        defer: 0,
        lock: false,
        sync: { log: { rollAfter: 2 }, retention: { ops: 6 } },
      };
      const db = await createDatabase(options);
      const ids = [];
      for (let i = 0; i < 12; i++) ids.push(await db.insert({ n: i }));
      await db.flush();
      assert.ok(db.stats().log.floor > 1, 'compacted');
      assert.ok(db.stats().log.segments > 0, 'the proxy reads the served segments');
      await db.purge(ids[11]);
      const { floor, next, length } = db.stats().log;
      await db.close();
      const again = await createDatabase(options);
      const reopened = again.stats().log;
      assert.deepStrictEqual([reopened.floor, reopened.next, reopened.length], [floor, next, length]);
      assert.deepStrictEqual(await again.get(ids[10]), { n: 10 });
      assert.strictEqual(await again.get(ids[11]), null);
      await again.close();
      await engine.close();
      await server.close();
    },
  );

  await t.test(
    'an error crosses with its code; a failed append fails its group; a lease and a change stream push back',
    async () => {
      const client = createFakeMongo();
      const inner = mongoEngine({ client, name: 'remote' });
      const { server, engine } = served(inner);
      const db = await engine.open('/p');
      await db.kv.create('', 'lock.json', '1');
      await assert.rejects(() => db.kv.create('', 'lock.json', '2'), { code: 'EEXIST' });
      await db.write({ records: [{ id: 'torn', text: '{"data":' }] });
      await assert.rejects(() => db.records.get('torn'), { name: 'SyncomError', code: 'INTEGRITY', id: 'torn' });
      await assert.rejects(() => db.log.drop({ from: 1, to: 2 }), { name: 'TypeError', message: /no such segment/ });
      // The served side's lease, held from here; lost there, heard here.
      const lost = [];
      const held = await db.lock({ staleAfter: 60, onLost: (error) => lost.push(error) });
      await assert.rejects(() => db.lock({ staleAfter: 60 }), { code: 'LOCKED' });
      await client
        .db('remote')
        .collection('locks')
        .updateOne({ _id: '/p' }, { $set: { owner: 'other' } });
      await settle(80);
      assert.strictEqual(lost.length, 1);
      assert.match(lost[0].message, /taken/);
      await held.release();
      // Another instance's writes, heard through the port.
      // Another instance (its own writer token) over the same database: what the proxy's subscriber hears.
      const other = await mongoEngine({ client, name: 'remote' }).open('/p');
      const heard = [];
      const stop = db.changes.subscribe((message) => heard.push(message));
      await settle();
      await other.write({ records: [{ id: 'r', stored: stored({}) }] });
      await settle();
      assert.deepStrictEqual(heard, [{ p: '/p', records: ['r'] }]);
      stop();
      await settle();
      await other.write({ records: [{ id: 's', stored: stored({}) }] });
      await settle();
      assert.strictEqual(heard.length, 1, 'unsubscribed');
      // A group the served store cannot write fails here, through onFail.
      const failing = {
        ...inner,
        open: async (p) => {
          const real = await inner.open(p);
          return {
            ...real,
            log: {
              ...real.log,
              append: async (_e, _h, { onFail }) => {
                onFail(new Error('disk full'));
                return false;
              },
            },
          };
        },
      };
      const { port1, port2 } = new MessageChannel();
      const failServer = serveEngine(failing, port1);
      const failEngine = remoteEngine(port2, { name: 'mongodb', capabilities: inner.capabilities });
      const failDb = await failEngine.open('/q');
      const failures = [];
      const landed = await failDb.log.append([{ seq: 1 }], null, {
        first: 1,
        last: 1,
        onFail: (e) => failures.push(e),
      });
      assert.strictEqual(landed, false);
      assert.match(failures[0].message, /disk full/);
      await failEngine.close();
      await failServer.close();
      await engine.close();
      await server.close();
    },
  );

  await t.test(
    'remoteEngine() is refused without a name and capabilities; connectEngine() asks the served side',
    async () => {
      const { port1, port2 } = new MessageChannel();
      assert.throws(() => remoteEngine(port2), { name: 'TypeError', message: /connectEngine/ });
      assert.throws(() => remoteEngine({}, { name: 'x', capabilities: {} }), {
        name: 'TypeError',
        message: /postMessage/,
      });
      const server = serveEngine(memoryEngine(), port1);
      const engine = await connectEngine(port2);
      assert.strictEqual(engine.name, 'memory');
      assert.strictEqual(engine.capabilities.atomicBatch, true);
      assert.strictEqual(engine.capabilities.exclusiveCreate, true);
      await engine.close();
      await server.close();
    },
  );

  await t.test('the contract, over a MessageChannel, the files engine served', async (t2) => {
    await runEngineTests(t2, {
      create: () => {
        const pair = served(filesEngine(memory()));
        open.push(pair);
        return pair.engine;
      },
      root: vroot,
    });
  });

  await t.test('a scrub over the port leaves a served files engine’s segments and journals whole', async () => {
    const fsi = memory();
    const { server, engine } = served(filesEngine(fsi));
    const options = {
      path: '/scrub',
      engine,
      logger: false,
      defer: 0,
      lock: false,
      sync: { log: { rollAfter: 6 }, retention: { ops: 18 } },
    };
    const db = await createDatabase(options);
    const ids = [];
    for (let i = 0; i < 12; i++) ids.push(await db.insert({ n: i, secret: `s${i}` }));
    await db.flush();
    const before = await seqsOn(fsi, '/scrub/log');
    assert.deepStrictEqual(before['seg-0000000001.json'], [1, 2, 3, 4, 5], 'a segment of five');
    await db.purge(ids[3]);
    const { floor, next, length } = db.stats().log;
    await db.close();
    await engine.close();
    await server.close();
    const after = await seqsOn(fsi, '/scrub/log');
    assert.deepStrictEqual(after['seg-0000000001.json'], [1, 2, 3, 4, 5], 'the segment holds every entry still');
    const text = await fsi.read('/scrub/log', 'seg-0000000001.json');
    assert.ok(!text.includes('"s3"'), 'the purged payload is gone from it');
    const again = await createDatabase({ ...options, engine: filesEngine(fsi) });
    const reopened = again.stats().log;
    const read = [reopened.floor, reopened.next, reopened.length, reopened.corrupt, reopened.lost];
    assert.deepStrictEqual(read, [floor, next, length, 0, false]);
    assert.deepStrictEqual(await again.get(ids[2]), { n: 2, secret: 's2' });
    assert.strictEqual(await again.get(ids[3]), null);
    await again.close();
  });

  await t.test('a failed append over the port keeps the journal’s other groups', async () => {
    const base = memory();
    let appends = 0;
    const fsi = {
      ...base,
      async append(dir, name, text) {
        if (++appends === 4) throw Object.assign(new Error('ENOSPC: no space left'), { code: 'ENOSPC' });
        return base.append(dir, name, text);
      },
    };
    const { server, engine } = served(filesEngine(fsi));
    const options = { path: '/append', engine, logger: false, defer: 0, lock: false };
    const db = await createDatabase(options);
    const ids = [];
    let refused = null;
    for (let i = 0; i < 6; i++) {
      try {
        ids.push(await db.insert({ n: i }));
      } catch (error) {
        refused = error;
      }
    }
    assert.strictEqual(refused?.code, 'QUOTA', 'the fourth insert failed with its append: a full medium is QUOTA');
    assert.strictEqual(refused.cause?.code, 'ENOSPC', 'the platform’s error crosses the port as the cause');
    assert.strictEqual(ids.length, 5);
    const { next, length } = db.stats().log;
    await db.close();
    await engine.close();
    await server.close();
    const again = await createDatabase({ ...options, engine: filesEngine(base) });
    const reopened = again.stats().log;
    assert.deepStrictEqual([reopened.next, reopened.length, reopened.corrupt, reopened.lost], [next, length, 0, false]);
    assert.strictEqual((await again.list()).length, 5);
    for (const id of ids) assert.strictEqual(again.log.entriesOf(id).length, 1, 'every insert answered is in the log');
    await again.close();
  });

  await t.test(
    'compaction over the port drops every segment it should: the proxy’s list is read again after each drop',
    async () => {
      const { server, engine } = served();
      const wide = {
        path: '/compact',
        engine,
        logger: false,
        defer: 0,
        lock: false,
        sync: { log: { rollAfter: 2 }, retention: { ops: 100 } },
      };
      const db = await createDatabase(wide);
      for (let i = 0; i < 40; i++) await db.insert({ n: i });
      await db.flush();
      assert.ok(db.stats().log.segments > 10, 'many segments to drop at once');
      await db.close();
      const again = await createDatabase({ ...wide, sync: { log: { rollAfter: 2 }, retention: { ops: 4 } } });
      for (let i = 0; i < 6; i++) await again.insert({ n: 100 + i });
      await again.flush();
      const { segments, rollFailures, floor } = again.stats().log;
      assert.strictEqual(rollFailures, 0);
      assert.ok(segments <= 4, `segments left: ${segments}`);
      assert.ok(floor > 40, `floor: ${floor}`);
      await again.close();
      await engine.close();
      await server.close();
    },
  );

  await t.test(
    'a port that closes, a worker that exits, a call past timeout: ENGINE_UNREACHABLE, the calls waiting too',
    async () => {
      const inner = memoryEngine();
      const { port1, port2 } = new MessageChannel();
      const server = serveEngine(inner, port1);
      const engine = remoteEngine(port2, { name: inner.name, capabilities: inner.capabilities });
      const db = await engine.open('/gone', {});
      await db.kv.put('', 'k', 'v');
      assert.deepStrictEqual(engine.stats(), { inflight: 0, oldestMs: 0, calls: 2, failures: 0, closed: false });
      const waiting = db.kv.get('', 'k');
      await server.close();
      await assert.rejects(waiting, { code: 'ENGINE_UNREACHABLE', reason: 'closed' });
      await assert.rejects(db.kv.get('', 'k'), { code: 'ENGINE_UNREACHABLE', reason: 'closed' });
      assert.deepStrictEqual(engine.stats(), { inflight: 0, oldestMs: 0, calls: 4, failures: 2, closed: true });
      await engine.close();

      const worker = new Worker(path.join(__dirname, 'utils', 'engine-worker.js'));
      const threaded = await connectEngine(worker);
      const tdb = await threaded.open('/gone', {});
      assert.strictEqual(await tdb.kv.get('', 'none'), null);
      await worker.terminate();
      await assert.rejects(tdb.kv.get('', 'none'), { code: 'ENGINE_UNREACHABLE', reason: 'closed' });
      await threaded.close();

      const slow = {
        ...inner,
        open: async (p, options) => {
          const opened = await inner.open(p, options);
          return { ...opened, kv: { ...opened.kv, get: () => new Promise(() => {}) } };
        },
      };
      const pair = new MessageChannel();
      const slowServer = serveEngine(slow, pair.port1);
      const timed = remoteEngine(pair.port2, { name: 'memory', capabilities: inner.capabilities, timeout: 30 });
      const sdb = await timed.open('/slow', {});
      await assert.rejects(sdb.kv.get('', 'k'), { code: 'ENGINE_UNREACHABLE', reason: 'timeout', ms: 30 });
      assert.strictEqual(timed.stats().failures, 1);
      await timed.close();
      await slowServer.close();
    },
  );

  await t.test(
    'the served side refuses what the contract does not name: a store, a method, a path, a key, a filter',
    async () => {
      const inner = memoryEngine();
      const { port1, port2 } = new MessageChannel();
      const server = serveEngine(inner, port1, { allow: ['/allowed'] });
      let n = 100;
      const ask = (message) =>
        new Promise((resolve) => {
          const id = ++n;
          const onMessage = (answer) => {
            if (answer?.id !== id) return;
            port2.off('message', onMessage);
            resolve(answer);
          };
          port2.on('message', onMessage);
          port2.postMessage({ ...message, id });
        });
      const refused = async (message, fragment) => {
        const answer = await ask(message);
        assert.strictEqual(answer.error?.name, 'TypeError', JSON.stringify(answer));
        assert.ok(answer.error.message.includes(fragment), `${answer.error.message} ⊅ ${fragment}`);
      };
      await refused({ open: '/other' }, 'not served over this port');
      await refused({ open: 'a\u0000b' }, 'control character');
      const { ok: h } = await ask({ open: '/allowed' });
      assert.strictEqual(typeof h, 'number');
      await refused({ h, store: 'fsi', method: 'write', args: [] }, 'no fsi.write');
      await refused({ h, store: 'lock', method: 'call', args: [] }, 'no lock.call');
      await refused({ h, store: 'kv', method: 'valueOf', args: [] }, 'no kv.valueOf');
      await refused({ h, store: 'kv', method: 'get', args: ['../x', 'k'] }, 'not a namespace');
      await refused({ h, store: 'kv', method: 'put', args: ['', 'a/b', 'v'] }, 'not a key');
      await refused({ h, store: 'kv', method: 'get', args: ['', 'k', 1, 2, 3] }, 'too many arguments');
      await refused({ h, store: 'records', method: 'get', args: [{ $exists: true }] }, 'not a record id');
      await refused({ h, store: 'records', method: 'getMany', args: ['r'] }, 'is a list');
      await refused({ h, store: 'pieces', method: 'get', args: ['r', '../p'] }, 'not a piece');
      await refused({ h, store: 'copies', method: 'drop', args: [{ $ne: null }] }, 'not a tag');
      await refused({ h, store: 'write', args: [{ remove: { $exists: true } }] }, 'remove is a list');
      await refused({ h, store: 'write', args: [{ kv: { put: [['', '../k', 'v']] } }] }, 'not a key');
      await refused({ h, store: 'log', method: 'drop', args: ['oldest'] }, 'is an object');
      await refused({ remove: '/other' }, 'not served over this port');
      assert.strictEqual((await ask({ h, store: 'kv', method: 'put', args: ['', 'k', 'v'] })).error, undefined);
      assert.strictEqual((await ask({ h, close: true })).error, undefined);
      assert.strictEqual((await ask({ remove: '/allowed' })).error, undefined);
      await server.close();
      port2.close();

      const unguarded = new MessageChannel();
      const plain = serveEngine(memoryEngine(), unguarded.port1);
      const engine = remoteEngine(unguarded.port2, { name: 'memory', capabilities: inner.capabilities });
      await assert.rejects(engine.remove('/never-opened'), { name: 'TypeError', message: /was not opened/ });
      const db = await engine.open('/mine', {});
      await db.kv.put('', 'k', 'v');
      await db.close();
      await engine.remove('/mine');
      await engine.close();
      await plain.close();
    },
  );

  await t.test('a lease’s life crosses the port: gen, expiresAt and its events', async () => {
    const inner = mongoEngine({ client: createFakeMongo(), changes: false });
    const { server, engine } = served(inner);
    const db = await engine.open('/leased', {});
    const lease = await db.lock({ mode: 'fail', staleAfter: 90, poll: 10 });
    try {
      assert.strictEqual(typeof lease.gen, 'number');
      assert.strictEqual(typeof lease.expiresAt, 'number', 'the served side’s estimate');
      const heard = [];
      const stop = lease.subscribe((event) => heard.push(event.state));
      await settle(120);
      assert.ok(heard.includes('renewed'), `renewals heard over the port: ${heard.join(',')}`);
      stop();
    } finally {
      await lease.release();
      await db.close();
      await engine.close();
      await server.close();
    }
  });

  await t.test('an answer that does not clone crosses as an error', async () => {
    const inner = memoryEngine();
    const odd = {
      ...inner,
      open: async (p, options) => {
        const opened = await inner.open(p, options);
        return { ...opened, kv: { ...opened.kv, get: async () => () => 'a function' } };
      },
    };
    const { server, engine } = served(odd);
    const db = await engine.open('/odd', {});
    await assert.rejects(db.kv.get('', 'k'), /clone/i);
    await engine.close();
    await server.close();
  });

  await t.test('a worker thread serves the engine in memory; the database lives in the main thread', async () => {
    const worker = new Worker(path.join(__dirname, 'utils', 'engine-worker.js'));
    const engine = await connectEngine(worker);
    assert.strictEqual(engine.name, 'memory');
    const db = await createDatabase({ path: 'threaded', engine, logger: false, defer: 0, lock: false });
    const id = await db.insert({ title: 'In a worker' });
    await db.transact(async (tx) => {
      for (let i = 0; i < 20; i++) await tx.insert({ n: i });
    });
    assert.strictEqual((await db.list()).length, 21);
    await db.close();
    const again = await createDatabase({ path: 'threaded', engine, logger: false, defer: 0, lock: false });
    assert.strictEqual((await again.get(id)).title, 'In a worker');
    await again.close();
    await engine.close();
    await worker.terminate();
  });
});
