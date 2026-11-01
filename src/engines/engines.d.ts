// The `@alexify/syncom/engines` subpath: an engine served over a message port
// and used from the other side, and a database copied between engines.

import type { Engine, EngineCapabilities } from '../../index.js';

export type { Engine, EngineCapabilities } from '../../index.js';

/** What the two sides speak over: a `MessagePort` (worker_threads, a browser), or anything with the same two members. */
export interface EnginePort {
  postMessage(message: unknown): void;
  on?(event: 'message', listener: (message: unknown) => void): unknown;
  off?(event: 'message', listener: (message: unknown) => void): unknown;
  addEventListener?(type: 'message', listener: (event: { data: unknown }) => void): void;
  removeEventListener?(type: 'message', listener: (event: { data: unknown }) => void): void;
  start?(): void;
  close?(): void;
}

/** Answers the engine contract over `port` for `engine`; `close()` stops and closes every database opened through it. */
export function serveEngine(engine: Engine, port: EnginePort): { close(): Promise<void> };

/** The engine served over `port`, as `name` and `capabilities` say it is (what the other side was given). */
export function remoteEngine(
  port: EnginePort,
  info: { name: string; capabilities: EngineCapabilities },
): Engine & { close(): Promise<void> };

/** The engine served over `port`, asked what it is first. */
export function connectEngine(port: EnginePort): Promise<Engine & { close(): Promise<void> }>;

export interface CopyEngineOptions {
  /** The database's path on both engines. */
  path: string;
  /** Records per write set; 500 by default. */
  batch?: number;
}

/** What `copyEngine` copied. */
export interface CopyEngineResult {
  records: number;
  pieces: number;
  copies: number;
  kv: number;
  entries: number;
}

/**
 * The database at `path` copied from one engine to another — records with their pieces, a tag's copies, every kv text,
 * the op log with its index — so the node opens on the new engine as itself; both databases closed, the target empty
 * (`TARGET_NOT_EMPTY` otherwise).
 */
export function copyEngine(from: Engine, to: Engine, options: CopyEngineOptions): Promise<CopyEngineResult>;
