'use strict';

// Builds N storages wired by memory links from an adjacency list — `['A',
// 'B']` means A dials B — and knows when the whole thing has gone quiet.

const { MemoryLink } = require('./memory-link.js');

// What wrpc's `context.server` does for the links of one host: rooms the
// clients joined at hello, `to(room).except(client).emit(name, data)` and
// `sendTo(clientId, name, data)`.
const createServer = () => {
  const server = { links: new Set() };
  const deliver = (rooms, except, name, data) => {
    for (const link of server.links) {
      if (except !== null && link.client === except) continue;
      if (rooms !== null && !rooms.some((room) => link.client.rooms.has(room))) continue;
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

const createMesh = async (t, names, edges, createStorage, options = {}) => {
  const units = new Map();
  const links = new Map();
  const storages = new Map();
  const servers = new Map();
  const connect = (node) => {
    const [, host] = node.url.split('mem://');
    const unit = units.get(host);
    if (!unit) throw new Error(`no host ${host}`);
    let server = servers.get(host);
    if (server === undefined) servers.set(host, (server = createServer()));
    const link = new MemoryLink(unit, { ...options.link, server });
    links.set(node.url, link);
    return link;
  };
  for (const name of names) {
    const storage = await createStorage(t, name, {
      ...options.nodes?.[name],
      sync: { connect, autoStart: false, ...options.sync, ...options.nodes?.[name]?.sync },
    });
    storages.set(name, storage);
    units.set(name, storage.sync.unit(options.unit ?? { access: 'public' }));
  }
  for (const [from, to] of edges) {
    await storages.get(from).sync.addNode({ url: `mem://${to}`, scopes: options.scopes?.[from] });
  }
  for (const storage of storages.values()) await storage.sync.start();
  return { storages, links, units, servers, connect, get: (name) => storages.get(name) };
};

const sameVectors = (storages) => {
  const vectors = storages.map((storage) => storage.vector);
  const keys = new Set(vectors.flatMap((vector) => Object.keys(vector)));
  for (const key of keys) {
    // A node's bootstrap stream never reaches the node it bootstrapped from.
    if (key.endsWith('@~')) continue;
    const first = vectors[0][key] ?? 0;
    if (!vectors.every((vector) => (vector[key] ?? 0) === first)) return false;
  }
  return true;
};

// Quiet = every vector equal and nothing in flight, three polls in a row.
// "In flight" includes each storage's mutation queue: a peer's page moves the
// vector at the log append, and its record files are written after that,
// inside the same applyRemote — vectors alone say "converged" while a read
// would still find nothing (a slow CI disk showed it).
const settle = async (storages, { timeout = 5000, step = 10 } = {}) => {
  const deadline = Date.now() + timeout;
  let stable = 0;
  while (Date.now() < deadline) {
    const idle = storages.every(
      (storage) => storage.stats().queue === 0 && storage.sync.peers().every((peer) => peer.pending === 0),
    );
    if (idle && sameVectors(storages)) {
      if (++stable >= 3) return;
    } else {
      stable = 0;
    }
    await new Promise((resolve) => setTimeout(resolve, step));
  }
  const vectors = storages.map((storage) => JSON.stringify(storage.vector));
  throw new Error(`mesh did not settle within ${timeout} ms:\n${vectors.join('\n')}`);
};

const waitUntil = async (predicate, { timeout = 5000, step = 10 } = {}) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, step));
  }
  throw new Error(`condition not met within ${timeout} ms`);
};

// Deterministic pseudo-random numbers for the convergence property.
const prng = (seed) => {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
};

module.exports = { createMesh, settle, waitUntil, sameVectors, prng };
