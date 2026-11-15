// The TypeScript page (docs/guide/typescript.md) shows the regions of this file. It is TypeScript, so
// tests/package/docs-examples.test.js does not run it; `node typescript.mts` runs it (Node.js strips the
// types) and `tsc --strict` checks it, the @ts-expect-error lines included.
import assert from 'node:assert/strict';
// #region standard
import { Schema } from '@alexify/metaschema';
import { createDatabase } from '@alexify/syncom/all';

const Task = Schema.from({
  title: 'string',
  done: { type: 'boolean', default: false },
  'tags?': { array: 'string' },
});

const db = await createDatabase({
  path: 'board',
  schema: { entities: { Task: { schema: Task, index: ['done'] } } },
});

const task = await db.Task.insert({ title: 'Write the docs' }); // `done` has a default
const title: string = task.title;
const rows = await db.Task.select({ done: false }).order('title').fetch();
const done: boolean = rows[0].done; // a row is the record under its `id`
// #endregion standard
assert.equal(title, 'Write the docs');
assert.equal(done, false);

// #region mistakes
// @ts-expect-error: `done` is a boolean
await db.Task.update(task.id, { done: 'yes' }).catch(() => {}); // and a ValidationError at run time

// @ts-expect-error: the record has no field `titel`
db.Task.select({ titel: 'Write the docs' });

db.Task.select({ 'assignee.name': 'ada' }); // a dotted path is not checked
// #endregion mistakes

// #region readers
interface Note {
  body: string;
  pinned: boolean;
}

const id = await db.insert({ body: 'Outside any collection', pinned: false });
const note = await db.get<Note>(id); // Note | null
const live = await db.document<Note>(id); // SyncomDocument<Note>
live.pinned = true;
await live.save();
const cached = db.getCachedData<Note>(id); // Note | null, no I/O
const read = await db.transact((tx) => tx.get<Note>(id)); // Note | null
// #endregion readers
assert.equal(note?.body, 'Outside any collection');
assert.equal(cached?.pinned, true);
assert.equal(read?.pinned, true);
await db.close();
