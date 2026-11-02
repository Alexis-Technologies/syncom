'use strict';

// @alexify/syncom/engines — what is done with engines rather than by one:
// an engine served over a message port and used from the other side
// (serveEngine, remoteEngine, connectEngine — ./remote.js), and a database
// copied from one engine to another (copyEngine — ./copy.js). The contract
// itself is the core's (src/engine.js: isEngine, the files engine on the
// root); the engines ship on their own subpaths (/memory, /idb, /sqlite,
// /mongodb). Requires remote.js and copy.js only.

const { serveEngine, remoteEngine, connectEngine } = require('./remote.js');
const { copyEngine } = require('./copy.js');

module.exports = { serveEngine, remoteEngine, connectEngine, copyEngine };
