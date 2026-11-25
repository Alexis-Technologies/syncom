'use strict';

// A medium that is full: the log says ALX_ERR_QUOTA at the append, a landing that
// failed for want of room is ALX_ERR_UNPERSISTED with `quota: true`; the room the
// medium has, asked of the platform.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const syncom = require('../src/all/all.js');
const { isQuotaError } = require('../src/errors.js');
const { memory } = require('../src/memory/memory.js');
const { mongoEngine } = require('../src/mongodb/mongodb.js');
const { createFakeMongo } = require('./utils/fake-mongo.js');
require('./utils/quiet-sqlite.js');
const { sqliteEngine } = require('../src/sqlite/sqlite.js');
const browserUtils = require('../src/utils.browser.js');
const { waitUntil } = require('./utils/mesh.js');

// The memory engine with a medium that fills on demand: the log's append, or the landing, refused as the platforms refuse.
const fillable = () => {
  const inner = syncom.memoryEngine();
  const state = { append: null, write: null };
  const engine = Object.freeze({
    name: 'fillable',
    capabilities: inner.capabilities,
    async open(path, options) {
      const db = await inner.open(path, options);
      // The log store's contract: a group that cannot be written is told through `onFail`, and `false` answered.
      const log = Object.create(db.log);
      log.append = async (entries, headers, appendOptions) => {
        if (state.append !== null) {
          appendOptions.onFail(state.append);
          return false;
        }
        return db.log.append(entries, headers, appendOptions);
      };
      return Object.freeze({
        ...db,
        log,
        write: async (batch) => {
          if (state.write !== null) throw state.write;
          return db.write(batch);
        },
      });
    },
    remove: (path) => inner.remove(path),
  });
  return { engine, state };
};

describe('Quota', () => {
  it('should know the platforms’ full-medium errors in isQuotaError', () => {
    assert.strictEqual(isQuotaError(Object.assign(new Error('x'), { code: 'ENOSPC' })), true);
    assert.strictEqual(isQuotaError(Object.assign(new Error('x'), { name: 'QuotaExceededError' })), true);
    assert.strictEqual(isQuotaError(Object.assign(new Error('x'), { name: 'DOMException', code: 22 })), true);
    assert.strictEqual(isQuotaError(Object.assign(new Error('x'), { name: 'DOMException', code: 11 })), false);
    assert.strictEqual(isQuotaError(new Error('x')), false);
    assert.strictEqual(isQuotaError(null), false);
    assert.strictEqual(isQuotaError('ENOSPC'), false);
  });

  it('should refuse an append for want of room as QUOTA, with the platform’s error as the cause, and let the next append go', async (t2) => {
    const { engine, state } = fillable();
    const db = await syncom.createDatabase({ engine, path: 'q', logger: false, defer: 0 });
    t2.after(() => db.close().catch(() => {}));
    const before = await db.insert({ n: 1 });
    state.append = Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
    await assert.rejects(
      () => db.insert({ n: 2 }),
      (error) => {
        assert.strictEqual(error.code, 'ALX_ERR_QUOTA');
        assert.strictEqual(error.cause?.code, 'ENOSPC');
        return true;
      },
    );
    state.append = null;
    const after = await db.insert({ n: 3 });
    assert.deepStrictEqual(await db.get(after), { n: 3 });
    assert.deepStrictEqual(await db.get(before), { n: 1 });
    // Another failure of the medium is itself, not ALX_ERR_QUOTA.
    state.append = Object.assign(new Error('read-only file system'), { code: 'EROFS' });
    await assert.rejects(() => db.insert({ n: 4 }), { code: 'EROFS' });
    state.append = null;
  });

  it('should refuse a landing for want of room as UNPERSISTED with quota: true', async (t2) => {
    const { engine, state } = fillable();
    const db = await syncom.createDatabase({ engine, path: 'u', logger: false, defer: 0 });
    t2.after(() => db.close().catch(() => {}));
    const errors = [];
    db.on('error', (error) => errors.push(error));
    state.write = Object.assign(new Error('The quota has been exceeded.'), { name: 'QuotaExceededError' });
    const id = await db.insert({ n: 1 }).catch((error) => error);
    await waitUntil(() => errors.some((error) => error.code === 'ALX_ERR_UNPERSISTED'));
    const unpersisted = errors.find((error) => error.code === 'ALX_ERR_UNPERSISTED');
    assert.strictEqual(unpersisted.quota, true);
    assert.ok(Array.isArray(unpersisted.ids));
    assert.strictEqual(unpersisted.cause?.name, 'QuotaExceededError');
    assert.ok(typeof id === 'string' || id?.code === 'ALX_ERR_UNPERSISTED');
    state.write = null;
  });

  it('should see SQLITE_FULL and a quota under cause in isQuotaError, and ask the engine in quota() where it can', async (t2) => {
    const sqliteFull = Object.assign(new Error('database or disk is full'), {
      code: 'ERR_SQLITE_ERROR',
      errcode: 13,
    });
    assert.strictEqual(isQuotaError(sqliteFull), true);
    assert.strictEqual(isQuotaError(Object.assign(new Error('x'), { code: 'SQLITE_FULL' })), true, 'better-sqlite3');
    assert.strictEqual(isQuotaError(Object.assign(new Error('x'), { code: 'ERR_SQLITE_ERROR', errcode: 5 })), false);
    assert.strictEqual(isQuotaError(new Error('wrapped', { cause: sqliteFull })), true, 'looked for under cause');
    assert.strictEqual(
      isQuotaError(new Error('twice', { cause: new Error('once', { cause: { code: 'ENOSPC' } }) })),
      true,
    );
    let deep = { code: 'ENOSPC' };
    for (let i = 0; i < 9; i++) deep = new Error(`level ${i}`, { cause: deep });
    assert.strictEqual(isQuotaError(deep), false, 'eight causes deep and no further');
    assert.strictEqual(isQuotaError(new Error('plain', { cause: new Error('still plain') })), false);
    // quota(): the engine's estimate where it has one — memory counts what it holds, SQLite its pages — the files
    // engine its volume, an engine that says nothing (MongoDB) nulls.
    const mem = await syncom.createDatabase({ engine: syncom.memoryEngine(), path: 'm', logger: false, defer: 0 });
    t2.after(() => mem.close().catch(() => {}));
    const before = (await mem.quota()).usage;
    assert.ok(typeof before === 'number' && before > 0);
    await mem.insert({ title: 'x'.repeat(1000) });
    const after = await mem.quota();
    assert.ok(after.usage > before + 1000, `${after.usage} > ${before}`);
    assert.strictEqual(after.quota, null);
    const sqlite = await syncom.createDatabase({ engine: sqliteEngine(), path: 's', logger: false, defer: 0 });
    t2.after(() => sqlite.close().catch(() => {}));
    const pages = await sqlite.quota();
    assert.ok(typeof pages.usage === 'number' && pages.usage > 0, 'page_count × page_size');
    assert.strictEqual(pages.quota, null, ':memory: has no volume');
    const mongo = await syncom.createDatabase({
      engine: mongoEngine({ client: createFakeMongo(), name: 'q' }),
      path: 'g',
      logger: false,
      defer: 0,
    });
    t2.after(() => mongo.close().catch(() => {}));
    assert.deepStrictEqual(await mongo.quota(), { usage: null, quota: null });
  });

  it('should ask the platform for the room in quota(), and the browser to keep the origin in persist()', async (t2) => {
    const db = await syncom.createDatabase({ engine: syncom.filesEngine(memory()), path: 'r', logger: false });
    t2.after(() => db.close().catch(() => {}));
    const room = await db.quota();
    assert.strictEqual(room.usage, null, 'a file system does not say what this database holds');
    assert.ok(typeof room.quota === 'number' && room.quota > 0, 'the free space under the working directory');
    assert.strictEqual(await db.persist(), true);
    // The browser half without a Storage API (under Node): nothing known, nothing kept.
    assert.deepStrictEqual(await browserUtils.estimateStorage(), { usage: null, quota: null });
    assert.strictEqual(await browserUtils.persistStorage(), false);
    const saved = globalThis.navigator;
    Object.defineProperty(globalThis, 'navigator', {
      value: { storage: { estimate: async () => ({ usage: 10, quota: 100 }), persist: async () => true } },
      configurable: true,
      writable: true,
    });
    try {
      assert.deepStrictEqual(await browserUtils.estimateStorage(), { usage: 10, quota: 100 });
      assert.strictEqual(await browserUtils.persistStorage(), true);
    } finally {
      Object.defineProperty(globalThis, 'navigator', { value: saved, configurable: true, writable: true });
    }
  });
});
