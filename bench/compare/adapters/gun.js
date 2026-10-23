'use strict';

/**
 * GUN: a node `todos` with a child node per record; `put` writes (a partial
 * object merges field by field, last-writer-wins by each writer's clock),
 * `once` reads. Every write waits for its acknowledgement. A batch is the
 * puts issued at once, which RAD writes together.
 *
 * Only on disk: in Node.js GUN acknowledges writes and answers reads through
 * its storage adapter, RAD, on node:fs — with `radisk: false` neither `put`
 * nor `once` ever calls back. GUN's defaults also start an AXE relay and
 * UDP multicast on the local network; both are off here, and there are no
 * peers. RAD flushes a batch on a timer (`until`, 250 ms by default), so an
 * awaited write waits for it; `once` is given `wait: 1` (it otherwise waits
 * 99 ms for peers that do not exist, and reads 0 as the default). Peers sync over GUN's WebSocket or WebRTC mesh, which has no
 * in-process transport, so the sync scenario leaves it out.
 */

const { createRequire } = require('node:module');

const local = createRequire(require.resolve('../package.json'));

const FIELDS = ['title', 'done', 'priority', 'owner', 'hits'];
const ACK_MS = 30_000;

// GUN hands back its node with `_` metadata; the record is the fields.
const plain = (node) => {
  if (!node) return null;
  const out = {};
  for (const key of FIELDS) if (key in node) out[key] = node[key];
  return out;
};

const open = async (dir) => {
  const Gun = local('gun');
  const gun = Gun({ file: dir, axe: false, multicast: false, peers: [], localStorage: false });
  const todos = gun.get('todos');
  // A batch of concurrent puts now and then never hears its acknowledgement;
  // a write that waits longer than ACK_MS fails, and bench/compare.js retries
  // the pair, instead of the run waiting for the worker's timeout.
  const put = (node, data) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no acknowledgement in ${ACK_MS} ms`)), ACK_MS);
      node.put(data, (ack) => {
        clearTimeout(timer);
        if (ack.err) reject(new Error(ack.err));
        else resolve();
      });
    });
  let next = 0;
  return {
    insert: async (record) => {
      const id = `t${next++}`;
      await put(todos.get(id), record);
      return id;
    },
    get: (id) => new Promise((resolve) => todos.get(id).once((node) => resolve(plain(node)), { wait: 1 })),
    update: (id, patch) => put(todos.get(id), patch),
    bulk: async (records) => {
      const ids = records.map(() => `t${next++}`);
      await Promise.all(records.map((record, i) => put(todos.get(ids[i]), record)));
      return ids;
    },
    close: async () => {},
  };
};

module.exports = {
  id: 'gun',
  name: 'GUN',
  package: 'gun',
  url: 'https://github.com/amark/gun',
  unsupported: { memory: 'needs its storage adapter to answer in Node.js' },
  lines: {
    disk: { variant: 'RAD on node:fs', open, noSync: 'syncs over its WebSocket/WebRTC mesh only' },
  },
};
