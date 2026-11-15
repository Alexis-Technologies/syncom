// The Agent tools page (docs/guide/mcp.md) shows the regions of this file.
// tests/package/docs-examples.test.js runs it from an empty temporary directory.
import assert from 'node:assert/strict';
// #region tools
import { createDatabase } from '@alexify/syncom/all';
import { createTools } from '@alexify/syncom/mcp';

const board = await createDatabase({ path: 'board', schema: { entities: { Task: { index: ['done'] } } } });
const tools = createTools(board, { collections: ['Task'] });
console.log(tools.map((tool) => tool.name));
// [ 'Task_query', 'Task_count', 'Task_get', 'Task_changes', 'Task_wait_changes',
//   'Task_insert', 'Task_upsert', 'Task_delete' ]
// #endregion tools
assert.deepEqual(
  tools.map((tool) => tool.name),
  [
    'Task_query',
    'Task_count',
    'Task_get',
    'Task_changes',
    'Task_wait_changes',
    'Task_insert',
    'Task_upsert',
    'Task_delete',
  ],
);

// #region execute
const byName = new Map(tools.map((tool) => [tool.name, tool]));

const { id } = await byName.get('Task_insert').execute({ data: { title: 'Write the docs', done: false } });
await byName.get('Task_insert').execute({ data: { title: 'Ship it', done: false } });

const open = await byName.get('Task_query').execute({ query: { done: false }, order: ['title'], limit: 10 });
console.log(open.rows.map((row) => row.title)); // [ 'Ship it', 'Write the docs' ]
console.log(await byName.get('Task_count').execute({ query: { done: false } })); // { count: 2 }
// #endregion execute
assert.deepEqual(
  open.rows.map((row) => row.title),
  ['Ship it', 'Write the docs'],
);
assert.deepEqual(await byName.get('Task_count').execute({ query: { done: false } }), { count: 2 });
assert.equal((await byName.get('Task_get').execute({ id })).record.title, 'Write the docs');

// #region annotations
console.log(byName.get('Task_query').annotations);
// { title: 'Task_query', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
console.log(byName.get('Task_delete').annotations);
// { title: 'Task_delete', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }
// #endregion annotations
assert.deepEqual(byName.get('Task_query').annotations, {
  title: 'Task_query',
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
});
assert.deepEqual(byName.get('Task_delete').annotations, {
  title: 'Task_delete',
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: false,
});
assert.deepEqual(byName.get('Task_insert').annotations, {
  title: 'Task_insert',
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
});

// #region read-only
const readers = createTools(board, { collections: ['Task'], readOnly: true });
console.log(readers.map((tool) => tool.name));
// [ 'Task_query', 'Task_count', 'Task_get', 'Task_changes', 'Task_wait_changes' ]
// #endregion read-only
assert.deepEqual(
  readers.map((tool) => tool.name),
  ['Task_query', 'Task_count', 'Task_get', 'Task_changes', 'Task_wait_changes'],
);
const two = createTools(board, { collections: ['Task'], tools: ['query', 'get'] });
assert.deepEqual(
  two.map((tool) => tool.name),
  ['Task_query', 'Task_get'],
);

// #region door
const query = byName.get('Task_query');
for (const args of [
  { query: { done: false }, limit: 5000 }, // past the cap
  { query: { done: false }, sort: ['title'] }, // a member the schema does not name
  { query: { title: { $regex: '^(a+)+$' } } }, // a pattern of the model's
]) {
  try {
    await query.execute(args);
  } catch (error) {
    console.log(error.name, error.message);
  }
}
// TypeError args.limit: 1000 at most
// TypeError args.sort is not a member
// TypeError args.query.title.$regex is not allowed: createTools({ regex: true })
// #endregion door
await assert.rejects(query.execute({ query: { done: false }, limit: 5000 }), {
  name: 'TypeError',
  message: 'args.limit: 1000 at most',
});
await assert.rejects(query.execute({ query: { done: false }, sort: ['title'] }), {
  name: 'TypeError',
  message: 'args.sort is not a member',
});
await assert.rejects(query.execute({ query: { title: { $regex: '^(a+)+$' } } }), {
  name: 'TypeError',
  message: 'args.query.title.$regex is not allowed: createTools({ regex: true })',
});
await assert.rejects(byName.get('Task_get').execute({}), { name: 'TypeError', message: 'args.id is required' });
await assert.rejects(byName.get('Task_get').execute({ id: 'x', constructor: 1 }), {
  name: 'TypeError',
  message: 'args.constructor is not a member',
});

// #region check-args
import { checkArgs } from '@alexify/syncom/mcp';

const schema = byName.get('Task_get').inputSchema;
checkArgs(schema, { id }); // passes: nothing happens
try {
  checkArgs(schema, { id: 42 });
} catch (error) {
  console.log(error.message); // args.id: string expected, number given
}
// #endregion check-args
assert.throws(() => checkArgs(schema, { id: 42 }), { message: 'args.id: string expected, number given' });

// #region changes
const changes = byName.get('Task_changes');
const { eventId } = await changes.execute(); // no `since`: where to start from
await board.Task.update(id, { done: true });
const page = await changes.execute({ since: eventId });
console.log(page.changes, page.more); // [ { id: '…', deleted: false } ] false
// next time: changes.execute({ since: page.eventId })
// #endregion changes
assert.deepEqual(page.changes, [{ id, deleted: false }]);
assert.equal(page.more, false);
assert.deepEqual((await changes.execute({ since: page.eventId })).changes, []);

// #region wait
const waiting = byName.get('Task_wait_changes').execute({ since: page.eventId, timeout: 10_000 });
await board.Task.delete(id); // a write from the app, a peer, or another tool call
console.log((await waiting).changes); // [ { id: '…', deleted: true } ]
// #endregion wait
assert.deepEqual((await waiting).changes, [{ id, deleted: true }]);
assert.deepEqual(await byName.get('Task_delete').execute({ id }), { id, deleted: false });

// #region handlers
// What an MCP server answers at tools/list and runs at tools/call.
const listTools = async () => ({
  tools: tools.map(({ name, description, inputSchema, annotations }) => ({
    name,
    description,
    inputSchema,
    annotations,
  })),
});

const callTool = async ({ params }) => {
  const tool = byName.get(params.name);
  if (tool === undefined) return { isError: true, content: [{ type: 'text', text: `No tool ${params.name}` }] };
  try {
    const result = await tool.execute(params.arguments ?? {});
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  } catch (error) {
    // A TypeError from the door, or a SyncomError from the collection: the model reads it and tries again
    return { isError: true, content: [{ type: 'text', text: `${error.code ?? error.name}: ${error.message}` }] };
  }
};
// #endregion handlers
assert.equal((await listTools()).tools.length, 8);
const answer = await callTool({ params: { name: 'Task_count', arguments: { query: {} } } });
assert.deepEqual(answer, { content: [{ type: 'text', text: '{"count":1}' }] });
const wrong = await callTool({ params: { name: 'Task_get', arguments: {} } });
assert.deepEqual(wrong, { isError: true, content: [{ type: 'text', text: 'TypeError: args.id is required' }] });

// A stand-in for the browser's WebMCP registry, so the recipe below runs in Node.
const registered = [];
const document = { modelContext: { registerTool: (tool) => registered.push(tool) } };
// #region webmcp
// In a browser that ships WebMCP (an experimental API): each tool is registered as it is
const modelContext = document.modelContext ?? navigator.modelContext;
for (const tool of createTools(board, { readOnly: true })) modelContext.registerTool(tool);
// #endregion webmcp
assert.deepEqual(
  registered.map((tool) => tool.name),
  ['Task_query', 'Task_count', 'Task_get', 'Task_changes', 'Task_wait_changes'],
);
assert.equal(typeof registered[0].execute, 'function');

await board.close();
