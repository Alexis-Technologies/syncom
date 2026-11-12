'use strict';

// The mesh is @alexify/syncom/testing's (src/testing/mesh.js). The repository's tests build their databases with a
// test context — `createStorage(t, name, options)` registers the close — so `createMesh` here takes `t` and the
// factory and hands the subpath's `createMesh` a factory of the subpath's shape; the rest is re-exported as it is.

const testing = require('../../src/testing/testing.js');

const createMesh = (t, names, edges, createStorage, options = {}) =>
  testing.createMesh(names, edges, {
    ...options,
    createStorage: (name, nodeOptions) => createStorage(t, name, nodeOptions),
  });

module.exports = {
  createMesh,
  settle: testing.settle,
  waitUntil: testing.waitUntil,
  sameVectors: testing.sameVectors,
  prng: testing.prng,
};
