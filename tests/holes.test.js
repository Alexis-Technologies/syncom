'use strict';

// A caller's sparse array keeps working where an array method read it before the lean-core release (240c389)
// replaced the method with a loop: such a loop skips a hole as `every`, `some`, `map` or `flatMap` skipped it
// (alexiskills 1.1.2). Each case is a list the application hands in, with a hole in it.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const syncom = require('../src/all/all.js');
const { keyOf } = require('../src/query/cache.js');

const HOLE = Symbol('hole');
// An array with a hole wherever HOLE is given: `sparse('a', HOLE, 'b')` is `['a', , 'b']`.
const sparse = (...items) => {
  const out = [];
  out.length = items.length;
  for (let i = 0; i < items.length; i++) if (items[i] !== HOLE) out[i] = items[i];
  return out;
};
const standard = (validate) => ({ '~standard': { version: 1, vendor: 'test', validate } });

const open = async (t, options = {}) => {
  const db = await syncom.createDatabase({
    engine: syncom.memoryEngine(),
    path: 'holes',
    logger: false,
    defer: 0,
    ...options,
  });
  t.after(() => db.close());
  return db;
};

const names = (rows) => {
  const out = [];
  for (const row of rows) out.push(row.f ?? '-');
  return out.sort();
};

describe('a sparse array from the caller', () => {
  it('should take an index, a compound index and a compound unique key with holes in them', async (t) => {
    const db = await open(t, {
      schema: {
        entities: {
          Task: { index: sparse('done', HOLE, sparse('done', HOLE, 'title')), unique: [sparse('key', HOLE, 'scope')] },
        },
      },
    });
    await db.Task.insert({ done: true, title: 'a', key: 'k', scope: 's' });
    await db.Task.insert({ done: false, title: 'b', key: 'k', scope: 't' });
    assert.equal(await db.Task.count({ done: true }), 1);
    assert.deepEqual(db.Task.select({ done: true }).order('title').explain().index, ['done', 'title']);
    await assert.rejects(db.Task.insert({ done: true, title: 'c', key: 'k', scope: 's' }), {
      code: 'ALX_ERR_VALIDATION_FAILED',
    });
  });

  it('should skip a hole of $in, $nin, $and, $or and $nor as the predicate it replaced did', async (t) => {
    const db = await open(t, { schema: { entities: { Task: { index: ['f'] } } } });
    await db.Task.insert({ f: 'a' });
    await db.Task.insert({ f: 'b' });
    await db.Task.insert({ g: 1 });
    const fetched = async (query) => names(await db.Task.select(query).fetch());
    assert.deepEqual(await fetched({ f: { $in: sparse('a', HOLE) } }), ['a'], 'the record without f is no hole');
    assert.deepEqual(await fetched({ f: { $nin: sparse('a', HOLE) } }), ['-', 'b']);
    assert.deepEqual(await fetched({ $and: sparse({ f: 'a' }, HOLE) }), ['a']);
    assert.deepEqual(await fetched({ $or: sparse({ f: 'a' }, HOLE, { f: 'b' }) }), ['a', 'b']);
    assert.deepEqual(await fetched({ $nor: sparse({ f: 'a' }, HOLE) }), ['-', 'b']);
    assert.equal(await db.Task.count({ f: { $in: sparse(HOLE, 'b') } }), 1);
  });

  it('should project a sparse list of fields as the fields it names', async (t) => {
    const db = await open(t, { schema: { entities: { Task: {} } } });
    await db.Task.insert({ f: 'a', g: 1 });
    const rows = await db.Task.select({}).projection(sparse('f', HOLE)).fetch();
    assert.deepEqual(Object.keys(rows[0]).sort(), ['f', 'id']);
  });

  it('should key a hole of a query apart from an undefined it was handed', () => {
    const hole = keyOf(['Task', { f: { $in: sparse('a', HOLE) } }]);
    assert.notEqual(hole, keyOf(['Task', { f: { $in: ['a', undefined] } }]));
    assert.notEqual(hole, keyOf(['Task', { f: { $in: ['a', null] } }]));
    assert.equal(hole, keyOf(['Task', { f: { $in: sparse('a', HOLE) } }]));
  });

  it('should apply a sparse list of patches, and a remove whose removals have a hole', async (t) => {
    const db = await open(t);
    const patches = sparse({ action: 'put', field: 'a', value: 1 }, HOLE, { action: 'put', field: 'b', value: 2 });
    assert.equal(await db.applyPatches('r', patches), 2);
    assert.deepEqual(await db.get('r'), { a: 1, b: 2 });
    const removals = sparse(['x', { A: 5 }], HOLE);
    assert.equal(await db.applyPatches('r', [{ action: 'remove', field: 'tags', removals }]), 1);
  });

  it('should migrate the entities a sparse list names', async (t) => {
    const db = await open(t, { schema: { version: 2, entities: { Task: {} } } });
    assert.deepEqual(await db.migrate({ entities: sparse('Task', HOLE) }), {
      migrated: 0,
      counters: 0,
      sets: 0,
      lists: 0,
      texts: 0,
      trees: 0,
    });
  });

  it('should add a node with a sparse list of scopes as the scopes it names', async (t) => {
    const db = await open(t, { sync: { autoStart: false, connect: () => ({ call() {} }) } });
    await db.sync.addNode({ url: 'mem://host', scopes: sparse('a', HOLE, 'b') });
    assert.deepEqual(db.sync.listNodes()[0].scopes, ['a', 'b']);
  });

  it('should read the issues of a validator, and their paths, without their holes', async (t) => {
    const validate = () => ({ issues: sparse({ message: 'bad', path: sparse('a', HOLE, 'b') }, HOLE) });
    const db = await open(t, { schema: { entities: { Task: { schema: standard(validate) } } } });
    await assert.rejects(db.Task.insert({ a: 1 }), (error) => {
      assert.equal(error.code, 'ALX_ERR_VALIDATION_FAILED');
      assert.deepEqual(error.issues, [{ path: ['a', 'b'], message: 'bad' }]);
      return true;
    });
  });
});
