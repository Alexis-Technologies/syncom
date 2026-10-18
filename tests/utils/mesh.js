'use strict';

// Builds N storages wired by memory links from an adjacency list — `['A',
// 'B']` means A dials B — and knows when the whole thing has gone quiet.

const { MemoryLink } = require('./memory-link.js');

const createMesh = async (t, names, edges, createStorage, options = {}) => {
  const units = new Map();
  const links = new Map();
  const storages = new Map();
  const connect = (node) => {
    const [, host] = node.url.split('mem://');
    const unit = units.get(host);
    if (!unit) throw new Error(`no host ${host}`);
    const link = new MemoryLink(unit, options.link);
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
  return { storages, links, units, connect, get: (name) => storages.get(name) };
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

// Quiet = every vector equal and nothing in flight, twice in a row.
const settle = async (storages, { timeout = 5000, step = 10 } = {}) => {
  const deadline = Date.now() + timeout;
  let stable = 0;
  while (Date.now() < deadline) {
    const idle = storages.every((storage) => storage.sync.peers().every((peer) => peer.pending === 0));
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
