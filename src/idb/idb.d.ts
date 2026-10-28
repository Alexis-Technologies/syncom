// The `@alexify/syncom/idb` subpath: the storage backend over IndexedDB, for
// browsers where OPFS is unavailable or unwanted. Give its result to
// `open({ fsi })`.

import type { Fsi } from '../../index.js';

export type { Fsi } from '../../index.js';

export interface IdbFsiOptions {
  /** The database name; default `'syncom'`. */
  name?: string;
  /** The object store; default `'files'`. */
  store?: string;
  /** The factory; `globalThis.indexedDB` by default (a test passes its own). */
  indexedDB?: IDBFactory;
}

/**
 * One object store keyed by `[dir, name]` with an index on `dir`; opened
 * lazily, reopened after the browser closes it, closed by `close()`. A
 * write resolves once its transaction completed.
 */
export function createIdbFsi(options?: IdbFsiOptions): Fsi & { close(): Promise<void> };
