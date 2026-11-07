import { expectType } from 'tsd';
import { createTools, checkArgs, MAX_LIMIT } from '../src/mcp/mcp.js';
import type { AgentTool, ToolChanges } from '../src/mcp/mcp.js';
import { createDatabase } from '../src/all/all.js';

const db = await createDatabase({ path: 'data', schema: { entities: { Task: { index: ['done'] } } } });
const tools = createTools(db, { collections: ['Task'], readOnly: true, limit: 50 });
expectType<AgentTool[]>(tools);
const [query] = tools;
expectType<string>(query.name);
expectType<string>(query.description);
expectType<unknown>(await query.execute({ query: { done: false }, order: ['-title'], limit: 10 }));
expectType<unknown>(await query.execute());
checkArgs({ type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }, { id: 'a' });
expectType<1000>(MAX_LIMIT);
const changes: ToolChanges = { eventId: '1.5', changes: [{ id: 'a', deleted: false }] };
expectType<string>(changes.eventId);
