// The Expo page (docs/guide/storage-expo.md) shows the regions of this file.
// tests/package/docs-examples.test.js runs it from an empty temporary directory. Node has no expo-sqlite, so the
// `SQLite` below is a stand-in with the six calls of expo-sqlite's async API the driver uses, over node:sqlite:
// what runs here is the driver and the engine, not Expo.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

const SQLite = {
  async openDatabaseAsync(name) {
    const db = new DatabaseSync(name);
    return {
      execAsync: async (source) => void db.exec(source),
      runAsync: async (source, params) => db.prepare(source).run(...params),
      getFirstAsync: async (source, params) => db.prepare(source).get(...params) ?? null,
      getAllAsync: async (source, params) => db.prepare(source).all(...params),
      closeAsync: async () => db.close(),
    };
  },
};

// #region driver
import { sqliteEngine } from '@alexify/syncom/sqlite';

// expo-sqlite's async API behind the calls the SQLite engine makes.
const expoDriver = (SQLite) => ({
  async open(file) {
    const db = await SQLite.openDatabaseAsync(file);
    return {
      exec: (sql) => db.execAsync(sql),
      prepare: (sql) => ({
        run: (...params) => db.runAsync(sql, params),
        get: (...params) => db.getFirstAsync(sql, params),
        all: (...params) => db.getAllAsync(sql, params),
      }),
      close: () => db.closeAsync(),
    };
  },
});
// #endregion driver

// #region open
import { createDatabase } from '@alexify/syncom';
// In the app, SQLite is the expo-sqlite module: import * as SQLite from 'expo-sqlite';

const engine = sqliteEngine({ file: 'board.db', driver: expoDriver(SQLite) });
const db = await createDatabase({ path: 'board', engine });
const id = await db.insert({ title: 'Stored through expo-sqlite' });
// #endregion open
assert.deepEqual(await db.get(id), { title: 'Stored through expo-sqlite' });
await db.close();
await engine.close();

const again = await createDatabase({ path: 'board', engine });
assert.deepEqual(await again.get(id), { title: 'Stored through expo-sqlite' });
await again.close();
await engine.close();
