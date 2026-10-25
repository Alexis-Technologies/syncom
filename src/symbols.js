'use strict';

// Module-private entry points between Storage and the objects it hands out.
// A Record commits through the same path every other write takes (`COMMIT`)
// and is refreshed when the record changes underneath it (`REFRESH`); a
// Cursor reads through the storage's catalog seam (`SOURCE`); a subpath that
// folds patches (undo) or opens a fork (branch) reads the registry of
// plugins the storage runs with (`PLUGINS`); presence signs and verifies
// its updates through the node's identity (`SIGNER`: `{ id, signMessage,
// verifyMessage }` of the signing plugin, or null). Symbols keep them off
// the public surface. No requires: shared by both halves.

const COMMIT = Symbol('syncom.commit');
const REFRESH = Symbol('syncom.refresh');
const SOURCE = Symbol('syncom.source');
// The cursor factory of the query plugin: `storage[CURSOR](entity, query, source?)`.
const CURSOR = Symbol('syncom.cursor');
const PLUGINS = Symbol('syncom.plugins');
const SIGNER = Symbol('syncom.signer');

module.exports = { COMMIT, REFRESH, SOURCE, CURSOR, PLUGINS, SIGNER };
