// The SharedWorker page (docs/guide/storage-shared-worker.md) shows the regions of this file: the worker and two
// tabs of docs/examples/storage-shared-worker-browser.mjs, run in one Node.js process over MessageChannels and the
// memory engine (a browser uses the IndexedDB engine on both sides).
// tests/package/docs-examples.test.js runs it from an empty temporary directory.
import assert from 'node:assert/strict';
import { createDatabase } from '@alexify/syncom/all';
import { memoryEngine } from '@alexify/syncom/memory';
import { openShared } from '@alexify/syncom/shared';

// #region channel
// port-channel.js: a tab's writes to the worker over a MessagePort, as plain values both ways.
export const servePort = (port, procedures) => {
  port.addEventListener('message', async ({ data: { id, method, call } }) => {
    const answer = await procedures[method].handler(null, call); // { ok, value } or { ok, error }
    port.postMessage({ id, answer });
  });
  port.start();
};

export const portChannel = (port) => {
  const waiting = new Map();
  let next = 0;
  port.addEventListener('message', ({ data: { id, answer } }) => {
    waiting.get(id)?.(answer);
    waiting.delete(id);
  });
  port.start();
  return {
    call: (method, call) =>
      new Promise((resolve) => {
        const id = ++next;
        waiting.set(id, resolve);
        port.postMessage({ id, method, call });
      }),
    close: () => port.close(),
  };
};
// #endregion channel

const schema = { entities: { Task: {} } };
const engine = memoryEngine(); // one store every instance opens, as one IndexedDB is in a browser
const ports = []; // what this stand-in closes at the end

// The worker's side: the leader, and a handler for every tab that connects.
// #region worker
const shared = await openShared({ createDatabase, engine, path: 'board', schema });
const procedures = shared.serve(); // the leader's writers, as procedures a follower calls

const onConnect = (tabPort) => {
  // Every connection brings a fresh port to answer on (a tab dials again after a failover).
  tabPort.addEventListener('message', ({ data }) => servePort(data.port, procedures));
  tabPort.start();
};
// #endregion worker

// What `new SharedWorker(url).port` is in a tab: a port whose other end the worker's onConnect gets.
const sharedWorkerPort = () => {
  const { port1, port2 } = new MessageChannel();
  onConnect(port1);
  ports.push(port1, port2);
  return port2;
};

// #region tab
const workerPort = sharedWorkerPort(); // in a browser: new SharedWorker(url, { type: 'module' }).port

const tab = await openShared({
  createDatabase,
  engine,
  path: 'board',
  schema,
  election: { follower: true }, // a tab never leads: the worker does
  channel: () => {
    const { port1, port2 } = new MessageChannel();
    workerPort.postMessage({ port: port2 }, [port2]);
    return portChannel(port1);
  },
});
// #endregion tab
const other = await openShared({
  createDatabase,
  engine,
  path: 'board',
  schema,
  election: { follower: true },
  channel: () => {
    const { port1, port2 } = new MessageChannel();
    sharedWorkerPort().postMessage({ port: port2 }, [port2]);
    return portChannel(port1);
  },
});
assert.equal(shared.leader, true);
assert.deepEqual([tab.leader, tab.mode], [false, 'follower']);

// #region use
const tasks = tab.collection('Task');
const stop = tasks.select({}).watch((rows) => console.log('tasks in this tab:', rows.length));
// tasks in this tab: 0

const id = await tasks.insert({ title: 'Written in a tab' }); // carried to the worker, written there
console.log(await shared.get(id)); // { title: 'Written in a tab', $type: 'Task' }   the worker has it
// tasks in this tab: 1   the tab hears the write through the store it reads
// #endregion use
assert.deepEqual(await shared.get(id), { title: 'Written in a tab', $type: 'Task' });
const landed = async (instance) => {
  for (let i = 0; i < 100 && (await instance.get(id)) === null; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return instance.get(id);
};
assert.deepEqual(await landed(tab), { title: 'Written in a tab', $type: 'Task' });
assert.deepEqual(await landed(other), { title: 'Written in a tab', $type: 'Task' }, 'every tab reads it');
await assert.rejects(() => tab.collection('Task').update('missing', { done: true }), { code: 'NOT_FOUND' });
await assert.rejects(async () => tab.sync, { code: 'NOT_LEADER' });

stop();
await other.close();
await tab.close();
await shared.close();
for (const port of ports) port.close();
