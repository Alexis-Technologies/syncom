// RxDB's side of the Agent tools page's "Coming from RxDB" code group (docs/guide/mcp.md), run by
// `pnpm docs:examples:rxdb` against the rxdb of bench/compare.
import assert from 'node:assert/strict';
import { createRxDatabase } from 'rxdb';
import { getRxStorageMemory } from 'rxdb/plugins/storage-memory';

// A stand-in for the browser's WebMCP registry, so the recipe below runs in Node.
const registered = [];
globalThis.document = { modelContext: { registerTool: (tool) => registered.push(tool) } };

// #region webmcp
import { addRxPlugin } from 'rxdb';
import { RxDBWebMCPPlugin } from 'rxdb/plugins/webmcp';

addRxPlugin(RxDBWebMCPPlugin);
const board = await createRxDatabase({ name: 'board', storage: getRxStorageMemory() });
await board.addCollections({
  tasks: {
    schema: {
      version: 0,
      primaryKey: 'id',
      type: 'object',
      properties: { id: { type: 'string', maxLength: 100 }, title: { type: 'string' }, done: { type: 'boolean' } },
      required: ['id', 'title', 'done'],
    },
  },
});
board.registerWebMCP({ readOnly: true }); // the tools of every collection, at document.modelContext
// #endregion webmcp
assert.ok(registered.length > 0);
assert.ok(registered.every((tool) => typeof tool.execute === 'function'));
assert.ok(!registered.some((tool) => tool.name.startsWith('rxdb_insert')));
console.log(registered.map((tool) => tool.name));
await board.close();
