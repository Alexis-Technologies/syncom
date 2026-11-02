'use strict';

// Queries as a plugin (@alexify/syncom/query): `createDatabase({ plugins: [query] })`
// gives every collection its `select(query)` — the cursor of ./cursor.js,
// a Mango-style predicate compiled once and planned against the catalog —
// `count(query)`, and `watch()` on the cursor; a view at a tag reads with
// the same cursor. The catalog, its indexes and the text index behind
// `$text` (`createDatabase({ search })`) are the core's: what a query reads is kept
// whether or not anything queries it. Without the plugin `select()` and
// `count()` throw PLUGIN_MISSING, and so does `update(id, delta, { ifMatch })`.
// The hook the core takes: `query` — `cursor(source, entity, query)`, the
// cursor over a source seam, and `matches(query)`, the query as a predicate
// over `{ id, ...record }` (what `ifMatch` is decided by).

const { Cursor, compileQuery } = require('./cursor.js');

const query = Object.freeze({
  name: 'query',
  setup() {
    return {
      query: {
        cursor: (source, entity, criteria) => new Cursor(source, entity, criteria),
        matches: (criteria) => compileQuery(criteria),
      },
    };
  },
});

module.exports = { query };
