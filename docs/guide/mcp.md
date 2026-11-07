# Agent tools

`@alexify/syncom/mcp` gives an agent tools over a database in the shape of the
[Model Context Protocol](https://modelcontextprotocol.io): `createTools(db, options)` answers one set per collection —
`query`, `count`, `get`, `changes`, `wait_changes`, and `insert`, `upsert`, `delete` unless `readOnly` — each a plain
`{ name, description, inputSchema, execute }`. It imports no SDK: an MCP server answers the definitions at `tools/list`
and runs `execute` at `tools/call`; in a browser, WebMCP's `navigator.modelContext.registerTool(tool)` takes a tool as
it is.

```js
const { createDatabase } = require('@alexify/syncom/all');
const { createTools } = require('@alexify/syncom/mcp');

const db = await createDatabase({ path: 'data', schema: { entities: { Task: { index: ['done'] } } } });
const tools = createTools(db, { collections: ['Task'], readOnly: false, limit: 100 });
tools.map((tool) => tool.name);
// ['Task_query', 'Task_count', 'Task_get', 'Task_changes', 'Task_wait_changes', 'Task_insert', 'Task_upsert', 'Task_delete']
const { id } = await tools[5].execute({ data: { title: 'write the guide', done: false } });
await tools[0].execute({ query: { done: false }, order: ['title'], limit: 10 }); // { rows: [{ id, title, done, $type }] }
```

## The tools

| Tool | Arguments | Answer |
| --- | --- | --- |
| `<Collection>_query` | `query` (a [Mango query](./query)), `order` (fields, `'-field'` descending), `limit` (100 by default, `limit` of the options at most), `offset` | `{ rows }` |
| `<Collection>_count` | `query` | `{ count }` |
| `<Collection>_get` | `id` | `{ record }` — null where there is none |
| `<Collection>_changes` | `since` (optional) | `{ eventId, changes }`: without `since`, the `eventId` to start from; with one, the collection's records the log touched since — an id once, `deleted` as it stands now — and the `eventId` to ask from next. `changes: null` where the log cannot resume at `since` (another epoch, a position compacted away): list the collection again |
| `<Collection>_wait_changes` | `since`, `timeout` (30 000 ms by default, 120 000 at most) | What `_changes` answers once there is a change after `since`, or at the timeout with none — the long poll an agent waits on |
| `<Collection>_insert` | `data` | `{ id }` |
| `<Collection>_upsert` | `id` (optional), `data` | `{ id }`: the record written whole under `id`, or under the id its data names (the entity's id field) |
| `<Collection>_delete` | `id` | `{ id, deleted }` — `false` where there is none (nothing is written); a record of another collection is `NOT_FOUND` |

`createTools(db, { collections, readOnly, limit, sealed })`: `collections` names the collections to serve (every one
of `db.collections` by default), `readOnly` makes no writer at all, `limit` caps a query's window (1000 by default
and at most), and `sealed` lets the agent read the collections' [sealed records](./query#sealed-records) too — left
out of `query`, `count` and `get` by default: an agent is a reader of the plain rows unless the application says
otherwise.

## Checked at the door

A tool is called by a model. `execute(args)` checks `args` against the tool's `inputSchema` before anything runs:
a member of another type, one the schema does not name (every object is closed), a required one missing, a window
past the cap, a wait past two minutes is a `TypeError` naming the member — `args.id is required`,
`args.limit: 100 at most` — and the server reports it as the tool's error. What passes the schema runs the
collection's own call, whose refusals come through as they are: `NOT_FOUND` for a delete of what is not there, a
validator's `ValidationError`, `PLUGIN_MISSING` where the database has no query plugin. `checkArgs(schema, args)`
is the check on its own.

## Registering the tools

With the MCP SDK's server, the definitions are what `tools/list` answers and `execute` what `tools/call` runs —
JSON Schema is the protocol's own shape for `inputSchema`, so nothing is translated:

```js
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const tools = createTools(db, { readOnly: true });
const byName = new Map(tools.map((tool) => [tool.name, tool]));
const server = new Server({ name: 'tasks', version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
}));
server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
  const tool = byName.get(params.name);
  if (tool === undefined) return { isError: true, content: [{ type: 'text', text: `no tool ${params.name}` }] };
  try {
    const result = await tool.execute(params.arguments ?? {});
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  } catch (error) {
    return { isError: true, content: [{ type: 'text', text: `${error.code ?? error.name}: ${error.message}` }] };
  }
});
await server.connect(new StdioServerTransport());
```

In a browser, WebMCP registers a tool as it is — the same four members:

```js
for (const tool of createTools(db)) navigator.modelContext.registerTool(tool);
```

The SDK and WebMCP are not dependencies of this repository; the two recipes follow their documented shapes
(`tools/list`, `tools/call`, `registerTool({ name, description, inputSchema, execute })`) and were not run here.

## Checked how

`tests/mcp.test.js`: the set of tools per collection and `readOnly` without writers; every argument refused as the
schema says, before anything runs; the writers and readers round-trip; `changes` from an `eventId`, an id once, a
deleted record said so, `null` where the log cannot resume; `wait_changes` resolving on a change, at once where
there is something, at its timeout with nothing.
