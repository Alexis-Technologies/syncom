import { expectType } from 'tsd';
import { supabase } from '../src/connector/supabase.js';
import type { SupabaseHandlers, SupabaseLikeClient } from '../src/connector/supabase.js';
import { replicate } from '../src/connector/connector.js';
import { createDatabase } from '../index.js';

declare const client: SupabaseLikeClient;
const db = await createDatabase({ path: 'data' });
const handlers = supabase({ client, table: 'tasks', primaryKey: 'id', modifiedColumn: 'updated_at', stream: true });
expectType<SupabaseHandlers>(handlers);
expectType<string | undefined>(handlers.stampOf('t1'));
replicate(db, { name: 'supabase', collection: 'Task', ...handlers });
