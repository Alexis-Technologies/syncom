// RxDB's side of the "Coming from RxDB" code group of docs/guide/attachments.md, run by
// `pnpm docs:examples:rxdb` against the rxdb of bench/compare.
import assert from 'node:assert/strict';
import { createRxDatabase, addRxPlugin } from 'rxdb';
import { getRxStorageMemory } from 'rxdb/plugins/storage-memory';
import { RxDBAttachmentsPlugin } from 'rxdb/plugins/attachments';

addRxPlugin(RxDBAttachmentsPlugin);
const board = await createRxDatabase({ name: 'board', storage: getRxStorageMemory() });
// #region put
await board.addCollections({
  tasks: {
    schema: {
      version: 0,
      primaryKey: 'id',
      type: 'object',
      properties: { id: { type: 'string', maxLength: 100 }, title: { type: 'string' } },
      attachments: {}, // a collection takes attachments only when its schema says so
    },
  },
});
const task = await board.tasks.insert({ id: 'login', title: 'Fix the login page' });
const screenshot = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

await task.putAttachment({ id: 'screenshot.png', data: new Blob([screenshot]), type: 'image/png' });
const attachment = (await board.tasks.findOne('login').exec()).getAttachment('screenshot.png');
const bytes = new Uint8Array(await (await attachment.getData()).arrayBuffer());
// #endregion put
assert.deepEqual(bytes, screenshot);
await board.close();
