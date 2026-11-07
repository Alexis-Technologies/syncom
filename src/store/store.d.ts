// The `@alexify/syncom/store` subpath: a source of syncom's as one store
// both Svelte's contract and React's useSyncExternalStore read — and Vue
// and Solid wrap (docs/guide/frameworks.md). No framework is imported.

import type { Cursor, SyncomDocument, Database, RecordData } from '../../index.js';
import type { Presence } from '../presence/presence.js';

/**
 * A value that changes. `subscribe(run)` calls `run(value)` at once and on
 * every change and returns the stop function (Svelte's contract);
 * `getSnapshot()` keeps its identity until a change (React's
 * `useSyncExternalStore`). The source is watched from the first subscriber
 * to the last; without one the store answers the last value it saw.
 */
export interface SyncomStore<T> {
  subscribe(run: (value: T) => void): () => void;
  getSnapshot(): T;
  readonly value: T;
  /** The last failure of the source, cleared by the next value. */
  readonly error: Error | null;
  /** Resolves with the first value the source gives. */
  readonly ready: Promise<T>;
}

export interface StoreOptions<T> {
  /** What the store holds before the source gave anything; `undefined` by default. */
  initial?: T;
  /** A failure of the source: a query that threw, a read that rejected. */
  onError?: (error: Error) => void;
}

/** A query's rows, as `watch()` gives them. */
export declare function toStore<T>(cursor: Cursor<T>, options?: StoreOptions<T[]>): SyncomStore<T[] | undefined>;
/** A presence room's states, by node. */
export declare function toStore(
  presence: Presence,
  options?: StoreOptions<Map<string, Record<string, unknown>>>,
): SyncomStore<Map<string, Record<string, unknown>>>;
/** A live Record's data — a copy per change; `null` once deleted. */
export declare function toStore<R>(
  record: SyncomDocument<R>,
  options?: StoreOptions<R | null>,
): SyncomStore<R | null | undefined>;
/** A record as `get()` reads it — or the field at `path` — read again after every turn that changed it. */
export declare function toStore<R = RecordData>(
  storage: Database,
  id: string,
  options?: StoreOptions<R | null> & { path?: string },
): SyncomStore<R | null | undefined>;

/** A store over any emitter: `read()` (a value or a promise of one) at the start and after each of `events`. */
export declare function fromEvents<T>(
  emitter: {
    on(event: string, listener: (...args: any[]) => void): unknown;
    off(event: string, listener: (...args: any[]) => void): unknown;
  },
  events: readonly string[],
  read: () => T | Promise<T>,
  options?: StoreOptions<T>,
): SyncomStore<T | undefined>;

/** An observer as RxJS and Angular subscribe: `next` per value; `error` and `complete` are never called (a live source). */
export interface StoreObserver<T> {
  next?: (value: T) => void;
  error?: (error: unknown) => void;
  complete?: () => void;
}

export interface StoreSubscription {
  readonly closed: boolean;
  unsubscribe(): void;
}

/**
 * An interop Observable over a store: `subscribe(observer | next)`, and itself at `Symbol.observable` — spelled
 * `'@@observable'` where no library defined the symbol — so RxJS's `from()`, Angular's `async` pipe and `toSignal()`
 * take it as an Observable.
 */
export interface StoreObservable<T> {
  subscribe(observer: StoreObserver<T> | ((value: T) => void)): StoreSubscription;
  '@@observable'(): StoreObservable<T>;
}

/** A store as an interop Observable; never errors or completes, `unsubscribe()` lets the store go. */
export declare function toObservable<T>(store: SyncomStore<T>): StoreObservable<T>;
