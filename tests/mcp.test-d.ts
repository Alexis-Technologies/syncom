import { expectAssignable, expectError, expectType } from 'tsd';
import { createTools, checkArgs, MAX_LIMIT } from '../src/mcp/mcp.js';
import type { AgentTool, ToolChanges, ToolVerb } from '../src/mcp/mcp.js';
import { createDatabase } from '../src/all/all.js';

const db = await createDatabase({ path: 'data', schema: { entities: { Task: { index: ['done'] } } } });
const tools = createTools(db, {
  collections: ['Task'],
  tools: ['query', 'count'],
  readOnly: true,
  limit: 50,
  sealed: false,
  regex: false,
});
expectType<AgentTool[]>(tools);
const [query] = tools;
expectType<string>(query.name);
expectType<string>(query.description);
expectType<boolean>(query.annotations.readOnlyHint);
expectType<false>(query.annotations.openWorldHint);
expectAssignable<ToolVerb>('wait_changes');
expectError<ToolVerb>('drop');
expectError(createTools(db, { tools: ['drop'] }));
expectType<unknown>(await query.execute({ query: { done: false }, order: ['-title'], limit: 10 }));
expectType<unknown>(await query.execute());
checkArgs({ type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }, { id: 'a' });
expectType<1000>(MAX_LIMIT);
const changes: ToolChanges = { eventId: '1.5', changes: [{ id: 'a', deleted: false }], more: false };
expectType<string>(changes.eventId);
expectType<boolean>(changes.more);
