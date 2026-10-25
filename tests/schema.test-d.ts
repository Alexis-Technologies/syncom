import { expectType } from 'tsd';
import { schema, ValidationError } from '../src/schema/schema.js';
import type { Plugin, Schema, SchemaStatus } from '../src/schema/schema.js';
import { open } from '../index.js';
import type { SyncomCollection } from '../index.js';

expectType<Plugin>(schema);
const storage = await open({ plugins: [schema], schema: { version: 2, entities: { Post: { index: ['title'] } } } });
expectType<SyncomCollection>(storage.Post);
expectType<SchemaStatus | null>(storage.schemaInfo);
expectType<Promise<unknown>>(storage.check('Post', { title: 'x' }));
expectType<'VALIDATION_FAILED'>(new ValidationError('Post', []).code);
const definition: Schema = { entities: { Note: {} } };
await open({ plugins: [schema], schema: definition });
