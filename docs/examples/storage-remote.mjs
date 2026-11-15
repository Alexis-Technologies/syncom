// The Remote engine page (docs/guide/storage-remote.md) shows the regions of this file.
// tests/package/docs-examples.test.js runs it from an empty temporary directory.
import assert from 'node:assert/strict';
import { createDatabase } from '@alexify/syncom/all';
import { memoryEngine } from '@alexify/syncom/memory';

// #region serve
import { serveEngine } from '@alexify/syncom/engines';

// Two ends of one channel; in an app they live in two threads, a worker and a page, or two processes.
const { port1, port2 } = new MessageChannel();

// The side that owns the storage serves its engine on one end.
const server = serveEngine(memoryEngine(), port1, { allow: ['board'] });
// #endregion serve

// #region connect
import { connectEngine } from '@alexify/syncom/engines';

// The other side gets an engine back and opens the database through it, as through any engine.
const engine = await connectEngine(port2, { timeout: 10_000 });
const board = await createDatabase({ path: 'board', engine, schema: { entities: { Task: {} } } });

const task = await board.Task.insert({ title: 'Stored on the other side of the port' });
console.log(engine.name, await board.Task.get(task.id));
// memory { title: 'Stored on the other side of the port', $type: 'Task' }
// #endregion connect
assert.equal(engine.name, 'memory');
assert.deepEqual(await board.Task.get(task.id), { title: 'Stored on the other side of the port', $type: 'Task' });

// #region allow
await createDatabase({ path: 'other', engine }).catch((error) => console.log(error.message));
// serveEngine(): other is not served over this port
// #endregion allow
const outside = await createDatabase({ path: 'other', engine }).catch((error) => error);
assert.equal(outside.name, 'TypeError');

// #region stats
console.log(engine.stats()); // { inflight: 0, oldestMs: 0, calls: 33, failures: 2, closed: false }
// #endregion stats
assert.equal(engine.stats().inflight, 0);
assert.equal(engine.stats().closed, false);
await board.close();

// #region unreachable
port1.close(); // the serving side goes away: a worker that exits, a closed window

await createDatabase({ path: 'board', engine }).catch((error) => console.log(error.code, error.reason));
// ENGINE_UNREACHABLE closed
// #endregion unreachable
await new Promise((resolve) => setTimeout(resolve, 20));
const gone = await createDatabase({ path: 'board', engine }).catch((error) => error);
assert.equal(gone.code, 'ENGINE_UNREACHABLE');
assert.equal(gone.reason, 'closed');
assert.equal(engine.stats().closed, true);
await server.close();

// #region remote-engine
import { remoteEngine } from '@alexify/syncom/engines';

const memory = memoryEngine();
const channel = new MessageChannel();
const served = serveEngine(memory, channel.port1);

// No question asked: you started the other side, so you know what it serves.
const known = remoteEngine(channel.port2, { name: memory.name, capabilities: memory.capabilities });
// #endregion remote-engine
const again = await createDatabase({ path: 'notes', engine: known });
await again.insert({ text: 'over remoteEngine' });
await again.close();
await known.close();
await served.close();
