// The `@alexify/syncom/idb` subpath: IndexedDB as a storage backend
// (`createIdbFsi`, a file store) and as an engine (`idbEngine`, object
// stores), for browsers where OPFS is unavailable or unwanted. Give the
// backend to `createDatabase({ fsi })`, the engine to `createDatabase({ engine })`.

import type { Fsi, Engine } from '../../index.js';

export type { Fsi, Engine } from '../../index.js';

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

export interface IdbEngineOptions {
  /** The IndexedDB database name; default `'syncom'`. Every database opened through the engine shares it, its keys prefixed by its path. */
  name?: string;
  /** The factory; `globalThis.indexedDB` by default (a test passes its own). */
  indexedDB?: IDBFactory;
  /** The key-range constructor; `globalThis.IDBKeyRange` by default. */
  IDBKeyRange?: typeof IDBKeyRange;
  /** The transactions' durability hint; `'default'`. */
  durability?: 'default' | 'relaxed' | 'strict';
  /** The BroadcastChannel constructor another tab's writes are heard through; the global one by default, `null` for none. */
  channel?: typeof BroadcastChannel | null;
}

/** The engine over IndexedDB: object stores and key ranges, one transaction per write set, a BroadcastChannel for another tab's writes. */
export interface IdbEngine extends Engine {
  readonly name: 'idb';
  /** Closes the connection; the next call opens it again. */
  close(): Promise<void>;
  /** Deletes the whole IndexedDB database — every path's stores. */
  destroy(): Promise<void>;
}

export function idbEngine(options?: IdbEngineOptions): IdbEngine;
