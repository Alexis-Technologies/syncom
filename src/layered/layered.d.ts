// Layered backends (@alexify/syncom/layered): one fsi over several, a
// multi-level cache — a read is the first hit, top down, filled upward; a
// write lands on every layer in list order, through (the default) or from a
// write-back queue the top answers ahead of.

import type { Fsi } from '../../index.js';

export type { Fsi };

export interface LayeredOptions {
  /** `'through'` (default): a write resolves when the last layer has it; `'back'`: when the first has, the rest queued. */
  write?: 'through' | 'back';
  /** Copy a read that hit a lower layer into the layers above it (default `true`). */
  fill?: boolean;
  /** Under `'back'`: how many calls may wait in the queue before the next write waits for room (default 1024). */
  queue?: number;
  /** Under `'back'`: every queued call that failed, as it fails (it also fails the next `flush()`, `sync()` or `close()`). */
  onError?: (error: Error) => void;
}

export interface LayeredFsi extends Fsi {
  /** The layers, top first. */
  readonly layers: readonly Fsi[];
  /** Calls queued or running under `write: 'back'`. */
  readonly pending: number;
  /** Queued calls that failed since the backend was made; a read that waited for the queue never throws them. */
  readonly failed: number;
  /** Exclusive create: `EEXIST` when any layer has the file, else written to every layer. */
  create(dir: string, name: string, content: string): Promise<void>;
  /** Present when a layer has one: drains the queue, then syncs every layer that syncs. */
  sync?(dir: string, name: string): Promise<void>;
  /** Awaits the write-back queue; rejects with the first queued call that failed. */
  flush(): Promise<void>;
  /** Flushes, then closes every layer that has a `close()`. */
  close(): Promise<void>;
}

export declare function layered(layers: readonly Fsi[], options?: LayeredOptions): LayeredFsi;
