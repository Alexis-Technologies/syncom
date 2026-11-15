// RxDB's side of the Remote engine page's "Coming from RxDB" code group (docs/guide/storage-remote.md),
// run by `pnpm docs:examples:rxdb` against the rxdb of bench/compare.
import assert from 'node:assert/strict';
// #region remote
import { Subject } from 'rxjs';
import { createRxDatabase } from 'rxdb';
import { getRxStorageMemory } from 'rxdb/plugins/storage-memory';
import { exposeRxStorageRemote, getRxStorageRemote } from 'rxdb/plugins/storage-remote';

const { port1, port2 } = new MessageChannel();

// The side that owns the storage: the messages arrive as an observable, the answers leave through send().
const requests = new Subject();
port1.onmessage = (event) => requests.next(event.data);
exposeRxStorageRemote({
  storage: getRxStorageMemory(),
  messages$: requests.asObservable(),
  send: (message) => port1.postMessage(message),
});

// The other side builds the same pair of an observable and send() for every channel the storage asks for.
const storage = getRxStorageRemote({
  identifier: 'board',
  mode: 'one',
  messageChannelCreator: async () => {
    const answers = new Subject();
    port2.onmessage = (event) => answers.next(event.data);
    return { messages$: answers.asObservable(), send: (message) => port2.postMessage(message), close: async () => {} };
  },
});
const board = await createRxDatabase({ name: 'board', storage, multiInstance: false });
// #endregion remote
await board.addCollections({
  tasks: {
    schema: {
      version: 0,
      primaryKey: 'id',
      type: 'object',
      properties: { id: { type: 'string', maxLength: 100 }, title: { type: 'string' } },
      required: ['id', 'title'],
    },
  },
});
await board.tasks.insert({ id: 'remote', title: 'Stored on the other side of the port' });
assert.equal((await board.tasks.findOne('remote').exec()).title, 'Stored on the other side of the port');
await board.close();
port1.close();
port2.close();
