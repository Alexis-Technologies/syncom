// docs-examples: browser-only (a SharedWorker over IndexedDB; docs/examples/storage-shared-worker.mjs runs the same wiring in Node)
// The SharedWorker page (docs/guide/storage-shared-worker.md) shows the worker of this file; the tab is
// storage-shared-worker-tab.mjs. Both import port-channel.js: the `channel` region of storage-shared-worker.mjs.

// #region worker
// shared-worker.js, started by every tab with new SharedWorker(url, { type: 'module' })
import { createDatabase } from '@alexify/syncom/all';
import { idbEngine } from '@alexify/syncom/idb';
import { openShared } from '@alexify/syncom/shared';
import { servePort } from './port-channel.js';

const schema = { entities: { Task: {} } };

// The leader: the full database, its writes and its sync.
const ready = (async () => {
  const shared = await openShared({
    createDatabase,
    engine: idbEngine({ name: 'board' }),
    path: 'board',
    schema,
    election: { locks: navigator.locks }, // a newer worker waits until this one lets go
  });
  await shared.waitForLeadership();
  return shared.serve();
})();

self.onconnect = (event) => {
  const [tab] = event.ports;
  tab.onmessage = async ({ data }) => servePort(data.port, await ready);
};
// #endregion worker
