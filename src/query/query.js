'use strict';

// Queries as a plugin (@alexify/syncom/query): `createDatabase({ plugins: [query] })`
// gives every collection its `select(query)` — the cursor of ./cursor.js,
// a Mango-style predicate compiled once and planned against the catalog —
// `count(query)`, and `watch()` on the cursor; a view at a tag reads with
// the same cursor. The catalog, its indexes and the text index behind
// `$text` (`createDatabase({ search })`) are the core's: what a query reads is kept
// whether or not anything queries it. Without the plugin `select()` and
// `count()` throw PLUGIN_MISSING, and so does `update(id, delta, { ifMatch })`.
// The hook the core takes: `query` — `cursor(source, entity, query, { sealed })`, the
// cursor over a source seam (the collection's sealed records read where `sealed`, left
// out otherwise), and `matches(query)`, the query as a predicate over `{ id, ...record }`
// (what `ifMatch` is decided by).

const { Cursor, compileQuery } = require('./cursor.js');
const { QueryCache } = require('./cache.js');

const query = Object.freeze({
  name: 'query',
  setup() {
    // One cache per database (./cache.js): the results by key, the live run every `watch()` of a
    // key shares. A source that does not move (a tag's, without `generation`) is read every time.
    const cache = new QueryCache();
    return {
      query: {
        cursor: (source, entity, criteria, { sealed = false } = {}) =>
          new Cursor(source, entity, criteria, null, typeof source.generation === 'function' ? cache : null, sealed),
        matches: (criteria) => compileQuery(criteria),
        // What `stats().query` answers: the cache's entries and the rows they hold, the live runs kept.
        stats: () => ({ cache: { entries: cache.size, rows: cache.held }, live: cache.living }),
      },
    };
  },
});

/**
 * A Mango query as a predicate over a record's data (`{ id, ...data }`, or
 * the data alone): what a cursor matches by, for a document in hand. A
 * malformed query is a TypeError here.
 */
const matches = (criteria) => {
  const test = compileQuery(criteria);
  return (doc) => {
    if (typeof doc !== 'object' || doc === null) throw new TypeError('matches() takes an object');
    return test(doc);
  };
};

module.exports = { query, matches };
