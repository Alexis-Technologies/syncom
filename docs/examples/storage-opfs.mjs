// docs-examples: browser-only (OPFS and Web Locks are browser APIs)
// The OPFS page (docs/guide/storage-opfs.md) shows the regions of this file. It runs in a page served over HTTPS or
// from localhost, bundled with the browser build of the package; the same calls over node:fs run in
// storage-filesystem.mjs.

// #region open
import { createDatabase } from '@alexify/syncom/all';

// In a browser, `path` names a directory in the Origin Private File System.
const db = await createDatabase({ path: 'board', schema: { entities: { Task: { index: ['done'] } } } });
await db.Task.insert({ title: 'Stored in OPFS', done: false });
// #endregion open

// #region persist
const kept = await db.persist(); // true once the browser agrees not to evict this origin's storage
const { usage, quota } = await db.quota(); // the origin's bytes used and allowed, from the Storage API
console.log(kept, usage, quota);
// #endregion persist

// #region locked
try {
  await createDatabase({ path: 'board' }); // a second instance: another tab, or this one again
} catch (error) {
  console.log(error.code); // 'ALX_ERR_LOCKED': the first instance holds the database through Web Locks
}
// #endregion locked

await db.close();

// #region worker-main
// main.js: the page starts a worker that owns the database.
const worker = new Worker(new URL('./board-worker.js', import.meta.url), { type: 'module' });
worker.onmessage = (event) => console.log('tasks:', event.data);
worker.postMessage({ title: 'Typed in the page', done: false });
// #endregion worker-main
