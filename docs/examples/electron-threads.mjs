// The Electron page (docs/guide/electron.md) runs its wiring here without Electron: the main thread stands in for
// the main process and a worker thread for the window, a MessageChannel's ports for MessageChannelMain's.
// The file runs twice: as the main thread, and as the worker it starts from this same file.
// tests/package/docs-examples.test.js runs it from an empty temporary directory.
import assert from 'node:assert/strict';
import { Worker, isMainThread, workerData, parentPort } from 'node:worker_threads';
import { createDatabase } from '@alexify/syncom/all';
import { connectEngine, serveEngine } from '@alexify/syncom/engines';
import { memoryEngine } from '@alexify/syncom/memory';

if (isMainThread) {
  // #region main
  // The "main process": it owns the engine and serves it on one end of a channel.
  const engine = memoryEngine(); // in Electron: sqliteEngine({ file }) in the user's data folder
  const { port1, port2 } = new MessageChannel();
  const served = serveEngine(engine, port1, { allow: ['board'] });

  // The "window": it gets the other end, as webContents.postMessage(channel, null, [port2]) hands it over.
  const renderer = new Worker(new URL(import.meta.url), { workerData: { port: port2 }, transferList: [port2] });
  // #endregion main
  const [id] = await new Promise((resolve, reject) => {
    renderer.once('message', resolve);
    renderer.once('error', reject);
  });
  await new Promise((resolve) => renderer.once('exit', resolve));
  // The window is gone; what it wrote is the main process's.
  await served.close();
  const kept = await createDatabase({ path: 'board', engine, logger: false });
  assert.deepEqual(await kept.get(id), { title: 'Written in the window, stored by the main process' });
  await kept.close();
} else {
  // #region renderer
  // The "window": the database lives here, every byte of its storage in the main process.
  const engine = await connectEngine(workerData.port);
  const board = await createDatabase({ path: 'board', engine });
  const id = await board.insert({ title: 'Written in the window, stored by the main process' });
  await createDatabase({ path: 'settings', engine }).catch((error) => console.log(error.message));
  // serveEngine(): settings is not served over this port
  // #endregion renderer
  await board.close();
  await engine.close();
  parentPort.postMessage([id]);
}
