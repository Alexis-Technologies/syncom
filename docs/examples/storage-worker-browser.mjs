// docs-examples: browser-only (a browser Worker over IndexedDB; docs/examples/storage-worker.mjs runs the same wiring in Node)
// The Worker page (docs/guide/storage-worker.md) shows the regions of this file: two files of a web app, side by side.

// #region worker
// engine-worker.js, started with new Worker(url, { type: 'module' })
import { idbEngine } from '@alexify/syncom/idb';
import { serveEngine } from '@alexify/syncom/engines';

serveEngine(idbEngine({ name: 'board' }), self);
// #endregion worker

// #region page
// app.js, on the page
import { createDatabase } from '@alexify/syncom/all';
import { connectEngine } from '@alexify/syncom/engines';

const worker = new Worker(new URL('./engine-worker.js', import.meta.url), { type: 'module' });
const engine = await connectEngine(worker);
const board = await createDatabase({ path: 'board', engine, schema: { entities: { Task: {} } } });

await board.Task.insert({ title: 'Written through a worker' });
// #endregion page
