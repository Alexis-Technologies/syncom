'use strict';

// Versions as a plugin (@alexify/syncom/versions): `open({ plugins: [versions] })`
// gives the storage its past — `get(id, { at })` and `history()` folded from
// the log (./history.js), `diff()` between two versions and `restore()` the
// way back, and the tags (`tag`, `untag`, `tags`, `at`): named versions kept
// on this node, copy-on-write at the EntryStore seam (./tags.js). The present
// and its patches — `applyPatches`, `compact` — are the core's. Without the
// plugin those methods throw PLUGIN_MISSING, `stats().tags` is null, and a
// directory that holds tags is refused at open(): its copies would not be
// kept. The hook the core takes: `versions` — `tags`, the store the write
// path copies into before a change; the methods are stubs on the facade.

const { Tags } = require('./tags.js');
const api = require('./api.js');

const versions = Object.freeze({
  name: 'versions',
  setup({ fsi, path, logger, catalogOf }) {
    return { versions: { tags: new Tags({ fsi, path, logger, catalogOf }) } };
  },
  methods: {
    getAt: api.getAt,
    diff: api.diff,
    restore: api.restore,
    tag: api.tag,
    untag: api.untag,
    tags: (core) => core.tags.list(),
    at: api.at,
    atVersion: api.atVersion,
    history: api.history,
  },
});

module.exports = { versions };
