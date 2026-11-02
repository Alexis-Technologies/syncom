'use strict';

// node:sqlite is experimental: Node says so once per process at the require,
// which no test or benchmark over the engine is about. Required before
// `require('node:sqlite')` — directly or through src/sqlite/sqlite.js.

process.removeAllListeners('warning');
process.on('warning', (warning) => {
  if (warning.name !== 'ExperimentalWarning') console.error(warning.stack);
});
