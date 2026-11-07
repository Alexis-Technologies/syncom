'use strict';

// N databases wired by memory links from an adjacency list — `['A', 'B']` means A dials B — and the means to know
// when the whole thing has gone quiet. The databases are the caller's (`createStorage(name, options)`: a memory
// engine, a temp directory, the plugins under test); the links and the hosts' rooms are made here.

const { MemoryLink } = require('./link.js');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// An array as it is; a Map's values or any iterable as one.
const listOf = (storages) => {
  if (Array.isArray(storages)) return storages;
  const list = [];
  for (const storage of storages instanceof Map ? storages.values() : storages) list.push(storage);
  return list;
};

// What wrpc's `context.server` does for the links of one host: rooms the clients joined at hello,
// `to(room).except(client).emit(name, data)` and `sendTo(clientId, name, data)`.
const createServer = () => {
  const server = { links: new Set() };
  const inRooms = (client, rooms) => {
    for (let i = 0; i < rooms.length; i++) if (client.rooms.has(rooms[i])) return true;
    return false;
  };
  const deliver = (rooms, except, name, data) => {
    for (const link of server.links) {
      if (except !== null && link.client === except) continue;
      if (rooms !== null && !inRooms(link.client, rooms)) continue;
      link.deliver(name, data);
    }
  };
  const target = (rooms, except) => ({
    to: (...more) => target([...(rooms ?? []), ...more], except),
    except: (client) => target(rooms, client),
    emit: (name, data) => void deliver(rooms, except, name, data),
  });
  server.to = (...rooms) => target(rooms, null);
  server.except = (client) => target(null, client);
  server.sendTo = (clientId, name, data) => {
    for (const link of server.links) if (link.client.id === clientId) link.deliver(name, data);
  };
  return server;
};

/**
 * The mesh: a database per name through `createStorage(name, options)` — `options` carries `sync.connect` to the
 * links, `autoStart: false`, what `nodes[name]` says for that one and `sync` for every one — each hosting a unit
 * (`unit`, public by default), every edge an `addNode('mem://<to>')` with the dialer's `scopes`, then every manager
 * started. `link` is every link's hazards (latency, drop, duplicate).
 */
const createMesh = async (names, edges, options = {}) => {
  const { createStorage, link: hazards, sync, nodes, unit, scopes } = options;
  if (typeof createStorage !== 'function') throw new TypeError('createMesh() takes createStorage(name, options)');
  const units = new Map();
  const links = new Map();
  const storages = new Map();
  const servers = new Map();
  const connect = (node) => {
    const [, host] = node.url.split('mem://');
    const hosted = units.get(host);
    if (!hosted) throw new TypeError(`createMesh(): no host ${host}`);
    let server = servers.get(host);
    if (server === undefined) servers.set(host, (server = createServer()));
    const link = new MemoryLink(hosted, { ...hazards, server });
    links.set(node.url, link);
    return link;
  };
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    const own = nodes?.[name];
    const storage = await createStorage(name, { ...own, sync: { connect, autoStart: false, ...sync, ...own?.sync } });
    storages.set(name, storage);
    units.set(name, storage.sync.unit(unit ?? { access: 'public' }));
  }
  for (let i = 0; i < edges.length; i++) {
    const [from, to] = edges[i];
    await storages.get(from).sync.addNode({ url: `mem://${to}`, scopes: scopes?.[from] });
  }
  for (const storage of storages.values()) await storage.sync.start();
  const close = async () => {
    for (const storage of storages.values()) await storage.close();
  };
  return { storages, links, units, servers, connect, get: (name) => storages.get(name), close };
};

/** Whether every database's vector is the same — a node's bootstrap stream (`@~`) never reaches the node it came from. */
const sameVectors = (storages) => {
  const list = listOf(storages);
  const vectors = [];
  for (let i = 0; i < list.length; i++) vectors.push(list[i].vector);
  const keys = new Set();
  for (let i = 0; i < vectors.length; i++) for (const key of Object.keys(vectors[i])) keys.add(key);
  for (const key of keys) {
    if (key.endsWith('@~')) continue;
    const first = vectors[0][key] ?? 0;
    for (let i = 1; i < vectors.length; i++) if ((vectors[i][key] ?? 0) !== first) return false;
  }
  return true;
};

// Nothing in flight: no database's queue holds a turn, no peer has a page pending. A peer's page moves the vector at
// the log append and lands its records after that, inside the same applyRemote — vectors alone say "converged" while
// a read would still find nothing (a slow CI disk showed it).
const idle = (list) => {
  for (let i = 0; i < list.length; i++) {
    const storage = list[i];
    if (storage.stats().queue !== 0) return false;
    const peers = storage.sync.peers();
    for (let j = 0; j < peers.length; j++) if (peers[j].pending !== 0) return false;
  }
  return true;
};

/** Resolves once every vector is equal and nothing is in flight, three polls in a row; rejects past `timeout`. */
const settle = async (storages, { timeout = 5000, step = 10 } = {}) => {
  const list = listOf(storages);
  const deadline = Date.now() + timeout;
  let stable = 0;
  while (Date.now() < deadline) {
    if (idle(list) && sameVectors(list)) {
      if (++stable >= 3) return;
    } else {
      stable = 0;
    }
    await sleep(step);
  }
  const vectors = [];
  for (let i = 0; i < list.length; i++) vectors.push(JSON.stringify(list[i].vector));
  throw new Error(`mesh did not settle within ${timeout} ms:\n${vectors.join('\n')}`);
};

/** Resolves once `predicate()` (a value or a promise) is true, polled every `step` ms; rejects past `timeout`. */
const waitUntil = async (predicate, { timeout = 5000, step = 10 } = {}) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(step);
  }
  throw new Error(`condition not met within ${timeout} ms`);
};

/** Deterministic pseudo-random numbers in [0, 1) — a linear congruential generator over `seed`. */
const prng = (seed) => {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
};

module.exports = { createMesh, settle, waitUntil, sameVectors, prng };
