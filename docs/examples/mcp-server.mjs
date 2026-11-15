// docs-examples: browser-only (needs @modelcontextprotocol/sdk, which this repository does not install)
// The Agent tools page (docs/guide/mcp.md) shows the region of this file: a stdio MCP server over a database.
// docs/examples/mcp.mjs runs the same two handlers in Node; this file is only parsed.
import { createDatabase } from '@alexify/syncom/all';
import { createTools } from '@alexify/syncom/mcp';

const board = await createDatabase({ path: 'board', schema: { entities: { Task: { index: ['done'] } } } });
const tools = createTools(board, { readOnly: true });
const byName = new Map(tools.map((tool) => [tool.name, tool]));
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
    return { isError: true, content: [{ type: 'text', text: `${error.code ?? error.name}: ${error.message}` }] };
  }
};

// #region sdk
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const server = new Server({ name: 'task-board', version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, listTools);
server.setRequestHandler(CallToolRequestSchema, callTool);
await server.connect(new StdioServerTransport());
// #endregion sdk
