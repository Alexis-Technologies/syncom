// The Fields that merge page (docs/guide/fields.md) shows the regions of this file: two nodes that edit one task
// while they cannot reach each other. tests/package/docs-examples.test.js runs it from an empty temporary directory.
import assert from 'node:assert/strict';
import { createDatabase } from '@alexify/syncom/all';
import { createMesh, settle, memoryEngine } from '@alexify/syncom/testing';

// Two nodes linked in memory: the phone dials the laptop.
const mesh = await createMesh(['laptop', 'phone'], [['phone', 'laptop']], {
  createStorage: (name, options) =>
    createDatabase({
      engine: memoryEngine(),
      path: name,
      logger: false,
      schema: { entities: { Task: {} } },
      ...options,
    }),
});
const laptop = mesh.get('laptop');
const phone = mesh.get('phone');

const task = await laptop.Task.insert({ title: 'Write the docs', done: false });
await laptop.add(task.id, 'tags', ['docs']);
await settle([laptop, phone]);
const link = mesh.links.get('mem://laptop'); // the phone's connection to the laptop

// #region offline
link.disconnect(); // the two nodes cannot reach each other

await laptop.Task.update(task.id, { title: 'Write the user guide' }); // a register
await phone.Task.update(task.id, { done: true }); // another register of the same task
await laptop.inc(task.id, 'votes', 1); // both vote: a counter
await phone.inc(task.id, 'votes', 1);
await laptop.add(task.id, 'tags', ['writing']); // both tag: a set
await phone.add(task.id, 'tags', ['urgent']);
await laptop.Task.update(task.id, { 'assignee/name': 'ada' }); // two paths under one prefix
await phone.Task.update(task.id, { 'assignee/team': 'core' });

await link.reconnect(); // back online: each node receives what the other did
// #endregion offline
await settle([laptop, phone]);

// #region merged
console.log(await laptop.Task.get(task.id));
// { title: 'Write the user guide', done: true, $type: 'Task', tags: [ 'docs', 'urgent', 'writing' ],
//   votes: 2, assignee: { name: 'ada', team: 'core' } }
console.log(await phone.Task.get(task.id)); // the same, field for field
// #endregion merged
const expected = {
  title: 'Write the user guide',
  done: true,
  $type: 'Task',
  tags: ['docs', 'urgent', 'writing'],
  votes: 2,
  assignee: { name: 'ada', team: 'core' },
};
assert.deepEqual(await laptop.Task.get(task.id), expected);
assert.deepEqual(await phone.Task.get(task.id), expected);

// #region same-field
link.disconnect();
await laptop.Task.update(task.id, { title: 'Draft the guide' });
await new Promise((resolve) => setTimeout(resolve, 5)); // a moment later, on the other device
await phone.Task.update(task.id, { title: 'Publish the guide' });
await link.reconnect();
// #endregion same-field
await settle([laptop, phone]);
const titles = [(await laptop.Task.get(task.id)).title, (await phone.Task.get(task.id)).title];
console.log(titles); // [ 'Publish the guide', 'Publish the guide' ]: the later write, on both
assert.deepEqual(titles, ['Publish the guide', 'Publish the guide']);
await mesh.close();
