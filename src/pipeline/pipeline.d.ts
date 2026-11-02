// The `@alexify/syncom/pipeline` subpath: a handler run over every change of
// a collection, once, in order, with a checkpoint — a derived collection.

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
  /** Runs inside one transaction per turn; its writes land whole, or not at all. */
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
  readonly errors: Error[];
  /** Reads the checkpoint, replays the turns since it (or rebuilds), then follows the turns. */
  start(): Promise<void>;
  stop(): void;
  idle(): boolean;
  awaitIdle(): Promise<void>;
}

export function createPipeline(db: Database, options: PipelineOptions): Pipeline;
