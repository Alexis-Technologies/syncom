// The `@alexify/syncom/state` subpath: persistent app state by name, read and
// written by path — over a record (replicated, every path its own register)
// or a local document (`{ local: true }`, this node's alone).

import type { Database } from '../../index.js';

export interface StateOptions {
  /** Over the local document `state.<name>` (needs the `local` plugin) instead of the record `state.<name>`. */
  local?: boolean;
}

export interface State {
  readonly name: string;
  /** The record or local key: `state.<name>`. */
  readonly id: string;
  readonly local: boolean;
  readonly state: true;
  /** The value at `path` (`undefined` for none), or the whole object. */
  get<T = unknown>(path?: string | null): Promise<T>;
  /** Writes `value` at `path` — or `fn(current)`'s answer — and resolves to it; `set(object)` replaces the whole state. */
  set<T = unknown>(path: string | null, value: T | ((current: T | null | undefined) => T)): Promise<T>;
  set<T extends object>(value: T): Promise<T>;
  /** Removes the path, or the whole state. */
  delete(path?: string | null): Promise<void>;
  /** Calls `listener(value)` with the value at `path` after every change of it; returns the stop. */
  observe(path: string | null, listener: (value: unknown) => void): () => void;
  observe(listener: (value: unknown) => void): () => void;
}

/** The state `name` of `db`. */
export function createState(db: Database, name: string, options?: StateOptions): State;
