'use strict';

// Module-private entry points between Storage and the objects it hands out.
// A Record commits through the same path every other write takes (`COMMIT`)
// and is refreshed when the record changes underneath it (`REFRESH`); a
// Cursor reads through the storage's catalog seam (`SOURCE`). Symbols keep
// all three off the public surface. No requires: shared by both halves.

const COMMIT = Symbol('syncom.commit');
const REFRESH = Symbol('syncom.refresh');
const SOURCE = Symbol('syncom.source');

module.exports = { COMMIT, REFRESH, SOURCE };
