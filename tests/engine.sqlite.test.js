'use strict';

// The engine over SQLite (node:sqlite): the contract suite, what a write costs
// the medium, a write set rolled back whole, a driver that answers with
// promises, a file that survives the engine's close, and the log over rows.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createDatabase } = require('../src/all/all.js');
const { runEngineTests, stored } = require('./suites/engine.js');

// node:sqlite is experimental: Node says so once per process at the require, which this test is not about.
process.removeAllListeners('warning');
process.on('warning', (warning) => {
  if (warning.name !== 'ExperimentalWarning') console.error(warning.stack);
});
const { DatabaseSync } = require('node:sqlite');
const { sqliteEngine } = require('../src/sqlite/sqlite.js');

let n = 0;
const vroot = async () => `/sqlite-${++n}`;

// A driver over node:sqlite that counts the transactions begun and can make one statement fail.
const counting = ({ failing = null } = {}) => {
  let begun = 0;
  const driver = {
    open(file) {
      const conn = new DatabaseSync(file);
      return {
        exec(sql) {
          if (sql.startsWith('BEGIN')) begun++;
          return conn.exec(sql);
        },
        prepare(sql) {
          const prepared = conn.prepare(sql);
          if (failing === null || !sql.startsWith(failing)) return prepared;
          return {
            run() {
              throw new Error(`refused: ${sql}`);
            },
            get: (...params) => prepared.get(...params),
            all: (...params) => prepared.all(...params),
          };
        },
        close: () => conn.close(),
      };
    },
  };
  return { driver, begun: () => begun };
};

// A driver whose every answer is a promise: what a wrapper over an async platform binding looks like.
const asyncDriver = {
  async open(file) {
    const conn = new DatabaseSync(file);
    return {
      exec: async (sql) => conn.exec(sql),
      prepare: async (sql) => {
        const prepared = conn.prepare(sql);
        return {
          run: async (...params) => prepared.run(...params),
          get: async (...params) => prepared.get(...params),
          all: async (...params) => prepared.all(...params),
        };
      },
      close: async () => conn.close(),
    };
  },
};

test('SQLite engine', async (t) => {
  await runEngineTests(t, { create: () => sqliteEngine(), root: vroot });

  await t.test('capabilities and names: atomic write sets, exclusive create, no change stream; the file', async () => {
    const engine = sqliteEngine();
    assert.strictEqual(engine.name, 'sqlite');
    assert.strictEqual(engine.file, ':memory:');
    assert.strictEqual(engine.capabilities.atomicBatch, true);
    assert.strictEqual(engine.capabilities.exclusiveCreate, true);
    assert.strictEqual(engine.capabilities.changeStream, false);
    assert.throws(() => sqliteEngine({ file: '' }), { name: 'TypeError', message: /":memory:"/ });
    assert.throws(() => sqliteEngine({ driver: {} }), { name: 'TypeError', message: /no open\(\)/ });
    const bare = sqliteEngine({ driver: { open: () => ({}) } });
    const db = await bare.open('/x');
    await assert.rejects(() => db.kv.get('', 'a'), { name: 'TypeError', message: /no exec\(\) and prepare\(\)/ });
    await engine.close();
  });

  await t.test(
    'a write set is ONE SQLite transaction; a database’s write costs two (the log group, the landing), the chain on too',
    async () => {
      const { driver, begun } = counting();
      const engine = sqliteEngine({ driver });
      const db = await engine.open('/p');
      const before = begun();
      await db.write({
        records: [
          { id: 'a', stored: stored({ n: 1 }), pieces: { put: [['a~1.json', '{}']] } },
          { id: 'b', stored: stored({ n: 2 }) },
        ],
        kv: { put: [['blockchain', 'h.json', '{}', undefined]] },
        copies: { put: [['v1', 'a', '{}']] },
      });
      assert.strictEqual(begun() - before, 1);
      await db.write({});
      assert.strictEqual(begun() - before, 1, 'an empty write set is nothing');
      const plain = await createDatabase({ path: '/app', engine, logger: false, defer: 0, lock: false, chain: false });
      await plain.insert({ title: 'warm' });
      let mark = begun();
      await plain.insert({ title: 'x' });
      assert.strictEqual(begun() - mark, 2, 'the log group and the landing');
      mark = begun();
      await plain.transact(async (tx) => {
        for (let i = 0; i < 50; i++) await tx.insert({ n: i });
      });
      assert.strictEqual(begun() - mark, 2, 'fifty records: the same two');
      await plain.close();
      const chained = await createDatabase({ path: '/chained', engine, logger: false, defer: 0, lock: false });
      await chained.insert({ title: 'warm' });
      mark = begun();
      await chained.insert({ title: 'x' });
      assert.strictEqual(begun() - mark, 2, 'the chain block and its tail ride in the landing');
      assert.strictEqual(await chained.validate(), true);
      await chained.close();
      await engine.close();
    },
  );

  await t.test('a statement that throws rolls the write set back whole; the connection serves the next', async () => {
    const { driver } = counting({ failing: 'INSERT OR REPLACE INTO copies' });
    const engine = sqliteEngine({ driver });
    const db = await engine.open('/p');
    await db.kv.put('', 'kept.json', '1');
    await assert.rejects(
      () =>
        db.write({
          kv: { put: [['', 'new.json', '2', undefined]], remove: [['', 'kept.json']] },
          records: [{ id: 'r', stored: stored({ n: 1 }), pieces: { put: [['r~1.json', '{}']] } }],
          copies: { put: [['v1', 'r', '{}']] },
        }),
      { message: /refused/ },
    );
    assert.strictEqual(await db.records.get('r'), null, 'no record');
    assert.strictEqual(await db.pieces.get('r', 'r~1.json'), null, 'no piece');
    assert.strictEqual(await db.kv.get('', 'new.json'), null, 'no put');
    assert.strictEqual(await db.kv.get('', 'kept.json'), '1', 'no removal');
    await db.write({ records: [{ id: 'r', stored: stored({ n: 2 }) }] });
    assert.deepStrictEqual((await db.records.get('r')).data, { n: 2 }, 'the next set lands');
    await engine.close();
  });

  await t.test(
    'a driver that answers with promises: a database over it, a reopen through the same engine',
    async () => {
      const engine = sqliteEngine({ driver: asyncDriver });
      const options = { path: 'app', engine, logger: false, defer: 0, lock: false };
      const db = await createDatabase(options);
      const id = await db.insert({ title: 'Draft' });
      await db.push(id, 'body', 'x'.repeat(3000));
      await db.tag('v1');
      await db.update(id, { title: 'Final' });
      assert.deepStrictEqual((await db.at('v1').get(id)).title, 'Draft');
      await db.close();
      const again = await createDatabase(options);
      assert.strictEqual(again.nodeId, db.nodeId);
      assert.strictEqual((await again.get(id)).title, 'Final');
      assert.strictEqual((await again.get(id)).body.length, 3000);
      assert.deepStrictEqual(await again.list(), [id]);
      assert.strictEqual(await again.validate(), true);
      await again.close();
      await engine.close();
    },
  );

  await t.test(
    'a database in a file survives the engine’s close and another engine over the file; remove(path) takes it; destroy() deletes the file',
    async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'syncom-sqlite-'));
      const file = path.join(dir, 'app.sqlite');
      try {
        const first = sqliteEngine({ file });
        const options = { path: 'store', logger: false, defer: 0, lock: false };
        const db = await createDatabase({ ...options, engine: first });
        const id = await db.insert({ title: 'Draft' });
        await db.push(id, 'body', 'y'.repeat(3000));
        await db.tag('v1');
        await db.update(id, { title: 'Final' });
        await db.close();
        await first.close();
        const second = sqliteEngine({ file });
        const again = await createDatabase({ ...options, engine: second });
        assert.strictEqual(again.nodeId, db.nodeId);
        assert.strictEqual((await again.get(id)).title, 'Final');
        assert.strictEqual((await again.get(id)).body.length, 3000);
        assert.deepStrictEqual((await again.at('v1').get(id)).title, 'Draft');
        assert.strictEqual(await again.validate(), true, 'the chain reads back');
        await again.close();
        await second.remove('store');
        const empty = await createDatabase({ ...options, engine: second });
        assert.deepStrictEqual(await empty.list(), []);
        await empty.close();
        await second.destroy();
        await assert.rejects(() => fs.access(file), { code: 'ENOENT' });
        await assert.rejects(() => fs.access(`${file}-wal`), { code: 'ENOENT' });
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    },
  );

  await t.test(
    'a COMMIT that fails is rolled back: nothing of the set lands, the connection serves the next',
    async () => {
      let commits = 0;
      const driver = {
        open(file) {
          const conn = new DatabaseSync(file);
          return {
            exec(sql) {
              if (sql === 'COMMIT' && ++commits === 1) throw new Error('SQLITE_FULL: database or disk is full');
              return conn.exec(sql);
            },
            prepare: (sql) => conn.prepare(sql),
            close: () => conn.close(),
          };
        },
      };
      const engine = sqliteEngine({ driver });
      const db = await engine.open('/commit', { logger: null });
      await assert.rejects(db.write({ records: [{ id: 'a', stored: stored({ a: 1 }) }] }), /SQLITE_FULL/);
      assert.strictEqual(await db.records.has('a'), false, 'rolled back whole');
      await db.write({ records: [{ id: 'b', stored: stored({ b: 1 }) }] });
      assert.deepStrictEqual((await db.records.get('b')).data, { b: 1 }, 'the next set lands');
      assert.strictEqual(await db.records.has('a'), false);
      await db.close();
      await engine.close();
    },
  );

  await t.test(
    'a log row that does not parse is counted corrupt and left out; a meta row that does not is none',
    async () => {
      const database = new DatabaseSync(':memory:');
      const engine = sqliteEngine({ database });
      const options = { path: 'rows', engine, logger: false, defer: 0, lock: false, chain: false };
      const db = await createDatabase(options);
      const ids = [];
      for (let i = 0; i < 3; i++) ids.push(await db.insert({ n: i }));
      await db.close();
      database.exec("UPDATE log SET entry = 'garbage' WHERE seq = 2");
      database.exec("UPDATE meta SET value = '{not json' WHERE key = 'index'");
      const warned = [];
      const logger = { warn: (event) => warned.push(event.event), info() {}, error() {}, debug() {} };
      const again = await createDatabase({ ...options, logger });
      const { corrupt, lost } = again.stats().log;
      assert.deepStrictEqual([corrupt, lost], [1, true]);
      assert.ok(warned.includes('log.row.unreadable') && warned.includes('log.meta.unreadable'), warned.join(','));
      for (const id of ids) assert.ok(await again.get(id), 'the records are on their rows still');
      await again.close();
      database.close();
    },
  );

  await t.test(
    'the catalog is rows of its own table: a save writes what changed, a reopen reads them, other indexes replace them',
    async () => {
      const database = new DatabaseSync(':memory:');
      const engine = sqliteEngine({ database });
      const schema = { entities: { Note: { index: ['kind'] } } };
      const options = { path: 'cat', engine, logger: false, defer: 0, lock: false, chain: false, schema };
      const count = () => database.prepare("SELECT count(*) AS n FROM catalog WHERE p = 'cat'").get().n;
      const rowOf = (id) =>
        JSON.parse(database.prepare("SELECT row FROM catalog WHERE p = 'cat' AND id = ?").get(id).row);
      const db = await createDatabase(options);
      const ids = [];
      for (let i = 0; i < 5; i++) ids.push(await db.insert({ $type: 'Note', kind: i % 2 ? 'a' : 'b' }));
      await db.close();
      assert.strictEqual(count(), 5, 'a row a record');
      assert.strictEqual(rowOf(ids[1]).fields.kind, 'a');
      const again = await createDatabase(options);
      assert.strictEqual((await again.Note.select({ kind: 'a' }).fetch()).length, 2, 'read from the rows, not rebuilt');
      await again.update(ids[1], { kind: 'b' });
      await again.delete(ids[0]);
      await again.close();
      assert.strictEqual(rowOf(ids[1]).fields.kind, 'b', 'the row that changed was written');
      assert.strictEqual(rowOf(ids[0]).gone, true, 'a tombstone is a row flagged gone');
      assert.strictEqual(count(), 5);
      const other = { ...options, schema: { entities: { Note: { index: ['kind', 'title'] } } } };
      const rebuilt = await createDatabase(other);
      await rebuilt.insert({ $type: 'Note', kind: 'c', title: 't' });
      await rebuilt.close();
      assert.strictEqual(count(), 6, 'other indexes: every row replaced, none left over');
      assert.deepStrictEqual(
        JSON.parse(database.prepare("SELECT value FROM meta WHERE p = 'cat' AND key = 'catalog'").get().value)
          .indexes !== undefined,
        true,
      );
      database.close();
    },
  );

  await t.test('a connection given is used as it is, set durable on request, and never closed', async () => {
    const database = new DatabaseSync(':memory:');
    database.exec('PRAGMA synchronous = NORMAL');
    const engine = sqliteEngine({ database });
    const db = await createDatabase({ path: 'd', engine, logger: false, defer: 0, lock: false, chain: false });
    assert.strictEqual(database.prepare('PRAGMA synchronous').get().synchronous, 1, 'kept as the caller set it');
    await db.insert({ n: 1 });
    await db.close();
    const durable = await createDatabase({ path: 'd', engine, logger: false, defer: 0, lock: false, durable: true });
    assert.strictEqual(database.prepare('PRAGMA synchronous').get().synchronous, 2, 'FULL once a database asked');
    await durable.close();
    await engine.close();
    await engine.destroy();
    assert.strictEqual(database.prepare('SELECT count(*) AS n FROM records').get().n, 1, 'still open, still there');
    database.close();
  });

  await t.test(
    'the log over rows: a reopen replays the unsealed groups, a roll seals a range, compaction drops rows',
    async () => {
      const engine = sqliteEngine();
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
      // A `:memory:` database closed is gone: the next open starts over.
      const fresh = await createDatabase(options);
      assert.deepStrictEqual(await fresh.list(), []);
      await fresh.close();
      await engine.close();
    },
  );
});
