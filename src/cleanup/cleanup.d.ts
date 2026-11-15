// The `@alexify/syncom/cleanup` subpath: an old, acknowledged tombstone folded
// whole into the `tombstones` kv namespace, its file removed in the same write set.

import type { Database } from '../../index.js';
import type { LeaderHandle } from '../pipeline/pipeline.js';

export type { LeaderHandle };

export interface CleanupOptions {
  /** How long a record must have been deleted (by its row's stamp) before its tombstone is folded; 31 days. */
  minimumDeletedTime?: number;
  /** How often `start()` runs a sweep, in ms; 5 minutes. */
  runEach?: number;
  /** Fold a tombstone whose delete this node made only once every enabled registered node acknowledged it, and never drop one the log no longer retains; true. */
  awaitSync?: boolean;
  /**
   * What `openShared()` answers, its `db` the database given: `run()` sweeps the instance that leads (nothing where
   * this one follows, all counts zero) and `start()`'s timer runs while this instance leads, armed again on the one a
   * failover makes the leader. Without it, on `db`.
   */
  leader?: LeaderHandle;
  /** The clock; `Date.now`. */
  now?: () => number;
}

export interface CleanupCounts {
  folded: number;
  dropped: number;
  skipped: number;
}

export interface Cleanup {
  readonly stats: CleanupCounts & { runs: number };
  /** One sweep; `drop: true` takes the folded tombstones' entries and rows away too (a late op then makes a new record). */
  run(options?: { drop?: boolean }): Promise<CleanupCounts>;
  start(): void;
  stop(): void;
}

export function cleanup(db: Database, options?: CleanupOptions): Cleanup;
export const MINIMUM_DELETED_TIME: number;
