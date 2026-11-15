// The TypeScript page (docs/guide/typescript.md) shows the regions of this file. It is TypeScript, so
// tests/package/docs-examples.test.js does not run it; `node typescript-shapes.mts` runs it and `tsc --strict`
// checks it, the @ts-expect-error lines included.
import assert from 'node:assert/strict';
// #region shapes
import { createDatabase, type Schema } from '@alexify/syncom';
import { schema } from '@alexify/syncom/schema';
import { query } from '@alexify/syncom/query';

interface Task {
  title: string;
  done: boolean;
  votes?: number;
}
interface Member {
  name: string;
}

const board: Schema<{ Task: Task; Member: Member }> = {
  entities: { Task: { index: ['done'] }, Member: {} },
};
const db = await createDatabase({ path: 'board', plugins: [schema, query], schema: board });

const task = await db.Task.insert({ title: 'Write the docs', done: false }); // SyncomDocument<Task>
const member = await db.Member.get('ada'); // Member | null
// @ts-expect-error: the schema has no collection `Tag`
console.log(db.Tag); // undefined at run time too
// #endregion shapes
assert.equal(task.title, 'Write the docs');
assert.equal(member, null);

// #region plugins
// @ts-expect-error: splice() is the text plugin's, and this database was opened without it
db.splice(task.id, 'notes', 0, 0, 'Start here').catch(() => {});

import { text } from '@alexify/syncom/text';

const notes = await createDatabase({ path: 'notes', plugins: [text] });
const id = await notes.insert({ title: 'Write the docs' });
await notes.splice(id, 'notes', 0, 0, 'Start here'); // typed: the text plugin is in `plugins`
// #endregion plugins
await db.close();
await notes.close();
