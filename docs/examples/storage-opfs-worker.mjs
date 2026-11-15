// docs-examples: browser-only (OPFS and Web Locks are browser APIs; runs as a module worker)
// The OPFS page (docs/guide/storage-opfs.md) shows the region of this file: the worker that storage-opfs.mjs's
// page starts.
// #region worker
// board-worker.js: the database lives here, off the page's thread.
import { createDatabase } from '@alexify/syncom/all';

const board = await createDatabase({ path: 'board', schema: { entities: { Task: { index: ['done'] } } } });
self.onmessage = async (event) => {
  await board.Task.insert(event.data);
  self.postMessage(await board.Task.count({}));
};
// #endregion worker
