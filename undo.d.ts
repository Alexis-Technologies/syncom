// The `@alexify/syncom/undo` subpath: undo and redo for one node's own
// writes, fed by the storage's `commit` events, applied as new ops through
// `applyPatches()` so an undo merges like any write. Platform-neutral.

import type { Storage, SyncOp } from './index.js';

export interface UndoOptions {
  /** Commits within this many ms of a step's first merge into it; 500 by default. */
  mergeInterval?: number;
  /** How many steps are kept; 100 by default. */
  limit?: number;
  /** Keep to ops of this scope (`'*'` the global one). */
  scope?: string;
  /** Ops to leave out of the stack. */
  exclude?: (op: SyncOp) => boolean;
  /** Who the undo's ops say made them. */
  actor?: string;
}

export interface UndoResult {
  /** Ops the undo or redo made. */
  applied: number;
  /** Patches left alone: a field someone else changed since, or a whole-record step with such a conflict. */
  skipped: number;
}

export interface UndoManagerEvents {
  push: (event: { direction: 'undo'; records: number }) => void;
  pop: (event: { direction: 'undo' | 'redo'; applied: number; skipped: number }) => void;
  change: () => void;
}

export declare class UndoManager {
  on<E extends keyof UndoManagerEvents>(event: E, listener: UndoManagerEvents[E]): void;
  once<E extends keyof UndoManagerEvents>(event: E, listener: UndoManagerEvents[E]): void;
  off<E extends keyof UndoManagerEvents>(event: E, listener?: UndoManagerEvents[E]): void;
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
  clear(): void;
  /** Stops listening, drops the stacks and lets the log compact. */
  stop(): void;
}

/** An undo manager over `storage`'s own writes; stops itself when the storage closes. */
export function createUndo(storage: Storage, options?: UndoOptions): UndoManager;
