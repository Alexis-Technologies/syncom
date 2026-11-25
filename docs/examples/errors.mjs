// The Errors page (docs/guide/errors.md) shows the regions of this file.
// tests/package/docs-examples.test.js runs it from an empty temporary directory.
import assert from 'node:assert/strict';
import { createDatabase as createLeanDatabase } from '@alexify/syncom';
import { sync } from '@alexify/syncom/sync';
import { createMesh, memoryEngine, settle, waitUntil } from '@alexify/syncom/testing';
// #region by-code
import { createDatabase, SyncomError } from '@alexify/syncom/all';

const board = await createDatabase({ path: 'board', schema: { entities: { Task: { unique: ['key'] } } } });

const markDone = async (id) => {
  try {
    await board.Task.update(id, { done: true });
    return 'done';
  } catch (error) {
    if (!(error instanceof SyncomError)) throw error;
    switch (error.code) {
      case 'ALX_ERR_NOT_FOUND':
        return `task ${error.id} is gone`; // deleted here, or by another node
      case 'ALX_ERR_CLOSED':
        return 'the database is closed';
      default:
        throw error;
    }
  }
};
console.log(await markDone('no-such-task')); // task no-such-task is gone
// #endregion by-code
assert.equal(await markDone('no-such-task'), 'task no-such-task is gone');

// #region locked
try {
  await createDatabase({ path: 'board' }); // the same directory, while `board` holds it
} catch (error) {
  console.log(error.code, error.path); // ALX_ERR_LOCKED board
}
// #endregion locked
await assert.rejects(createDatabase({ path: 'board' }), { name: 'SyncomError', code: 'ALX_ERR_LOCKED', path: 'board' });

// #region exists
await board.Task.insert({ id: 'write-docs', key: 'T-1', title: 'Write the docs' });
try {
  await board.Task.insert({ id: 'write-docs', key: 'T-2', title: 'Write them again' });
} catch (error) {
  console.log(error.code, error.id, error.entity); // ALX_ERR_EXISTS write-docs Task
}
// #endregion exists
await assert.rejects(board.Task.insert({ id: 'write-docs', key: 'T-2', title: 'again' }), {
  code: 'ALX_ERR_EXISTS',
  id: 'write-docs',
  entity: 'Task',
});

// #region type-error
import { ArgumentError, DataError } from '@alexify/syncom/all';

try {
  await board.Task.insert('Write the docs'); // a string, not a record
} catch (error) {
  console.log(error instanceof ArgumentError, error.code); // true ALX_ERR_INVALID_ARGUMENT: fix the call
}

const fromUser = 'my task #1'; // an id typed by a user: spaces and # are not allowed
try {
  await board.set(fromUser, { title: 'From a form' });
} catch (error) {
  console.log(error instanceof DataError, error.code); // true ALX_ERR_INVALID_ID: tell the user
}
// #endregion type-error
await assert.rejects(board.Task.insert('Write the docs'), (error) => {
  return error instanceof ArgumentError && error instanceof TypeError && error.code === 'ALX_ERR_INVALID_ARGUMENT';
});
await assert.rejects(board.set(fromUser, { title: 'x' }), { name: 'DataError', code: 'ALX_ERR_INVALID_ID' });

// #region plugin-missing
// The core alone, without the text plugin
const lean = await createLeanDatabase({ path: 'lean' });
try {
  await lean.splice('note-1', 'body', 0, 0, 'Hello');
} catch (error) {
  console.log(error.code, error.message);
  // ALX_ERR_PLUGIN_MISSING splice() needs the text plugin: createDatabase({ plugins: [text] }) from '@alexify/syncom/text'
}
// #endregion plugin-missing
await assert.rejects(lean.splice('note-1', 'body', 0, 0, 'Hello'), {
  name: 'DataError',
  code: 'ALX_ERR_PLUGIN_MISSING',
});
await lean.close();

// #region hook
const checked = await createDatabase({
  path: 'checked',
  hooks: {
    beforeWrite: ({ type, data }) => {
      if (type === 'write' && typeof data.title !== 'string') throw new Error('title is required');
    },
  },
});
try {
  await checked.insert({ done: false });
} catch (error) {
  console.log(error.name, error.code, error.hook); // HookError ALX_ERR_HOOK_FAILED beforeWrite
  console.log(error.cause.message); // title is required
}
// #endregion hook
await assert.rejects(checked.insert({ done: false }), (error) => {
  assert.equal(error.name, 'HookError');
  assert.equal(error.code, 'ALX_ERR_HOOK_FAILED');
  assert.equal(error.hook, 'beforeWrite');
  assert.equal(error.cause.message, 'title is required');
  assert.ok(error instanceof SyncomError);
  return true;
});
assert.deepEqual(await checked.list(), []);
await checked.close();

// #region validation
import { ValidationError } from '@alexify/syncom/all';

try {
  await board.Task.insert({ key: 'T-1', title: 'Same key as Write the docs' });
} catch (error) {
  if (!(error instanceof ValidationError)) throw error;
  console.log(error.entity); // Task
  console.log(error.issues);
  // [ { path: [ 'key' ], message: 'is not unique (held by write-docs)', code: 'unique', conflict: 'write-docs' } ]
}
// #endregion validation
await assert.rejects(board.Task.insert({ key: 'T-1', title: 'x' }), (error) => {
  assert.ok(error instanceof ValidationError);
  assert.equal(error.code, 'ALX_ERR_VALIDATION_FAILED');
  assert.equal(error.entity, 'Task');
  assert.deepEqual(error.issues, [
    { path: ['key'], message: 'is not unique (held by write-docs)', code: 'unique', conflict: 'write-docs' },
  ]);
  return true;
});
await board.close();

// Two nodes: the laptop runs every plugin, the phone the core and sync alone (no text plugin).
const peers = await createMesh(['laptop', 'phone'], [['phone', 'laptop']], {
  createStorage: (name, options) => {
    const own = { ...options, path: name, engine: memoryEngine(), logger: false };
    return name === 'laptop' ? createDatabase(own) : createLeanDatabase({ ...own, plugins: [sync] });
  },
});
const phone = peers.get('phone');
const refused = [];
// #region database-error
phone.on('error', (error) => {
  // A peer's op this node could not apply: logged and relayed all the same, never thrown at anyone
  console.log(error.code, error.rejected); // ALX_ERR_OP_REFUSED [ { field: 'notes', reason: 'kind', kind: 'text' } ]
});
// #endregion database-error
phone.on('error', (error) => refused.push(error));
await peers.get('laptop').splice('task-1', 'notes', 0, 0, 'Bring the charger');
await settle(peers.storages);
await waitUntil(() => refused.length > 0);
assert.equal(refused[0].code, 'ALX_ERR_OP_REFUSED');
assert.deepEqual(refused[0].rejected, [{ field: 'notes', reason: 'kind', kind: 'text' }]);
await peers.close();

// A host that refuses every peer: the laptop's sync manager hears 403.
const closed = await createMesh(['server', 'laptop'], [['laptop', 'server']], {
  createStorage: (name, options) => createDatabase({ ...options, path: name, engine: memoryEngine(), logger: false }),
  unit: { access: 'public', authorize: () => false },
});
const laptop = closed.get('laptop');
const failures = [];
// #region sync-error
laptop.sync.on('error', (error) => {
  // A failure on the way to a peer: `url` names it
  console.log(error.url, error.code, error.reason); // mem://server 403 UNAUTHORIZED
});
// #endregion sync-error
laptop.sync.on('error', (error) => failures.push(error));
await laptop.sync.stop();
await laptop.sync.start();
await waitUntil(() => failures.length > 0);
assert.equal(failures[0].url, 'mem://server');
assert.equal(failures[0].code, 403);
assert.equal(failures[0].reason, 'UNAUTHORIZED');
await closed.close();
