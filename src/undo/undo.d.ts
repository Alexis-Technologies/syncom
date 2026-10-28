// The `@alexify/syncom/undo` subpath: undo and redo for one node's own
// writes, fed by the storage's `commit` events, applied as new ops through
// `applyPatches()` so an undo merges like any write. Platform-neutral.

import type { Storage, SyncOp } from '../../index.js';

export interface UndoOptions {
  /** Commits within this many ms of a step's first merge into it; 500 by default. A transaction's commits are one step whatever the interval. */
  mergeInterval?: number;
  /** How many steps are kept; 100 by default. */
  limit?: number;
  /** Keep to ops of this scope (`'*'` the global one). */
  scope?: string;
  /** Ops to leave out of the stack. */
  exclude?: (op: SyncOp) => boolean;
  /** Who the undo's ops say made them. */
  actor?: string;
  /** Keep to commits whose `source` (a transaction's, a Record's save) is one of these. */
  trackedSources?: Iterable<unknown>;
  /** Keep to these records — ids, or a predicate on the id. */
  records?: Iterable<string> | ((id: string) => boolean);
  /** Keep to these fields and what hangs under them; a whole-record change is then not tracked. */
  paths?: readonly string[];
  /** The `push` listener. */
  onPush?: (event: UndoPushEvent) => void;
  /** The `pop` listener. */
  onPop?: (event: UndoPopEvent) => void;
}

/** What a step shows of itself: `meta` is the application's object (the same one on every event of the step and of its redo). */
export interface UndoStep {
  id: number;
  meta: Record<string, unknown>;
  /** The records the step touched. */
  records: string[];
  /** The stamp of its first commit. */
  at: number;
  /** The `source` of its first commit, and its message. */
  source: unknown;
  message: string | null;
  /** The transaction its first commit was made in, or null. */
  txn: number | null;
}

export interface UndoPushEvent {
  direction: 'undo';
  records: number;
  step: UndoStep;
}

export interface UndoPopEvent {
  direction: 'undo' | 'redo';
  applied: number;
  skipped: number;
  /** The step taken back (an undo) or done again (a redo). */
  step: UndoStep;
}

export interface UndoResult {
  /** Ops the undo or redo made. */
  applied: number;
  /** Patches left alone: a field someone else changed since, or a whole-record step with such a conflict. */
  skipped: number;
}

export interface UndoManagerEvents {
  /** A commit joined the stack: the step it joined. */
  push: (event: UndoPushEvent) => void;
  /** An undo or a redo is done: the step it took back or did again. */
  pop: (event: UndoPopEvent) => void;
  change: () => void;
}

export declare class UndoManager {
  on<E extends keyof UndoManagerEvents>(event: E, listener: UndoManagerEvents[E]): void;
  once<E extends keyof UndoManagerEvents>(event: E, listener: UndoManagerEvents[E]): void;
  off<E extends keyof UndoManagerEvents>(event: E, listener?: UndoManagerEvents[E]): void;
  listenerCount(event: keyof UndoManagerEvents): number;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  /** How many steps each way. */
  readonly size: { undo: number; redo: number };
  /** Takes the newest step back. A field anyone else changed since is left alone unless `force`. */
  undo(options?: { force?: boolean }): Promise<UndoResult>;
  /** Does the last undone step again. */
  redo(options?: { force?: boolean }): Promise<UndoResult>;
  /** Closes the current step: the next commit starts a new one. */
  mark(): void;
  /** Everything committed while `fn` runs is one step, whatever the interval; resolves to what `fn` returned. */
  group<T>(fn: () => T | Promise<T>): Promise<T>;
  /** Opens a group: the next commits are one step until `groupEnd()`. */
  groupStart(): void;
  /** Closes the group `groupStart()` opened; the outermost close ends the step. */
  groupEnd(): void;
  /** The steps each way, newest last. */
  readonly steps: { undo: UndoStep[]; redo: UndoStep[] };
  clear(): void;
  /** Stops listening, drops the stacks and lets the log compact. */
  stop(): void;
}

/** An undo manager over `storage`'s own writes; stops itself when the storage closes. */
export function createUndo(storage: Storage, options?: UndoOptions): UndoManager;
