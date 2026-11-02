// The `@alexify/syncom/cleanup` subpath: a tombstone's file folded into its
// catalog row once it is old and acknowledged.

import type { Database } from '../../index.js';

export interface CleanupOptions {
  /** How long a record must have been deleted before its tombstone is folded; 31 days. */
  minimumDeletedTime?: number;
  /** How often `start()` runs a sweep, in ms; 5 minutes. */
  runEach?: number;
  /** Fold only a tombstone whose delete this node made once every enabled registered node acknowledged it; true. */
  awaitSync?: boolean;
  /** Kept for a database shared by several instances (the leader runs it). */
  leader?: boolean;
  /** The clock; `Date.now`. */
  now?: () => number;
}

export interface CleanupCounts {
  folded: number;
  dropped: number;
  skipped: number;
}

export interface Cleanup {
  readonly leader: boolean;
  readonly stats: CleanupCounts & { runs: number };
  /** One sweep; `drop: true` takes the folded rows away too (a late op then makes a new record). */
  run(options?: { drop?: boolean }): Promise<CleanupCounts>;
  start(): void;
  stop(): void;
}

export function cleanup(db: Database, options?: CleanupOptions): Cleanup;
export const MINIMUM_DELETED_TIME: number;
