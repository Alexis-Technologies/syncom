// The Schema validation page (docs/guide/schema-validation.md, "Check a rule that spans two fields") shows the
// regions of this file. tests/package/docs-examples.test.js runs it from an empty temporary directory.
import assert from 'node:assert/strict';

// #region nodes
import { createDatabase } from '@alexify/syncom/all';
import { memoryEngine } from '@alexify/syncom/memory';
import { MemoryLink, settle } from '@alexify/syncom/testing';

// A server and two nodes that dial it. MemoryLink is a test stand-in for the network: an app's
// connect returns createWrpcLink(await WrpcClient.connect(node.url)) instead.
const openBoard = async (schema, unitOptions = {}) => {
  const engine = memoryEngine();
  const server = await createDatabase({ engine, path: 'server', schema, logger: false });
  const unit = server.sync.unit({ access: 'public', ...unitOptions });
  const links = {};
  const open = async (name) => {
    const sync = { connect: () => (links[name] = new MemoryLink(unit)) };
    const db = await createDatabase({ engine, path: name, schema, sync, logger: false });
    await db.sync.addNode({ url: 'mem://server' });
    await db.sync.awaitInitialReplication();
    return db;
  };
  const laptop = await open('laptop');
  const phone = await open('phone');
  return { server, laptop, phone, links, all: [server, laptop, phone] };
};

// The laptop and the phone each change one field of the same task while offline, then sync.
const editOffline = async ({ server, laptop, phone, links, all }) => {
  const task = await server.Task.insert({ title: 'Ship it', starts: 1, due: 10 });
  await settle(all);
  links.laptop.disconnect();
  links.phone.disconnect();
  await laptop.Task.update(task.id, { starts: 5 }); // 5..10 on the laptop
  await phone.Task.update(task.id, { due: 3 }); // 1..3 on the phone
  await links.laptop.reconnect();
  await settle([server, laptop]);
  await links.phone.reconnect();
  await settle(all);
  const days = [];
  for (const db of all) {
    const { starts, due } = await db.Task.get(task.id);
    days.push(`${starts}..${due}`);
  }
  return days; // as the server, the laptop and the phone read the task
};
// #endregion nodes

// #region split
// One rule over two fields, in every node's validator.
const inOrder = (task) => {
  if (task.starts > task.due) throw new Error('a task cannot start after it is due');
};
const split = await openBoard({ entities: { Task: { schema: inOrder } } });
console.log(await editOffline(split));
// [ '5..10', '5..10', '1..3' ]: the server and the laptop skipped the phone's edit, the phone skipped the laptop's
// #endregion split
for (const db of split.all) await db.close();

const refusals = [];
// #region rule
// The same rule asked once, where the writes meet. `after` is the record as the pushed op would leave it.
const authorizeWrite = ({ after }) => after === null || after.starts <= after.due;
const agreed = await openBoard({ entities: { Task: {} } }, { authorizeWrite });
agreed.phone.sync.on('error', (error) => refusals.push([error.code, error.touched]));
console.log(await editOffline(agreed));
// [ '5..10', '5..10', '5..10' ]: the server refused the phone's edit and the phone took `due` back
console.log(refusals); // [ [ 'ALX_ERR_WRITE_REFUSED', [ 'due' ] ] ]
// #endregion rule
for (const db of agreed.all) await db.close();

// What the page claims, checked on fresh boards (a run above printed it; this asserts it).
const again = await openBoard({ entities: { Task: { schema: inOrder } } });
const invalid = [];
for (const db of again.all) db.on('error', (error) => invalid.push(error.code));
assert.deepEqual(await editOffline(again), ['5..10', '5..10', '1..3']);
assert.deepEqual(
  invalid,
  ['ALX_ERR_OP_INVALID', 'ALX_ERR_OP_INVALID', 'ALX_ERR_OP_INVALID'],
  'every node skipped one op and said so',
);
for (const db of again.all) await db.close();

const ruled = await openBoard({ entities: { Task: {} } }, { authorizeWrite });
const told = [];
ruled.phone.sync.on('error', (error) => told.push([error.code, error.touched]));
assert.deepEqual(await editOffline(ruled), ['5..10', '5..10', '5..10']);
assert.deepEqual(told, [['ALX_ERR_WRITE_REFUSED', ['due']]]);
assert.deepEqual(refusals, [['ALX_ERR_WRITE_REFUSED', ['due']]]);
for (const db of ruled.all) await db.close();
