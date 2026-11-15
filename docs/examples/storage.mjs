// The Storage overview page (docs/guide/storage.md) shows the regions of this file.
// tests/package/docs-examples.test.js runs it from an empty temporary directory.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { memory } from '@alexify/syncom/memory';

// #region pick
import { createDatabase } from '@alexify/syncom/all';
import { memoryEngine } from '@alexify/syncom/memory';
import { sqliteEngine } from '@alexify/syncom/sqlite';

const schema = { entities: { Task: { index: ['done'] } } };

// Three ways to open a board: an app picks one. This example opens all three, each under a path of its own.
// No engine: JSON files under ./board (in a browser, the Origin Private File System).
const onDisk = await createDatabase({ path: 'board', schema });
// In memory: nothing touches a disk, and nothing outlives the process.
const inMemory = await createDatabase({ path: 'board-in-memory', schema, engine: memoryEngine() });
// In one SQLite file, ./board.sqlite.
const inSqlite = await createDatabase({
  path: 'board-in-sqlite',
  schema,
  engine: sqliteEngine({ file: 'board.sqlite' }),
});
// #endregion pick

// #region same-code
for (const db of [onDisk, inMemory, inSqlite]) {
  await db.Task.insert({ title: 'Write the docs', done: false });
  await db.Task.insert({ title: 'Ship it', done: true });
  console.log(await db.Task.count({ done: false })); // 1, on every storage
}
// #endregion same-code
for (const db of [onDisk, inMemory, inSqlite]) assert.equal(await db.Task.count({ done: false }), 1);

// #region quota
const { usage, quota } = await inSqlite.quota();
console.log(usage, quota); // bytes the file holds, bytes free on its disk
// #endregion quota
assert.ok(usage > 0);

// An engine and a backend together are refused before anything opens.
assert.throws(() => createDatabase({ path: 'x', engine: memoryEngine(), fsi: memory() }), TypeError);

for (const db of [onDisk, inMemory, inSqlite]) await db.close();
assert.ok(existsSync('board/data'));
assert.ok(existsSync('board.sqlite'));

// #region move
import { filesEngine, read, write, exists, remove, list } from '@alexify/syncom';
import { copyEngine } from '@alexify/syncom/engines';

// The files engine over Node's file system: where createDatabase() without an engine keeps a database.
const files = filesEngine({ read, write, exists, remove, list });
// The database in ./board, closed, copied into SQLite: the same node with the same log.
const target = sqliteEngine({ file: 'moved.sqlite' });
const counts = await copyEngine(files, target, { path: 'board' });
console.log(counts.records); // 2

const moved = await createDatabase({ path: 'board', schema, engine: target });
console.log(await moved.Task.count({})); // 2
// #endregion move
assert.equal(counts.records, 2);
assert.equal(await moved.Task.count({}), 2);
await moved.close();
await target.close();

// #region wrap
import { isEngine } from '@alexify/syncom';

// An engine of your own: here one that counts the write sets of the engine it wraps.
const counting = (engine) => {
  const counter = { writes: 0 };
  const wrapped = {
    name: 'counting',
    capabilities: engine.capabilities,
    remove: (path) => engine.remove(path),
    async open(path, options) {
      const db = await engine.open(path, options);
      return {
        ...db,
        write: async (batch) => {
          counter.writes++;
          return db.write(batch);
        },
      };
    },
  };
  return { engine: wrapped, counter };
};

const { engine, counter } = counting(memoryEngine());
console.log(isEngine(engine)); // true
const counted = await createDatabase({ path: 'board', schema, engine });
await counted.Task.insert({ title: 'Counted', done: false });
await counted.flush();
console.log(counter.writes > 0); // true: the record landed through write()
// #endregion wrap
assert.equal(isEngine(engine), true);
assert.ok(counter.writes > 0);
assert.equal(await counted.Task.count({}), 1);
await counted.close();
