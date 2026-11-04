import { expectType } from 'tsd';
import { query, matches } from '../src/query/query.js';
import type { Plugin, Cursor, QueryRow } from '../src/query/query.js';
import { open } from '../index.js';
import { schema } from '../src/schema/schema.js';

expectType<Plugin>(query);
const storage = await open({ plugins: [schema, query], schema: { entities: { Post: { index: ['title'] } } } });
expectType<Cursor>(storage.Post.select({ title: 'x' }));
expectType<Promise<QueryRow[]>>(storage.Post.select().order('title').limit(10).fetch());
expectType<Promise<number>>(storage.Post.count({ title: { $gt: 'a' } }));
expectType<(doc: object) => boolean>(matches({ title: { $type: 'string' } }));
expectType<boolean>(matches<{ n: number }>({ n: { $mod: [2, 0] } })({ n: 2 }));
