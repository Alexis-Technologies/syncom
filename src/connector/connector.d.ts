// The `@alexify/syncom/connector` subpath: one collection kept in step with a
// backend of its own through two handlers — `pull` (the backend's documents
// since a checkpoint) and `push` (this node's records, with what the backend
// was assumed to hold). The adapters beside it (`@alexify/syncom/connector/*`)
// write the handlers for a CouchDB, a GraphQL endpoint, a Firestore, a
// Supabase table, a MongoDB collection, an Appwrite collection, a file in
// Google Drive or OneDrive.

import type { Database, RecordData } from '../../index.js';

/** A document as a backend hands it over: the record's data, or a deletion. */
export interface ConnectorDocument<T = RecordData> {
  id: string;
  data?: T | null;
  deleted?: boolean;
}

/** What a pull answers: the documents since the checkpoint, and the position after them. */
export interface PullResult<T = RecordData, C = unknown> {
  documents: ConnectorDocument<T>[];
  checkpoint: C;
}

/** What a push hands the backend: the record as this node reads it, and what the backend was last known to hold. */
export interface PushRow<T = RecordData> {
  id: string;
  data: T | null;
  deleted: boolean;
  /** The backend's state as this node last knew it (null: none known) — what a compare-and-set backend checks against. */
  assumed: T | null;
}

export interface PullHandlers<T = RecordData, C = unknown> {
  /** The backend's documents changed since `checkpoint`, at most `batchSize`, and the checkpoint after them. */
  handler: (checkpoint: C | null, batchSize: number) => PullResult<T, C> | Promise<PullResult<T, C>>;
  /**
   * The backend's live changes: call `emit({ documents, checkpoint })` for a page, `emit('RESYNC')` to have the
   * connector pull again from its checkpoint. Returns what stops the stream. Without it a live connector pulls every
   * `retryTime` ms.
   */
  stream?: (emit: (signal: PullResult<T, C> | 'RESYNC') => void) => (() => void) | void;
}

/** A row the backend refuses by name (an id it cannot carry, a body too large): parked until a turn of the record or `reSync()`. */
export interface PushRefusal {
  id: string;
  error: { code?: string; message?: string } | Error;
}

export interface PushHandlers<T = RecordData> {
  /**
   * Rows to land on the backend; answers the ones it refused — each as the backend holds it (a conflict, `{ id,
   * data, deleted }`), or `{ id, error }` for one refused by name.
   */
  handler: (
    rows: PushRow<T>[],
  ) => (ConnectorDocument<T> | PushRefusal)[] | void | Promise<(ConnectorDocument<T> | PushRefusal)[] | void>;
}

export interface ReplicateOptions<T = RecordData, C = unknown> {
  /** Names the checkpoint in the `connector` kv namespace: letters, digits, `_ . -`. */
  name: string;
  /** The collection replicated. */
  collection: string;
  pull?: PullHandlers<T, C>;
  push?: PushHandlers<T>;
  /** Follow the backend after the initial pull (its stream, or a pull every `retryTime`); default true. */
  live?: boolean;
  /** After a handler failed (doubled per failure in a row), and between pulls without a stream, in ms; default 5 000. */
  retryTime?: number;
  /** The most a retry waits, in ms: the backoff doubles from `retryTime` up to it, with jitter; default 60 000. */
  maxRetryTime?: number;
  /** Documents asked for per pull, rows per push; default 100. */
  batchSize?: number;
  /** Reshape what comes in and what goes out. */
  modifier?: { pull?: (data: T, id: string) => T; push?: (data: T, id: string) => T };
  /**
   * A row the backend refused: what the record should be — the backend's state wins without it. Answer the data
   * to keep, `null` to delete; anything else keeps the backend's state.
   */
  resolve?: (conflict: {
    id: string;
    local: T | null;
    remote: T | null;
    deleted: boolean;
  }) => T | null | undefined | Promise<T | null | undefined>;
  /** Start at once; default true. */
  autoStart?: boolean;
}

export interface ConnectorEvents {
  /** A page of the backend's documents landed: how many came, how many changed a record. */
  received: (event: { documents: number; applied: number }) => void;
  /** A page of rows went to the backend. */
  sent: (event: { rows: number }) => void;
  /** The backend refused a row: what this node held, what the backend holds, what the record was set to. */
  conflict: (event: {
    id: string;
    local: RecordData | null;
    remote: RecordData | null;
    deleted: boolean;
    resolved: RecordData | null;
  }) => void;
  /**
   * A document or a row left out, and why: on pull `'collection'` (another collection's record), `'sealed'`,
   * `'value'` (no JSON), `'modifier'` (it threw) or the code of the write the engine refused (a validator's
   * `VALIDATION_FAILED`, a `TypeError`); on push the backend's own code for a row refused by name (`'backend'`
   * without one), `'modifier'`, `'answer'` (neither a document nor an error), `'conflict'` (a backend refusing a
   * row that assumed exactly what it holds, twice), or the code of a resolution the engine refused.
   */
  refused: (event: { direction: 'pull' | 'push'; id: string; reason: string; cause?: unknown }) => void;
  /**
   * A handler, or the landing of what it answered, failed (`REPLICATION_FAILED`, `direction` `'pull'` or `'push'`);
   * tried again after `retryIn` ms — `retryTime` doubled per failure in a row up to `maxRetryTime`, with jitter.
   */
  error: (
    error: Error & {
      code: 'REPLICATION_FAILED';
      direction: 'pull' | 'push' | null;
      name: string;
      cause?: unknown;
      retryIn: number | null;
    },
  ) => void;
  /** Started, or canceled. */
  active: (active: boolean) => void;
}

export interface ConnectorStats {
  pulled: number;
  applied: number;
  pushed: number;
  conflicts: number;
  /** Documents and rows refused by name (the `refused` event). */
  refused: number;
  pulls: number;
  pushes: number;
  pending: number;
  /** Rows the backend refused by name, set aside until a turn of theirs or `reSync()`. */
  parked: number;
  active: boolean;
  canceled: boolean;
}

export interface Replication {
  readonly name: string;
  readonly collection: string;
  readonly active: boolean;
  readonly canceled: boolean;
  /** The backend's position pulled through, and this node's log position pushed through. */
  readonly checkpoint: { pull: unknown; pushed: string | null };
  /** The handlers' failures, the newest twenty. */
  readonly errors: Error[];
  stats(): ConnectorStats;
  /** Reads the checkpoint, pulls from it and pushes what the log holds since it, then follows; resolves with the initial replication. */
  start(): Promise<void>;
  /** Stops for good. */
  cancel(): Promise<void>;
  /** Pulls again from the checkpoint and pushes what the collection holds since `pushed`. */
  reSync(): Promise<void>;
  awaitInitialReplication(options?: { signal?: AbortSignal | null }): Promise<void>;
  /** Resolves once nothing waits to go to the backend and nothing is in flight either way. */
  awaitInSync(options?: { signal?: AbortSignal | null }): Promise<void>;
  on<E extends keyof ConnectorEvents>(event: E, listener: ConnectorEvents[E]): void;
  once<E extends keyof ConnectorEvents>(event: E, listener: ConnectorEvents[E]): void;
  off<E extends keyof ConnectorEvents>(event: E, listener?: ConnectorEvents[E]): void;
  listenerCount(event: keyof ConnectorEvents): number;
  toPromise<E extends keyof ConnectorEvents>(event: E): Promise<Parameters<ConnectorEvents[E]>[0]>;
}

/** A connector over `db`: the collection kept in step with the backend the handlers speak to. */
export function replicate<T = RecordData, C = unknown>(db: Database, options: ReplicateOptions<T, C>): Replication;

export const Replication: { readonly prototype: Replication };
