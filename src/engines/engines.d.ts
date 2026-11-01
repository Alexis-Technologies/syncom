// The `@alexify/syncom/engines` subpath: an engine served over a message port
// and used from the other side, and a database copied between engines.

import type { Engine, EngineCapabilities } from '../../index.js';

export type { Engine, EngineCapabilities } from '../../index.js';

/** What the two sides speak over: a `MessagePort` (worker_threads, a browser), or anything with the same two members. */
export interface EnginePort {
  postMessage(message: unknown): void;
  on?(event: string, listener: (...args: unknown[]) => void): unknown;
  off?(event: string, listener: (...args: unknown[]) => void): unknown;
  addEventListener?(type: string, listener: (event: { data: unknown }) => void): void;
  removeEventListener?(type: string, listener: (event: { data: unknown }) => void): void;
  start?(): void;
  close?(): void;
}

export interface ServeEngineOptions {
  /** The paths this port may open and remove; without it a port opens any path and removes only what it opened. */
  allow?: string[];
}

/**
 * Answers the engine contract over `port` for `engine`; `close()` stops and closes every database opened through it.
 * The served side trusts the port as it trusts the process: every call names a store and a method of the contract,
 * every key, id, tag and path is checked before a store sees it, and `remove(path)` takes what the port opened.
 */
export function serveEngine(engine: Engine, port: EnginePort, options?: ServeEngineOptions): { close(): Promise<void> };

export interface RemoteEngineOptions {
  name: string;
  capabilities: EngineCapabilities;
  /** A call waiting longer than this many ms fails as `ENGINE_UNREACHABLE` (`reason: 'timeout'`); 0, the default, waits. */
  timeout?: number;
}

/** The calls over a port: in flight now, the oldest of them in ms, made and failed since the start, and whether the port is gone. */
export interface RemoteEngineStats {
  inflight: number;
  oldestMs: number;
  calls: number;
  failures: number;
  closed: boolean;
}

export type RemoteEngine = Engine & { close(): Promise<void>; stats(): RemoteEngineStats };

/**
 * The engine served over `port`, as `name` and `capabilities` say it is (what the other side was given). A port that
 * closes or a worker that exits fails every call waiting and every call after as `ENGINE_UNREACHABLE`.
 */
export function remoteEngine(port: EnginePort, options: RemoteEngineOptions): RemoteEngine;

/** The engine served over `port`, asked what it is first. */
export function connectEngine(port: EnginePort, options?: { timeout?: number }): Promise<RemoteEngine>;

export interface CopyEngineOptions {
  /** The database's path on both engines. */
  path: string;
  /** Records, or log entries, per write set; 500 by default. */
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
 * the op log with its index — so the node opens on the new engine as itself; both databases closed and held for the
 * copy, the target empty (`TARGET_NOT_EMPTY` otherwise). The identity lands last, and a copy that fails takes what it
 * wrote away again (a lease lost on the way is `LEASE_LOST`).
 */
export function copyEngine(from: Engine, to: Engine, options: CopyEngineOptions): Promise<CopyEngineResult>;
