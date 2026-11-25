'use strict';

// node:sqlite is experimental: Node says so once per process at the require,
// which no test or benchmark over the engine is about. Required before
// `require('node:sqlite')` — directly or through src/sqlite/sqlite.js.

process.removeAllListeners('warning');
process.on('warning', (warning) => {
  // Every other warning is still printed, as Node would have printed it.
  // oxlint-disable-next-line no-console
  if (warning.name !== 'ExperimentalWarning') console.error(warning.stack);
});
