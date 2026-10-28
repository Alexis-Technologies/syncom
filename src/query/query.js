'use strict';

// Queries as a plugin (@alexify/syncom/query): `open({ plugins: [query] })`
// gives every collection its `select(query)` — the cursor of ./cursor.js,
// a Mango-style predicate compiled once and planned against the catalog —
// `count(query)`, and `watch()` on the cursor; a view at a tag reads with
// the same cursor. The catalog, its indexes and the text index behind
// `$text` (`open({ search })`) are the core's: what a query reads is kept
// whether or not anything queries it. Without the plugin `select()` and
// `count()` throw PLUGIN_MISSING. The hook the core takes: `query` —
// `cursor(source, entity, query)`, the cursor over a source seam.

const { Cursor } = require('./cursor.js');

const query = Object.freeze({
  name: 'query',
  setup() {
    return { query: { cursor: (source, entity, criteria) => new Cursor(source, entity, criteria) } };
  },
});

module.exports = { query };
