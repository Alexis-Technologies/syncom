// The `@alexify/syncom/pipeline` subpath: a handler run over every change of
// a collection, in order, at least once, with a checkpoint — a derived collection.

import type { Database, RecordChange, Transaction } from '../../index.js';

/** What a handler gets of one turn: the records of the source that changed, their changes (null on a replay), the turn's log position. */
export interface PipelineBatch {
  ids: string[];
  changes: RecordChange[] | null;
  /** Replayed from the log at a start, not heard live. */
  replay: boolean;
  /** Every record of the source, handed over once: no checkpoint to resume from. */
  rebuilt: boolean;
  eventId: string;
}

export interface PipelineOptions {
  name: string;
  /** The collection whose changes are handled. */
  source: string;
  /**
   * Runs inside one transaction per turn; its writes land whole, or not at all. A throw stops the pipeline
   * before the turn (the database's `error` event carries `PIPELINE_FAILED`); `start()` hands the turn over again.
   */
  handler: (batch: PipelineBatch, tx: Transaction) => unknown;
  /** Kept for a database shared by several instances (the leader runs it). */
  leader?: boolean;
}

export interface Pipeline {
  readonly name: string;
  readonly source: string;
  readonly leader: boolean;
  /** The log position handled last, or null. */
  readonly checkpoint: string | null;
  readonly rebuilt: boolean;
  /** Whether the pipeline follows nothing now: not started, stopped, or a handler that threw. */
  readonly stopped: boolean;
  /** What the handler threw, in order — the newest twenty. */
  readonly errors: Error[];
  /** Reads the checkpoint, replays the turns since it (or rebuilds), then follows the turns. */
  start(): Promise<void>;
  stop(): void;
  idle(): boolean;
  awaitIdle(): Promise<void>;
}

export function createPipeline(db: Database, options: PipelineOptions): Pipeline;
