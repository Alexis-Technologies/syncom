'use strict';

// @alexify/syncom/testing — what a test over syncom stands on: the memory engine, an in-process link that mimics
// wrpc at the boundary with the hazards a transport has, a mesh of N databases from an adjacency list, `settle()`
// for when it has gone quiet, `waitUntil()`, `withDatabase()`. The one copy: the repository's own tests run on it
// (tests/utils/mesh.js and tests/utils/memory-link.js re-export it with their test context).

const { MemoryLink } = require('./link.js');
const { createMesh, settle, waitUntil, sameVectors, prng } = require('./mesh.js');
const { memoryEngine } = require('../memory/memory.js');

/** A database — or what opens one — for `fn`, closed after it whatever `fn` does. */
const withDatabase = async (open, fn) => {
  const db = await (typeof open === 'function' ? open() : open);
  try {
    return await fn(db);
  } finally {
    await db.close();
  }
};

module.exports = { MemoryLink, createMesh, settle, waitUntil, sameVectors, prng, withDatabase, memoryEngine };
