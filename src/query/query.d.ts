// Queries as a plugin (@alexify/syncom/query): `open({ plugins: [query] })`
// gives every collection its `select(query)` cursor, `count(query)` and
// `watch()`; a view at a tag reads with the same cursor. The query and
// cursor types are the core's (index.d.ts) and are re-exported here; without
// the plugin `select()` and `count()` throw `PLUGIN_MISSING`.

import type { Plugin, Cursor, QueryRow, MangoQuery, MangoMatch, MangoOperators, TextIndex } from '../../index.js';

export type { Plugin, Cursor, QueryRow, MangoQuery, MangoMatch, MangoOperators, TextIndex };

/** The plugin: the cursor behind every collection's `select()`. */
export declare const query: Plugin;
