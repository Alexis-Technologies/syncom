'use strict';

// The shared log over MongoDB (`mongoSharedLog`): the contract wrpc's feeds
// and syncom's hubs read by — ids `<epoch>.<n>` per topic, a read from a
// position and live after it, 410 and 400 for a position the log does not
// have, a trim, a hole an appender left — over the driver in memory, and
// over the real driver when MONGODB_URL names a replica set.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { mongoSharedLog } = require('../src/mongodb/mongodb.js');
const { isSharedLog } = require('../src/sync/shared-log.js');
const { createFakeMongo } = require('./utils/fake-mongo.js');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The first `count` entries a read yields, then it is let go of.
const take = async (read, count) => {
  const out = [];
  const controller = read.controller ?? null;
  for await (const entry of read) {
    out.push(entry);
    if (out.length >= count) break;
  }
  controller?.abort();
  return out;
};

const runSharedLogTests = (makeLog) => {
  it('should number a topic’s entries on append and yield them on read from a position, live after it', async () => {
    const log = makeLog();
    assert.strictEqual(isSharedLog(log), true);
    const topic = `t-${Date.now().toString(36)}`;
    const ids = [];
    for (let i = 1; i <= 3; i++) ids.push(await log.append(topic, `v${i}`, { headers: { by: `h${i}`, n: i } }));
    assert.match(ids[0], /^[a-z0-9]+\.1$/);
    const [epoch] = ids[0].split('.');
    assert.deepStrictEqual(ids, [`${epoch}.1`, `${epoch}.2`, `${epoch}.3`]);
    assert.strictEqual(log.parseId(ids[1]), ids[1]);
    assert.strictEqual(log.parseId('nope'), null);
    assert.strictEqual(log.parseId(7), null);
    const all = await take(log.read(topic, { from: 'earliest' }), 3);
    assert.deepStrictEqual(
      all.map((entry) => [entry.id, entry.value, entry.headers]),
      [
        [`${epoch}.1`, 'v1', { by: 'h1', n: '1' }],
        [`${epoch}.2`, 'v2', { by: 'h2', n: '2' }],
        [`${epoch}.3`, 'v3', { by: 'h3', n: '3' }],
      ],
      'headers as strings',
    );
    const rest = await take(log.read(topic, { after: ids[0] }), 2);
    assert.deepStrictEqual(
      rest.map((entry) => entry.value),
      ['v2', 'v3'],
    );
    // A tail: what is appended after the read began reaches it.
    const controller = new AbortController();
    const live = [];
    const reading = (async () => {
      for await (const entry of log.read(topic, { after: ids[2], signal: controller.signal })) live.push(entry.value);
    })();
    await sleep(20);
    await log.append(topic, 'v4');
    await log.append(topic, new TextEncoder().encode('v5'));
    const deadline = Date.now() + 3000;
    while (live.length < 2 && Date.now() < deadline) await sleep(10);
    assert.deepStrictEqual(live, ['v4', 'v5']);
    // Another topic is another numbering.
    assert.match(await log.append(`${topic}-b`, 'x'), /\.1$/);
    const latest = [];
    const latestController = new AbortController();
    const latestReading = (async () => {
      for await (const entry of log.read(topic, { signal: latestController.signal })) latest.push(entry.value);
    })();
    await sleep(20);
    await log.append(topic, 'v6');
    const until = Date.now() + 3000;
    while (latest.length < 1 && Date.now() < until) await sleep(10);
    assert.deepStrictEqual(latest, ['v6'], 'from latest: only what comes after');
    controller.abort();
    latestController.abort();
    await reading;
    await latestReading;
    assert.deepStrictEqual(await log.head(topic), { epoch, next: 7, first: 1 });
    assert.strictEqual(await log.head('never'), null);
    await log.close();
  });

  it('should refuse a position the log does not have: 400 malformed or past the tip, 410 another log’s or trimmed past', async () => {
    const log = makeLog();
    const topic = `p-${Date.now().toString(36)}`;
    const ids = [];
    for (let i = 1; i <= 5; i++) ids.push(await log.append(topic, `v${i}`));
    const [epoch] = ids[0].split('.');
    const fails = async (options, code) => {
      await assert.rejects(
        async () => {
          for await (const entry of log.read(topic, options)) assert.fail(`yielded ${entry.id}`);
        },
        (error) => error.code === code,
      );
    };
    await fails({ after: 'not an id' }, 400);
    await fails({ after: `${epoch}.9` }, 400);
    await fails({ after: `other.2` }, 410);
    await log.trim(topic, 2);
    assert.deepStrictEqual(await log.head(topic), { epoch, next: 6, first: 4 });
    await fails({ after: ids[1] }, 410);
    const kept = await take(log.read(topic, { from: 'earliest' }), 2);
    assert.deepStrictEqual(
      kept.map((entry) => entry.value),
      ['v4', 'v5'],
    );
    const fromEdge = await take(log.read(topic, { after: ids[2] }), 2);
    assert.deepStrictEqual(
      fromEdge.map((entry) => entry.value),
      ['v4', 'v5'],
      'the entry just before the oldest kept is a position',
    );
    assert.throws(() => log.read(topic, { from: 'middle' }), { name: 'ArgumentError' });
    assert.throws(() => log.read(''), { name: 'ArgumentError' });
    await assert.rejects(() => log.append(topic, 7), { name: 'ArgumentError' });
    await assert.rejects(() => log.trim(topic, -1), { name: 'ArgumentError' });
    await log.close();
    await assert.rejects(
      () => log.append(topic, 'x'),
      (error) => error.code === 503,
    );
  });
};

describe('MongoDB shared log (the driver in memory)', () => {
  runSharedLogTests(() => mongoSharedLog({ client: createFakeMongo(), poll: 20 }));

  it('should trim a topic to its newest entries with retention on every 64th append', async () => {
    const log = mongoSharedLog({ client: createFakeMongo(), poll: 20, retention: { maxEntries: 10 } });
    for (let i = 1; i <= 128; i++) await log.append('r', `v${i}`);
    const head = await log.head('r');
    assert.strictEqual(head.next, 129);
    assert.strictEqual(head.first, 119, 'trimmed at the 128th append to the newest 10');
    const kept = await take(log.read('r', { from: 'earliest' }), 10);
    assert.strictEqual(kept[0].value, 'v119');
    await log.close();
  });

  it('should read a number handed out whose entry never comes again after the wait, then yield it as a hole (value null), never pass it in silence', async () => {
    const client = createFakeMongo();
    const warned = [];
    const log = mongoSharedLog({ client, poll: 20, gapTimeout: 60, logger: { warn: (entry) => warned.push(entry) } });
    await log.append('g', 'v1');
    // An appender that took a number and died before its insert.
    const heads = client.db('syncom').collection('shared_heads');
    await heads.updateOne({ _id: 'g' }, { $inc: { next: 1 } });
    const third = await log.append('g', 'v3');
    assert.match(third, /\.3$/);
    const [epoch] = third.split('.');
    const started = Date.now();
    const read = await take(log.read('g', { from: 'earliest' }), 3);
    assert.deepStrictEqual(
      read.map((entry) => entry.value),
      ['v1', null, 'v3'],
    );
    assert.deepStrictEqual(read[1], { id: `${epoch}.2`, value: null, headers: { hole: '1' } });
    assert.ok(Date.now() - started >= 50, 'waited for the hole first');
    assert.ok(warned.some((entry) => entry.event === 'shared.hole' && entry.n === 2));
    // A late entry — the appender was slow, not dead — is read once more before the hole is told.
    await heads.updateOne({ _id: 'g' }, { $inc: { next: 1 } });
    const fifth = await log.append('g', 'v5');
    assert.match(fifth, /\.5$/);
    const entries = client.db('syncom').collection('shared');
    setTimeout(
      () => entries.insertOne({ _id: JSON.stringify(['g', 4]), topic: 'g', n: 4, v: 'v4-late', h: {}, at: new Date() }),
      40,
    );
    const late = await take(log.read('g', { after: third }), 2);
    assert.deepStrictEqual(
      late.map((entry) => entry.value),
      ['v4-late', 'v5'],
    );
    await log.close();
  });

  it('should give an insert slower than gapTimeout a fresh number: no live reader skipped it', async () => {
    const client = createFakeMongo();
    const log = mongoSharedLog({ client, poll: 20, gapTimeout: 60 });
    await log.append('s', 'v1');
    // A reader live before the slow append: it sees the fresh number, never a hole.
    const live = [];
    const controller = new AbortController();
    const reading = (async () => {
      for await (const entry of log.read('s', { from: 'earliest', signal: controller.signal })) live.push(entry);
    })();
    await sleep(10);
    const entries = client.db('syncom').collection('shared');
    const insertOne = entries.insertOne.bind(entries);
    let slowed = 0;
    entries.insertOne = async (doc, options) => {
      if (doc.v === 'v2' && slowed++ === 0) await sleep(100);
      return insertOne(doc, options);
    };
    const second = await log.append('s', 'v2');
    assert.match(second, /\.3$/, 'the slow insert at 2 moved to 3');
    const deadline = Date.now() + 2000;
    while (live.length < 2 && Date.now() < deadline) await sleep(5);
    controller.abort();
    await reading;
    assert.deepStrictEqual(
      live.map((entry) => [entry.id.split('.')[1], entry.value]),
      [
        ['1', 'v1'],
        ['3', 'v2'],
      ],
      'the tombstone at 2 is passed without a word',
    );
    // A fresh reader the same: the tombstone is no hole.
    const all = await take(log.read('s', { from: 'earliest' }), 2);
    assert.deepStrictEqual(
      all.map((entry) => entry.value),
      ['v1', 'v2'],
    );
    // An insert that fails leaves a tombstone too: the next reader passes the number without the wait.
    entries.insertOne = async (doc, options) => {
      if (doc.v === 'v3') throw new Error('write concern failed');
      return insertOne(doc, options);
    };
    await assert.rejects(() => log.append('s', 'v3'), /write concern failed/);
    entries.insertOne = insertOne;
    await log.append('s', 'v4');
    const started = Date.now();
    const rest = await take(log.read('s', { after: second }), 1);
    assert.deepStrictEqual(
      rest.map((entry) => entry.value),
      ['v4'],
    );
    assert.ok(Date.now() - started < 50, 'no gap waited out for the tombstone');
    await log.close();
  });

  it('should not poll a tail with a live change stream, and read the head once per page', async () => {
    const client = createFakeMongo();
    const log = mongoSharedLog({ client, poll: 10, gapTimeout: 60 });
    const entries = client.db('syncom').collection('shared');
    const heads = client.db('syncom').collection('shared_heads');
    let finds = 0;
    let headReads = 0;
    const find = entries.find.bind(entries);
    const findOne = heads.findOne.bind(heads);
    entries.find = (...args) => {
      finds++;
      return find(...args);
    };
    heads.findOne = (...args) => {
      headReads++;
      return findOne(...args);
    };
    for (let i = 1; i <= 5; i++) await log.append('w', `v${i}`);
    const live = [];
    const controller = new AbortController();
    const reading = (async () => {
      for await (const entry of log.read('w', { from: 'earliest', signal: controller.signal })) live.push(entry.value);
    })();
    const deadline = Date.now() + 2000;
    while (live.length < 5 && Date.now() < deadline) await sleep(5);
    assert.strictEqual(live.length, 5);
    const findsAfterPage = finds;
    const headsAfterPage = headReads;
    assert.ok(headsAfterPage <= 2, `the head is read once per page, not per entry (${headsAfterPage})`);
    // Idle under a live stream: no poll — the finds stay where they were over many poll intervals.
    await sleep(200);
    assert.strictEqual(finds, findsAfterPage, 'no poll with a live change stream');
    await log.append('w', 'v6');
    while (live.length < 6 && Date.now() < deadline) await sleep(5);
    assert.strictEqual(live.length, 6, 'woken by the stream');
    controller.abort();
    await reading;
    await log.close();
  });

  it('should trim only the topics retention names, and drop with trimBefore what a writer passed', async () => {
    const client = createFakeMongo();
    const log = mongoSharedLog({ client, poll: 20, retention: { maxEntries: 2, topics: ['a'] } });
    const ids = { a: [], b: [] };
    for (let i = 1; i <= 64; i++) {
      ids.a.push(await log.append('a', `a${i}`));
      ids.b.push(await log.append('b', `b${i}`));
    }
    assert.deepStrictEqual(await log.head('a'), { ...(await log.head('a')), first: 63 }, 'a trimmed to its newest two');
    assert.strictEqual((await log.head('b')).first, 1, 'b is not retention’s to trim');
    await log.trimBefore('b', ids.b[4]);
    assert.strictEqual((await log.head('b')).first, 6, 'everything at or before the fifth is gone');
    const rest = await take(log.read('b', { from: 'earliest' }), 1);
    assert.strictEqual(rest[0].value, 'b6');
    await assert.rejects(
      () => take(log.read('b', { after: ids.b[2] }), 1),
      (error) => error.code === 410,
    );
    // Another epoch's id trims nothing; a malformed one is a TypeError.
    await log.trimBefore('b', 'other.100');
    assert.strictEqual((await log.head('b')).first, 6);
    await assert.rejects(() => log.trimBefore('b', 'nope'), { name: 'ArgumentError' });
    assert.throws(() => mongoSharedLog({ client, retention: { maxEntries: 2, topics: [''] } }), {
      name: 'ArgumentError',
    });
    await log.close();
  });

  it('should poll a tail without change streams, and fall back to the poll when a stream fails', async () => {
    const client = createFakeMongo();
    const polled = mongoSharedLog({ client, changes: false, poll: 10 });
    const live = [];
    const controller = new AbortController();
    const reading = (async () => {
      for await (const entry of polled.read('q', { signal: controller.signal })) live.push(entry.value);
    })();
    await sleep(20);
    await polled.append('q', 'a');
    const deadline = Date.now() + 2000;
    while (live.length < 1 && Date.now() < deadline) await sleep(5);
    assert.deepStrictEqual(live, ['a']);
    controller.abort();
    await reading;
    const warned = [];
    const streamed = mongoSharedLog({ client, poll: 10, logger: { warn: (entry) => warned.push(entry) } });
    const tailed = [];
    const stop = new AbortController();
    const tailing = (async () => {
      for await (const entry of streamed.read('q', { signal: stop.signal })) tailed.push(entry.value);
    })();
    await sleep(20);
    client.db('syncom').collection('shared').breakStreams(new Error('resume token gone'));
    await streamed.append('q', 'b');
    const until = Date.now() + 2000;
    while (tailed.length < 1 && Date.now() < until) await sleep(5);
    assert.deepStrictEqual(tailed, ['b'], 'read by the poll once the stream failed');
    assert.strictEqual(warned[0]?.event, 'shared.stream.failed');
    stop.abort();
    await tailing;
    await streamed.close();
  });

  it('should check the options', () => {
    assert.throws(() => mongoSharedLog({}), { name: 'ArgumentError', message: /client.*or a Db/ });
    assert.throws(() => mongoSharedLog({ client: createFakeMongo(), collection: '' }), { name: 'ArgumentError' });
    assert.throws(() => mongoSharedLog({ client: createFakeMongo(), poll: 0 }), { name: 'ArgumentError' });
    assert.throws(() => mongoSharedLog({ client: createFakeMongo(), gapTimeout: -1 }), { name: 'ArgumentError' });
    assert.throws(() => mongoSharedLog({ client: createFakeMongo(), retention: { maxEntries: 0 } }), {
      name: 'ArgumentError',
    });
    assert.strictEqual(mongoSharedLog({ db: createFakeMongo().db('x') }).name, 'mongodb');
  });
});

const url = process.env.MONGODB_URL;
describe('MongoDB shared log (the driver)', { skip: url ? false : 'MONGODB_URL unset' }, () => {
  const name = `syncom-shared-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  let client = null;
  before(async () => {
    const { MongoClient } = require('mongodb');
    client = await new MongoClient(url).connect();
  });
  after(async () => {
    if (!client) return;
    await client.db(name).dropDatabase();
    await client.close();
  });
  runSharedLogTests(() => mongoSharedLog({ client, name, poll: 50 }));
});
