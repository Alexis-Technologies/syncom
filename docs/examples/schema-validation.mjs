// The Schema validation page (docs/guide/schema-validation.md) shows the regions of this file.
// tests/package/docs-examples.test.js runs it from an empty temporary directory.
import assert from 'node:assert/strict';
// #region validate
import { createDatabase } from '@alexify/syncom/all';
import { Schema } from '@alexify/metaschema';

const Task = Schema.from({
  title: { type: 'string', length: { min: 1, max: 200 } },
  'done?': { type: 'boolean', default: false },
  'votes?': 'number',
  'tags?': { array: 'string' },
});

const board = await createDatabase({
  path: 'board',
  schema: { entities: { Task: { schema: Task } } },
});

const task = await board.Task.insert({ title: 'Write the docs' });
console.log(await board.Task.get(task.id));
// { title: 'Write the docs', done: false, $type: 'Task' }   done: the default the validator filled in
// #endregion validate
assert.deepEqual(await board.Task.get(task.id), { title: 'Write the docs', done: false, $type: 'Task' });

// #region refused
try {
  await board.Task.insert({ title: '' });
} catch (error) {
  console.log(error.name, error.code); // ValidationError VALIDATION_FAILED
  console.log(error.entity, error.issues);
  // Task [ { path: [ 'title' ], message: 'value is too short', code: 'length' } ]
}
// #endregion refused
const refused = await board.Task.insert({ title: '' }).catch((error) => error);
assert.equal(refused.name, 'ValidationError');
assert.equal(refused.code, 'VALIDATION_FAILED');
assert.deepEqual(refused.issues, [{ path: ['title'], message: 'value is too short', code: 'length' }]);
assert.equal(await board.Task.count({}), 1, 'nothing was written');

// #region every-write
await board.inc(task.id, 'votes', 1); // the record after the op: votes is 1, a number
await board.add(task.id, 'tags', ['docs']); // tags holds strings

await board.add(task.id, 'tags', [42]).catch((error) => console.log(error.issues));
// [ { path: [ 'tags', 1 ], message: 'not of expected type: string', code: 'type' } ]
await board.Task.update(task.id, { priority: 'high' }).catch((error) => console.log(error.issues));
// [ { path: [], message: 'has unexpected keys: priority', code: 'unexpected' } ]
// #endregion every-write
assert.deepEqual(await board.Task.get(task.id), {
  title: 'Write the docs',
  done: false,
  $type: 'Task',
  votes: 1,
  tags: ['docs'],
});
assert.equal((await board.add(task.id, 'tags', [42]).catch((error) => error)).code, 'VALIDATION_FAILED');

// #region check
const draft = await board.check('Task', { title: 'Plan the release' });
console.log(draft); // { title: 'Plan the release', done: false }   validated, nothing written
// #endregion check
assert.deepEqual(draft, { title: 'Plan the release', done: false });
assert.equal(await board.Task.count({}), 1);
await board.close();

// #region function
const trimmed = (task) => {
  if (typeof task.title !== 'string') throw new Error('title must be a string');
  return { ...task, title: task.title.trim() }; // what it returns is what is stored
};

const notes = await createDatabase({
  path: 'notes',
  schema: { entities: { Task: { schema: trimmed } } },
});
const note = await notes.Task.insert({ title: '  Call the printer  ' });
console.log(await notes.Task.get(note.id)); // { title: 'Call the printer', $type: 'Task' }
// #endregion function
assert.deepEqual(await notes.Task.get(note.id), { title: 'Call the printer', $type: 'Task' });
const thrown = await notes.Task.insert({ title: 7 }).catch((error) => error);
assert.deepEqual(thrown.issues, [{ path: [], message: 'title must be a string' }]);
assert.equal(thrown.cause.message, 'title must be a string');
await notes.close();

// #region standard
// zod, valibot and arktype schemas carry this property; so does a metaschema Schema.
const NonEmptyTitle = {
  '~standard': {
    version: 1,
    vendor: 'my-app',
    validate: (value) =>
      typeof value.title === 'string' && value.title.length > 0
        ? { value }
        : { issues: [{ message: 'a task needs a title', path: ['title'] }] },
  },
};
// #endregion standard
const standard = await createDatabase({ path: 'standard', schema: { entities: { Task: { schema: NonEmptyTitle } } } });
assert.deepEqual((await standard.Task.insert({}).catch((error) => error)).issues, [
  { path: ['title'], message: 'a task needs a title' },
]);
await standard.close();

// #region compile
// Ajv fits as it is: createDatabase({ validator: new Ajv(), schema }). Any object with compile() does.
const requiredOnly = {
  compile(schema, { entity }) {
    const validate = (record) => {
      validate.errors = [];
      for (const key of schema.required) {
        if (key in record) continue;
        validate.errors.push({ instancePath: `/${key}`, keyword: 'required', message: 'required' });
      }
      return validate.errors.length === 0;
    };
    return validate;
  },
};

const tickets = await createDatabase({
  path: 'tickets',
  validator: requiredOnly,
  schema: { entities: { Ticket: { schema: { type: 'object', required: ['title'] } } } },
});
await tickets.Ticket.insert({}).catch((error) => console.log(error.issues));
// [ { path: [ 'title' ], message: 'required', code: 'required' } ]
// #endregion compile
assert.deepEqual((await tickets.Ticket.insert({}).catch((error) => error)).issues, [
  { path: ['title'], message: 'required', code: 'required' },
]);
await tickets.close();

// #region peer
import { createMesh, settle, memoryEngine } from '@alexify/syncom/testing';

const mesh = await createMesh(['server', 'laptop'], [['laptop', 'server']], {
  createStorage: (name, options) => createDatabase({ ...options, engine: memoryEngine(), path: name }),
  nodes: {
    server: { schema: { entities: { Task: { schema: Task } } } }, // the server validates
    laptop: { schema: { entities: { Task: {} } } }, // an old build of the app does not
  },
});
const server = mesh.get('server');
server.on('error', (error) => console.log(error.code, error.entity, error.issues));

await mesh.get('laptop').Task.insert({ title: '' });
await settle(mesh.storages);
// OP_INVALID Task [ { path: [ 'title' ], message: 'value is too short', code: 'length' } ]
console.log(await server.Task.count({})); // 0: the server skipped the op
// #endregion peer
const errors = [];
server.on('error', (error) => errors.push(error));
const empty = await mesh.get('laptop').Task.insert({ title: '' });
await settle(mesh.storages);
assert.equal(errors[0].code, 'OP_INVALID');
assert.equal(errors[0].op.id, empty.id);
assert.equal(await server.Task.count({}), 0);
assert.equal(await mesh.get('laptop').Task.count({}), 2, 'the laptop keeps what it wrote');
await mesh.close();
