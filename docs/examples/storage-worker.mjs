// The Worker page (docs/guide/storage-worker.md) shows the regions of this file. It runs twice: as the main
// thread, and as the worker thread the main thread starts from this same file.
// tests/package/docs-examples.test.js runs it from an empty temporary directory.
import assert from 'node:assert/strict';
import { isMainThread } from 'node:worker_threads';

if (!isMainThread) {
  // #region worker
  // engine-worker.mjs: the storage lives here, and so does every synchronous SQLite call
  const { parentPort } = await import('node:worker_threads');
  const { sqliteEngine } = await import('@alexify/syncom/sqlite');
  const { serveEngine } = await import('@alexify/syncom/engines');

  serveEngine(sqliteEngine({ file: 'board.sqlite' }), parentPort);
  // #endregion worker
} else {
  // #region main
  // main.mjs: the database lives here; its reads and writes cross to the worker
  const { Worker } = await import('node:worker_threads');
  const { createDatabase } = await import('@alexify/syncom/all');
  const { connectEngine } = await import('@alexify/syncom/engines');

  const worker = new Worker(new URL('./storage-worker.mjs', import.meta.url), {
    execArgv: ['--no-warnings=ExperimentalWarning'], // node:sqlite still warns on load
  });
  const engine = await connectEngine(worker);

  const board = await createDatabase({ path: 'board', engine, schema: { entities: { Task: {} } } });
  const task = await board.Task.insert({ title: 'Written through a worker' });
  console.log(engine.name, await board.Task.get(task.id)); // sqlite { title: 'Written through a worker', $type: 'Task' }
  // #endregion main
  assert.equal(engine.name, 'sqlite');
  assert.deepEqual(await board.Task.get(task.id), { title: 'Written through a worker', $type: 'Task' });

  // #region close
  await board.close(); // the database first
  await engine.close(); // then your end of the port
  await worker.terminate(); // and the worker with the storage
  // #endregion close

  // The file is the worker's: a new worker over it serves what the first one wrote.
  const second = new Worker(new URL('./storage-worker.mjs', import.meta.url), {
    execArgv: ['--no-warnings=ExperimentalWarning'],
  });
  const again = await createDatabase({ path: 'board', engine: await connectEngine(second), logger: false });
  assert.equal((await again.list()).length, 1);
  await again.close();
  await second.terminate();
}
