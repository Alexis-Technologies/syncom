'use strict';

// Where a database keeps its bytes under its path, in ONE place: the kv
// namespaces (src/engine.js KV_NAMESPACES — the root, keys, blockchain,
// index, remote — each a directory under the files engine), the directories
// the files engine keeps beside them (the records, the log's journals and
// segments, the corrupt files kept as evidence, a tag's pending copies), and
// the two a tag adds (`tagDirs`). `engine.remove(path)` sweeps them, and
// tests/package/layout.test.js holds every module that names a namespace to
// this list — a directory a module writes that no one sweeps is a leak
// `removeDatabase()` would leave behind. Requires engine.js only.

const { KV_NAMESPACES } = require('./engine.js');

/** The directories of a database under its path, the kv namespaces first (`''` the root). */
const DIRS = Object.freeze(KV_NAMESPACES.concat(['data', 'log', 'log/open', 'log/corrupt', 'tags/.pending/data']));

/** The two directories a tag adds: its copies and its catalog. */
const tagDirs = (tag) => [`tags/${tag}/data`, `tags/${tag}/index`];

module.exports = { DIRS, tagDirs };
