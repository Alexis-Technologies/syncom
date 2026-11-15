// The Plugins page (docs/guide/plugins.md) shows the regions of this file.
// tests/package/docs-examples.test.js runs it from an empty temporary directory.
import assert from 'node:assert/strict';
// #region lean
import { createDatabase } from '@alexify/syncom';
import { schema } from '@alexify/syncom/schema';
import { query } from '@alexify/syncom/query';
import { text } from '@alexify/syncom/text';

const board = await createDatabase({
  path: 'board',
  plugins: [schema, query, text],
  schema: { entities: { Task: { index: ['done'] } } },
});
console.log(board.plugins); // [ 'schema', 'query', 'text' ]
console.log(board.kinds); // [ 'text' ]
// #endregion lean
assert.deepEqual([...board.plugins], ['schema', 'query', 'text']);
assert.deepEqual([...board.kinds], ['text']);

// #region all
import { createDatabase as createFullDatabase } from '@alexify/syncom/all';

const everything = await createFullDatabase({ path: 'everything' });
console.log(everything.plugins);
// [ 'text', 'tree', 'signing', 'chain', 'encryption', 'sync', 'schema', 'telemetry', 'query', 'versions', 'local' ]
// #endregion all
assert.deepEqual(
  [...everything.plugins],
  ['text', 'tree', 'signing', 'chain', 'encryption', 'sync', 'schema', 'telemetry', 'query', 'versions', 'local'],
);
await everything.close();

// #region per-instance
const notes = await createDatabase({ path: 'notes' }); // the core alone, in the same process as `board`
await board.push('task-1', 'steps', ['Write', 'Review']); // a list: `board` runs the text plugin
try {
  await notes.push('note-1', 'steps', ['Write']);
} catch (error) {
  console.log(error.code); // PLUGIN_MISSING: `notes` was opened without it
}
// #endregion per-instance
assert.deepEqual((await board.get('task-1')).steps, ['Write', 'Review']);
await assert.rejects(notes.push('note-1', 'steps', ['Write']), { name: 'TypeError', code: 'PLUGIN_MISSING' });
await notes.close();

// #region registry
import { createPlugins } from '@alexify/syncom';
import { tree } from '@alexify/syncom/tree';

const registry = createPlugins([text, tree]);
console.log(registry.names); // [ 'text', 'tree' ]
console.log(registry.rank); // { register: 0, counter: 1, set: 2, list: 3, text: 4, tree: 5 }

try {
  createPlugins([text, text]);
} catch (error) {
  console.log(error.message); // createDatabase({ plugins }): plugin 'text' given twice
}
// #endregion registry
assert.deepEqual([...registry.names], ['text', 'tree']);
assert.throws(() => createPlugins([text, text]), { name: 'TypeError', message: /plugin 'text' given twice/ });
assert.deepEqual(registry.rank, { register: 0, counter: 1, set: 2, list: 3, text: 4, tree: 5 });
await board.close();

// #region own-methods
const archive = {
  name: 'archive',
  setup: () => ({}), // nothing to set up before the log opens
  methods: {
    // Called as db.archive(id) or tx.archive(id): syncom passes its write core first
    archive: async (core, id) => {
      await core.commit('set', id, { data: { archived: true, archivedAt: Date.now() } });
    },
  },
};

const tasks = await createDatabase({ path: 'tasks', plugins: [archive] });
const id = await tasks.insert({ title: 'Old task' });
await tasks.archive(id);
console.log((await tasks.get(id)).archived); // true

await tasks.transact(async (tx) => {
  await tx.archive(await tx.insert({ title: 'Another old task' }));
});
// #endregion own-methods
assert.equal((await tasks.get(id)).archived, true);
assert.equal((await tasks.list()).length, 2);
for (const each of await tasks.list()) assert.equal((await tasks.get(each)).archived, true);
await tasks.close();

// #region own-open
const auditTrail = (write) => ({
  name: 'audit-trail',
  // Called once the database is open, with the database itself as `storage`
  open: ({ storage }) => {
    storage.on('commit', ({ op }) => write({ id: op.id, type: op.type, at: op.ts }));
  },
});

const trail = [];
const audited = await createDatabase({ path: 'audited', plugins: [auditTrail((line) => trail.push(line))] });
await audited.insert({ title: 'Watched' });
console.log(trail); // [ { id: '…', type: 'write', at: … } ]
// #endregion own-open
assert.equal(trail.length, 1);
assert.equal(trail[0].type, 'write');
assert.equal(typeof trail[0].at, 'number');
await audited.close();

// A method named like a member of the database is refused when the database opens.
await assert.rejects(
  createDatabase({
    path: 'clash',
    plugins: [{ name: 'clash', setup: () => ({}), methods: { insert: async () => null } }],
  }),
  { name: 'TypeError', message: /insert\(\) is a member of the storage already/ },
);
