// docs-examples: browser-only (a SharedWorker over IndexedDB; docs/examples/storage-shared-worker.mjs runs the same wiring in Node)
// The SharedWorker page (docs/guide/storage-shared-worker.md) shows the tab of this file; the worker is
// storage-shared-worker-browser.mjs.

// #region tab
// app.js, in every tab
import { createDatabase } from '@alexify/syncom/all';
import { idbEngine } from '@alexify/syncom/idb';
import { openShared } from '@alexify/syncom/shared';
import { portChannel } from './port-channel.js';

const worker = new SharedWorker(new URL('./shared-worker.js', import.meta.url), { type: 'module' });

const board = await openShared({
  createDatabase,
  engine: idbEngine({ name: 'board' }), // the tab reads IndexedDB itself
  path: 'board',
  schema: { entities: { Task: {} } },
  election: { follower: true }, // a tab never leads: the worker does
  channel: () => {
    const { port1, port2 } = new MessageChannel();
    worker.port.postMessage({ port: port2 }, [port2]);
    return portChannel(port1);
  },
});

await board.collection('Task').insert({ title: 'Written in a tab' });
// #endregion tab
