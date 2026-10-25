import { expectAssignable, expectType } from 'tsd';
import { schema, ValidationError } from '../src/schema/schema.js';
import type {
  Plugin,
  Schema,
  SchemaStatus,
  Shapes,
  SchemaOutput,
  SchemaInput,
  RecordData,
} from '../src/schema/schema.js';
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
// The record types a schema carries for the types alone.
interface Note {
  body: string;
  pinned: boolean;
}
const shaped: Schema<{ Note: Note }> = { entities: { Note: { index: ['pinned'] } } };
const typed = await open({ plugins: [schema], schema: shaped });
expectType<Promise<Note | null>>(typed.Note.get('id'));
expectType<Promise<void>>(typed.Note.update('id', { pinned: true }));
expectAssignable<Shapes>({ Note: {} as Note });
expectType<RecordData>({} as SchemaOutput<{ type: 'object' }>);
expectType<RecordData>({} as SchemaInput<{ type: 'object' }>);
