'use strict';

// The engine contract as a test (src/engine.js): run against every engine —
// the files engine over each fsi, and every native one. `create()` answers a
// fresh engine; `root()` a path no other test uses; `afterEach(path)` cleans
// up where the medium outlives the test.

const assert = require('node:assert');
const { isEngine, checkEngineDb } = require('../../src/engine.js');

const stored = (data, meta = { clock: {}, base: 0, deleted: 0 }, extra = {}) => ({
  data,
  meta,
  encrypted: false,
  timestamp: 1,
  block: null,
  ...extra,
});

const runEngineTests = async (t, { create, root, afterEach = null }) => {
  const open = async () => {
    const engine = create();
    const path = await root();
    const db = checkEngineDb(await engine.open(path, { logger: null }), 'engine suite');
    const done = async () => {
      await db.close();
      if (afterEach !== null) await afterEach(path);
    };
    return { engine, path, db, done };
  };

  await t.test('an engine has a name, capabilities, open() and remove(); a database every store', async () => {
    const engine = create();
    assert.strictEqual(isEngine(engine), true);
    assert.strictEqual(typeof engine.name, 'string');
    assert.strictEqual(typeof engine.capabilities.atomicBatch, 'boolean');
    assert.strictEqual(typeof engine.capabilities.indexes, 'boolean');
    assert.strictEqual(typeof engine.capabilities.exclusiveCreate, 'boolean');
    assert.strictEqual(isEngine({ open() {} }), false);
    const { db, path, done } = await open();
    assert.strictEqual(db.path, path);
    assert.deepStrictEqual(db.capabilities, engine.capabilities);
    // The op log's medium: what src/log.js writes its groups, segments and index through.
    for (const name of ['load', 'append', 'seal', 'sealed', 'drop', 'saveIndex', 'scrub']) {
      assert.strictEqual(typeof db.log[name], 'function', `log.${name}`);
    }
    assert.strictEqual(typeof db.log.journaled, 'boolean');
    assert.ok(Array.isArray(db.log.segments));
    await done();
  });

  await t.test('kv: get, has, list, put, remove by namespace; a key is its namespace’s alone', async () => {
    const { db, done } = await open();
    try {
      assert.strictEqual(await db.kv.get('', 'node.json'), null);
      assert.strictEqual(await db.kv.has('', 'node.json'), false);
      await db.kv.put('', 'node.json', '{"id":"n"}');
      await db.kv.put('keys', 'public.pem', 'PUB', { mode: 0o600 });
      await db.kv.put('keys', 'private.pem', 'PRIV', { atomic: true });
      assert.strictEqual(await db.kv.get('', 'node.json'), '{"id":"n"}');
      assert.strictEqual(await db.kv.has('keys', 'public.pem'), true);
      assert.strictEqual(await db.kv.get('keys', 'node.json'), null, 'another namespace');
      assert.deepStrictEqual(await db.kv.list('keys'), ['private.pem', 'public.pem'], 'sorted');
      assert.deepStrictEqual(await db.kv.list('never'), []);
      await db.kv.remove('keys', 'public.pem');
      await db.kv.remove('keys', 'missing.pem');
      assert.deepStrictEqual(await db.kv.list('keys'), ['private.pem']);
      await db.kv.put('', 'node.json', '{"id":"m"}');
      assert.strictEqual(await db.kv.get('', 'node.json'), '{"id":"m"}', 'a put replaces');
    } finally {
      await done();
    }
  });

  await t.test('kv.create is exclusive where the engine says so', async () => {
    const { engine, db, done } = await open();
    try {
      if (!engine.capabilities.exclusiveCreate) {
        assert.strictEqual(db.kv.create, undefined);
        return;
      }
      await db.kv.create('', 'lock.json', '{"pid":1}');
      await assert.rejects(() => db.kv.create('', 'lock.json', '{"pid":2}'), { code: 'EEXIST' });
      assert.strictEqual(await db.kv.get('', 'lock.json'), '{"pid":1}');
      await db.kv.remove('', 'lock.json');
      await db.kv.create('', 'lock.json', '{"pid":3}');
      assert.strictEqual(await db.kv.get('', 'lock.json'), '{"pid":3}');
    } finally {
      await done();
    }
  });

  await t.test(
    'records: a write set lands records; get, raw, has, getMany and ids read them back in id order',
    async () => {
      const { db, done } = await open();
      try {
        assert.strictEqual(await db.records.get('a'), null);
        assert.strictEqual(await db.records.raw('a'), null);
        assert.strictEqual(await db.records.has('a'), false);
        const b = stored({ title: 'b' });
        const a = stored({ title: 'a' }, { clock: {}, base: 0, deleted: 5 });
        await db.write({
          records: [
            { id: 'b', stored: b },
            { id: 'a', stored: a },
          ],
        });
        assert.deepStrictEqual(await db.records.get('a'), a);
        assert.deepStrictEqual(JSON.parse(await db.records.raw('b')), b);
        assert.strictEqual(await db.records.has('b'), true);
        const many = await db.records.getMany(['b', 'missing', 'a']);
        assert.deepStrictEqual([...many.keys()], ['b', 'a']);
        assert.deepStrictEqual(many.get('b'), b);
        assert.deepStrictEqual(await db.records.ids(), ['a', 'b'], 'id order, tombstones included');
        assert.deepStrictEqual(await db.records.ids({ after: 'a' }), ['b']);
        assert.deepStrictEqual(await db.records.ids({ limit: 1 }), ['a']);
        assert.deepStrictEqual(await db.records.ids({ after: 'b' }), []);
        // A record written again is replaced; a text given as `text` is stored as given.
        await db.write({ records: [{ id: 'a', text: JSON.stringify(stored({ title: 'a2' })) }] });
        assert.deepStrictEqual((await db.records.get('a')).data, { title: 'a2' });
        // A removal takes the record (a sealed record removed).
        await db.write({ remove: ['a'] });
        assert.strictEqual(await db.records.get('a'), null);
        assert.deepStrictEqual(await db.records.ids(), ['b']);
      } finally {
        await done();
      }
    },
  );

  await t.test('pieces ride with their record: made before it, dropped after it, read by name', async () => {
    const { db, done } = await open();
    try {
      const meta = {
        clock: {},
        base: 0,
        deleted: 0,
        blocks: { body: { k: 't', parts: ['r~1.json', null, 'r~2.json'] } },
      };
      await db.write({
        records: [
          {
            id: 'r',
            stored: stored({}, meta, { gen: 2 }),
            pieces: {
              put: [
                ['r~1.json', '{"x":1}'],
                ['r~2.json', '{"y":2}'],
              ],
            },
          },
        ],
      });
      assert.strictEqual(await db.pieces.get('r', 'r~1.json'), '{"x":1}');
      assert.strictEqual(await db.pieces.get('r', 'r~2.json'), '{"y":2}');
      assert.strictEqual(await db.pieces.get('r', 'r~3.json'), null);
      assert.deepStrictEqual(await db.records.ids(), ['r'], 'a piece is no record');
      await db.write({
        records: [
          {
            id: 'r',
            stored: stored({}, meta, { gen: 3 }),
            pieces: { put: [['r~3.json', '{"z":3}']], remove: ['r~1.json'] },
          },
        ],
      });
      assert.strictEqual(await db.pieces.get('r', 'r~1.json'), null);
      assert.strictEqual(await db.pieces.get('r', 'r~3.json'), '{"z":3}');
    } finally {
      await done();
    }
  });

  await t.test('copies: a tag’s copies by id, listed in id order, dropped whole', async () => {
    const { db, done } = await open();
    try {
      assert.strictEqual(await db.copies.get('v1', 'a'), null);
      assert.strictEqual(await db.copies.has('v1', 'a'), false);
      assert.deepStrictEqual(await db.copies.ids('v1'), []);
      await db.copies.put('v1', 'b', '{"data":{"n":1}}');
      await db.copies.put('v1', 'a', '{"data":{"n":2}}');
      await db.write({
        copies: {
          put: [
            ['v1', 'c', '{"data":{"n":3}}'],
            ['.pending', 'a', '{}'],
          ],
        },
      });
      assert.strictEqual(await db.copies.get('v1', 'a'), '{"data":{"n":2}}');
      assert.strictEqual(await db.copies.has('v1', 'c'), true);
      assert.deepStrictEqual(await db.copies.ids('v1'), ['a', 'b', 'c']);
      assert.deepStrictEqual(await db.copies.ids('.pending'), ['a']);
      assert.strictEqual(await db.copies.get('v2', 'a'), null, 'another tag');
      await db.copies.remove('v1', 'b');
      await db.copies.remove('v1', 'missing');
      assert.deepStrictEqual(await db.copies.ids('v1'), ['a', 'c']);
      await db.copies.drop('v1');
      assert.deepStrictEqual(await db.copies.ids('v1'), []);
      assert.deepStrictEqual(await db.copies.ids('.pending'), ['a'], 'another tag keeps its copies');
    } finally {
      await done();
    }
  });

  await t.test('a write set carries kv puts and removals with the records', async () => {
    const { db, done } = await open();
    try {
      await db.kv.put('', 'gone.json', '1');
      await db.write({
        kv: {
          put: [
            ['blockchain', 'h1.json', '{"prev":"0"}', undefined],
            ['blockchain', '.blockchain.json', '{"tailHash":"h1"}', { atomic: true }],
          ],
          remove: [['', 'gone.json']],
        },
        records: [{ id: 'x', stored: stored({ n: 1 }) }],
      });
      assert.strictEqual(await db.kv.get('blockchain', 'h1.json'), '{"prev":"0"}');
      assert.strictEqual(await db.kv.get('blockchain', '.blockchain.json'), '{"tailHash":"h1"}');
      assert.strictEqual(await db.kv.get('', 'gone.json'), null);
      assert.deepStrictEqual((await db.records.get('x')).data, { n: 1 });
    } finally {
      await done();
    }
  });

  await t.test('a record that does not parse is INTEGRITY, unreadable', async () => {
    const { db, done } = await open();
    try {
      await db.write({ records: [{ id: 'torn', text: '{"data":' }] });
      await assert.rejects(() => db.records.get('torn'), { code: 'INTEGRITY', id: 'torn', reason: 'unreadable' });
      assert.strictEqual(await db.records.raw('torn'), '{"data":');
    } finally {
      await done();
    }
  });

  await t.test('ids page in id order: none skipped, none twice', async () => {
    const { db, done } = await open();
    try {
      // Ids a listing by file name would misorder (`a-b.json` before `a.json`).
      const ids = [];
      for (let i = 0; i < 400; i++) {
        const k = `p${String(i).padStart(3, '0')}`;
        ids.push(k, `${k}-x`, `${k}.y`);
      }
      for (let i = 0; i < ids.length; i += 300) {
        const rows = [];
        for (let k = i; k < Math.min(i + 300, ids.length); k++) rows.push({ id: ids[k], stored: stored({ n: k }) });
        await db.write({ records: rows });
      }
      const sorted = ids.slice().sort();
      assert.deepStrictEqual(await db.records.ids(), sorted);
      const paged = [];
      let after = null;
      for (;;) {
        const page = await db.records.ids({ after, limit: 250 });
        if (page.length === 0) break;
        for (const id of page) paged.push(id);
        after = page[page.length - 1];
      }
      assert.deepStrictEqual(paged, sorted);
    } finally {
      await done();
    }
  });

  await t.test(
    'two databases of one engine never share a record; remove(path) takes one and leaves the other',
    async () => {
      const engine = create();
      const one = await root();
      const two = await root();
      const a = await engine.open(one, { logger: null });
      const b = await engine.open(two, { logger: null });
      try {
        await a.write({
          records: [{ id: 'r', stored: stored({ of: 'a' }) }],
          kv: { put: [['', 'node.json', '{"id":"a"}', undefined]] },
        });
        await b.write({
          records: [{ id: 'r', stored: stored({ of: 'b' }) }],
          kv: { put: [['', 'node.json', '{"id":"b"}', undefined]] },
        });
        await a.copies.put('v1', 'r', '{}');
        await a.kv.put('', 'tags.json', JSON.stringify({ format: 1, tags: [{ name: 'v1' }] }));
        await a.kv.put('', 'branch.json', '{"format":1}');
        await a.kv.put('tags/v1/index', 'catalog.json', '{}');
        assert.deepStrictEqual((await a.records.get('r')).data, { of: 'a' });
        assert.deepStrictEqual((await b.records.get('r')).data, { of: 'b' });
        await a.close();
        await engine.remove(one);
        const again = await engine.open(one, { logger: null });
        assert.strictEqual(await again.records.get('r'), null);
        assert.strictEqual(await again.kv.get('', 'node.json'), null);
        assert.strictEqual(await again.kv.get('', 'branch.json'), null, 'branch.json goes last, but goes');
        assert.strictEqual(await again.copies.get('v1', 'r'), null, 'the tags’ copies go too');
        assert.deepStrictEqual(await again.kv.list('tags/v1/index'), []);
        assert.deepStrictEqual(await again.records.ids(), []);
        await again.close();
        assert.deepStrictEqual((await b.records.get('r')).data, { of: 'b' }, 'the other database is whole');
      } finally {
        await b.close();
        if (afterEach !== null) {
          await afterEach(one);
          await afterEach(two);
        }
      }
    },
  );
};

module.exports = { runEngineTests, stored };
