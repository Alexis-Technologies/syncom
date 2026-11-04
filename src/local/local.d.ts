// The `@alexify/syncom/local` subpath: local documents — values kept beside
// the records that never become an op (not logged, not in a snapshot, never
// at a peer). `createDatabase({ plugins: [local] })` hands the core `db.local`.

import type { Plugin, LocalStore } from '../../index.js';

export type { Plugin, LocalStore };

/** The plugin: `db.local` (`get`, `set`, `delete`, `list`, `observe`, `scoped`) and the `local` event. */
export declare const local: Plugin;
