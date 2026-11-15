// The SQLite page (docs/guide/storage-sqlite.md) shows the regions of this file.
// tests/package/docs-examples.test.js runs it from an empty temporary directory.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

// #region open
import { createDatabase } from '@alexify/syncom/all';
import { sqliteEngine } from '@alexify/syncom/sqlite';

const engine = sqliteEngine({ file: 'board.sqlite' });
const schema = { entities: { Task: { index: ['done'] } } };

const db = await createDatabase({ path: 'board', schema, engine });
await db.Task.insert({ title: 'Stored in SQLite', done: false });
// #endregion open

// #region close
await db.close(); // the database: its rows stay in the file
await engine.close(); // the connection: the file stays
// #endregion close
assert.ok(existsSync('board.sqlite'));

// #region reopen
const again = await createDatabase({ path: 'board', schema, engine });
console.log(await again.Task.count({})); // 1: the next call opened the file again
// #endregion reopen
assert.equal(await again.Task.count({}), 1);

// #region two-paths
const archive = await createDatabase({ path: 'archive', schema, engine }); // the same file, rows keyed by path
await archive.Task.insert({ title: 'Archived', done: true });
console.log(await again.Task.count({})); // still 1: two databases never share a row
// #endregion two-paths
assert.equal(await again.Task.count({}), 1);
assert.equal(await archive.Task.count({}), 1);
await archive.close();
await again.close();

// #region driver
import { DatabaseSync } from 'node:sqlite';

// A driver opens a file and answers with exec() and prepare() → { run, get, all }.
const driver = { open: (file) => new DatabaseSync(file) };
const viaDriver = sqliteEngine({ file: 'board.sqlite', driver, durable: true });
// #endregion driver
const third = await createDatabase({ path: 'board', schema, engine: viaDriver });
assert.equal(await third.Task.count({}), 1);
await third.close();
await viaDriver.close();

// #region connection
// A connection you opened and keep: the engine never closes it and sets no pragma on it but `durable`.
const connection = new DatabaseSync('board.sqlite');
const shared = sqliteEngine({ database: connection });
// #endregion connection
const fourth = await createDatabase({ path: 'board', schema, engine: shared });
assert.equal(await fourth.Task.count({}), 1);
await fourth.close();
await shared.close();
connection.close();

// #region in-memory
const scratch = sqliteEngine(); // file: ':memory:', gone with the connection
// #endregion in-memory
const temp = await createDatabase({ path: 'temp', schema, engine: scratch });
await temp.Task.insert({ title: 'Scratch', done: false });
await temp.close();
await scratch.close();

// #region destroy
await engine.destroy(); // closes, then deletes board.sqlite with its -wal and -shm files
// #endregion destroy
assert.equal(existsSync('board.sqlite'), false);
assert.equal(existsSync('board.sqlite-wal'), false);
