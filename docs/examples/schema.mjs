// The Schema page (docs/guide/schema.md) shows the regions of this file.
// tests/package/docs-examples.test.js runs it from an empty temporary directory.
import assert from 'node:assert/strict';
import { createDatabase } from '@alexify/syncom/all';

// #region bare
const loose = await createDatabase({ path: 'loose', schema: { entities: { Task: {} } } });
await loose.Task.insert({ title: 'Anything goes', due: '2026-12-01' });
// #endregion bare
await loose.close();

// #region model
import { Model } from '@alexify/metaschema';

const model = new Model(
  {},
  new Map([
    [
      'Task',
      {
        Registry: {},
        title: { type: 'string', length: { min: 1, max: 200 }, aliases: ['name'] },
        done: { type: 'boolean', default: false },
        key: { type: 'string', unique: true },
        'votes?': 'number',
        'tags?': { array: 'string' },
        byDone: { index: ['done'] },
      },
    ],
  ]),
);

const db = await createDatabase({
  path: 'board',
  schema: { entities: { Task: { schema: model.entities.get('Task') } } },
});

const task = await db.Task.insert({ name: 'Write the docs', key: 'T-1' });
console.log(await db.Task.get(task.id));
// { title: 'Write the docs', key: 'T-1', done: false, $type: 'Task' }
// #endregion model
assert.deepEqual(await db.Task.get(task.id), { title: 'Write the docs', key: 'T-1', done: false, $type: 'Task' });

// #region error
import { ValidationError } from '@alexify/syncom';

try {
  await db.Task.insert({ title: '', done: 'no' });
} catch (error) {
  if (!(error instanceof ValidationError)) throw error;
  console.log(error.code, error.entity); // 'VALIDATION_FAILED' 'Task'
  for (const issue of error.issues) console.log(issue.path, issue.code);
  // [ 'title' ] 'length'   [ 'done' ] 'type'   [ 'key' ] 'required'
}
// #endregion error
const invalid = await db.Task.insert({ title: '', done: 'no' }).catch((error) => error);
assert.ok(invalid instanceof ValidationError);
assert.deepEqual(
  invalid.issues.map((issue) => [issue.path.join('.'), issue.code]),
  [
    ['title', 'length'],
    ['done', 'type'],
    ['key', 'required'],
  ],
);
assert.equal(await db.Task.count(), 1);

// #region kinds
await db.inc(task.id, 'votes', 1); // validated as the record reads after it
await db.add(task.id, 'tags', ['docs']);
await db.add(task.id, 'tags', [42]).catch((error) => console.log(error.issues[0].path)); // [ 'tags', 1 ]
// #endregion kinds
const tagged = await db.Task.get(task.id);
assert.equal(tagged.votes, 1);
assert.deepEqual(tagged.tags, ['docs']);
await assert.rejects(() => db.add(task.id, 'tags', [42]), { name: 'ValidationError' });

// #region check
const checked = await db.check('Task', { name: 'Plan the release', key: 'T-2' });
console.log(checked); // { title: 'Plan the release', key: 'T-2', done: false }: nothing written
// #endregion check
assert.deepEqual(checked, { title: 'Plan the release', key: 'T-2', done: false });
assert.equal(await db.Task.count(), 1);

// #region unique
try {
  await db.Task.insert({ title: 'Write more docs', key: 'T-1' });
} catch (error) {
  console.log(error.issues[0]);
  // { path: [ 'key' ], message: 'is not unique (held by …)', code: 'unique', conflict: '…' }
}
// #endregion unique
const clash = await db.Task.insert({ title: 'x', key: 'T-1' }).catch((error) => error);
assert.equal(clash.issues[0].code, 'unique');
assert.equal(clash.issues[0].conflict, task.id);
await db.close();

// #region standard
const Member = {
  '~standard': {
    version: 1,
    vendor: 'my-app',
    validate: (value) =>
      typeof value.name === 'string' && value.name.length > 0
        ? { value: { name: value.name.trim(), role: value.role ?? 'member' } }
        : { issues: [{ message: 'needs a name', path: ['name'] }] },
  },
};
// #endregion standard

// #region function
const tagValidator = (value) => {
  if (typeof value.label !== 'string') throw new Error('label must be a string');
  return { label: value.label.toLowerCase() };
};
// #endregion function

// #region validators
const team = await createDatabase({
  path: 'team',
  schema: { entities: { Member: { schema: Member }, Tag: { schema: tagValidator } } },
});
await team.Member.insert({ name: ' Ada ' }); // stored as { name: 'Ada', role: 'member' }
await team.Tag.insert({ label: 'Docs' }); // stored as { label: 'docs' }
// #endregion validators
assert.deepEqual(
  (await team.Member.select().fetch()).map(({ name, role }) => [name, role]),
  [['Ada', 'member']],
);
assert.equal((await team.Tag.select().one()).label, 'docs');
const unnamed = await team.Member.insert({}).catch((error) => error);
assert.deepEqual(unnamed.issues, [{ path: ['name'], message: 'needs a name' }]);
const unlabeled = await team.Tag.insert({ label: 1 }).catch((error) => error);
assert.equal(unlabeled.issues[0].message, 'label must be a string');
await team.close();

// #region index
const planned = await createDatabase({
  path: 'planned',
  schema: { entities: { Task: { index: ['done', ['done', 'due']] } } },
});
const plan = planned.Task.select({ done: false }).order('due').explain();
console.log(plan.scan, plan.index); // 'index' [ 'done', 'due' ]
// #endregion index
assert.equal(plan.scan, 'index');
assert.deepEqual(plan.index, ['done', 'due']);
await planned.close();

// #region ids
const people = await createDatabase({
  path: 'people',
  schema: {
    entities: {
      Board: { idField: 'slug' }, // the id is the value of `slug`
      Member: { id: { fields: ['board', 'handle'], separator: '-' } }, // the id is built from two fields
    },
  },
});
const board = await people.Board.insert({ slug: 'docs', title: 'Documentation' });
console.log(board.id, await people.Board.get('docs')); // docs { title: 'Documentation', $type: 'Board' }
const member = await people.Member.insert({ board: 'docs', handle: 'ada' });
console.log(member.id); // 'docs-ada'
// #endregion ids
assert.deepEqual(await people.Board.get('docs'), { title: 'Documentation', $type: 'Board' });
assert.equal(member.id, 'docs-ada');
assert.deepEqual(await people.Member.get('docs-ada'), { board: 'docs', handle: 'ada', $type: 'Member' });

// #region exists
const taken = await people.Board.insert({ slug: 'docs', title: 'Again' }).catch((error) => error.code);
console.log(taken); // 'EXISTS'
const kept = await people.Board.insertIfAbsent({ slug: 'docs', title: 'Again' });
console.log(kept.title); // 'Documentation': the record that was there
// #endregion exists
assert.equal(taken, 'EXISTS');
assert.equal(kept.title, 'Documentation');
await people.close();

// #region version
const versioned = await createDatabase({
  path: 'board',
  schema: { version: 2, snapshot: model.toJSON(), entities: { Task: { schema: model.entities.get('Task') } } },
});
console.log(versioned.schemaInfo.version, versioned.schemaInfo.previous); // 2 { version: 1, hash: null }
// #endregion version
assert.equal(versioned.schemaInfo.version, 2);
assert.deepEqual(versioned.schemaInfo.previous, { version: 1, hash: null });
await versioned.close();
