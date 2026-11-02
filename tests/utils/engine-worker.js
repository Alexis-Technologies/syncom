'use strict';

// A worker that serves the engine in memory over its parent port: what a
// database in the main thread opens through `connectEngine(worker)`.

const { parentPort } = require('node:worker_threads');
const { memoryEngine } = require('../../src/memory/memory.js');
const { serveEngine } = require('../../src/engines/engines.js');

serveEngine(memoryEngine(), parentPort);
