// The `@alexify/syncom/presence` subpath: who is here and what they are
// doing — ephemeral state per node, never logged. `createPresence(storage)`
// is an emitter holding this node's state and the states it heard of; the
// sync plugin carries its updates (`storage.sync.presence(instance)`), or
// any transport of the application's own (`encode()` / `apply()`).

import type { Storage } from '../../index.js';

/** A node's state as it travels: the node, its clock, its stamp, the state (null leaves) and a signature when the node signs. */
export type PresenceEntry =
  | readonly [node: string, clock: number, ts: number, state: Record<string, unknown> | null]
  | readonly [node: string, clock: number, ts: number, state: Record<string, unknown> | null, sig: string];

/** What a transport carries: the format, the scope the states are of, the entries. */
export interface PresenceUpdate {
  p: 1;
  scope: string;
  s: PresenceEntry[];
}

export interface PresenceOptions {
  /** The sync scope the states are of; `'*'`, the global one, by default. A host relays them to that scope's peers. */
  scope?: string;
  /** How long a state lives without a renewal, in ms; 30 000 by default. This node's renews itself. */
  timeout?: number;
}

/** What `apply()` counted: states taken, older or expired ones, forged, unsigned under `'require'`, malformed or past a bound. */
export interface PresenceApplied {
  applied: number;
  stale: number;
  forged: number;
  unsigned: number;
  refused: number;
}

export interface PresenceEvents {
  /** The states changed: the nodes that came, changed, went. */
  change: (event: { added: string[]; updated: string[]; removed: string[] }) => void;
  /** This node's state to send — what `storage.sync.presence()` carries. */
  update: (update: PresenceUpdate) => void;
}

export declare class Presence {
  on<E extends keyof PresenceEvents>(event: E, listener: PresenceEvents[E]): void;
  once<E extends keyof PresenceEvents>(event: E, listener: PresenceEvents[E]): void;
  off<E extends keyof PresenceEvents>(event: E, listener?: PresenceEvents[E]): void;
  listenerCount(event: keyof PresenceEvents): number;
  /** This node's id. */
  readonly node: string;
  /** The scope the states are of. */
  readonly scope: string;
  /** How long a state lives without a renewal, in ms. */
  readonly timeout: number;
  /** This node's state, or null. */
  readonly local: Record<string, unknown> | null;
  /** The state of `node`, or undefined. */
  get(node: string): Record<string, unknown> | undefined;
  /** Every state by node, this node's included. */
  states(): Map<string, Record<string, unknown>>;
  /** The nodes with a state, this one included. */
  nodes(): string[];
  /**
   * Sets this node's state — a JSON object of at most 64 keys, 8 deep, 16
   * KiB as JSON (`PRESENCE_SIZE` otherwise); `null` leaves — signed when
   * the node can sign, announced as an `update`, renewed on its own.
   * Resolves to the update sent.
   */
  set(state: Record<string, unknown> | null): Promise<PresenceUpdate>;
  /** Leaves: this node's state is null for everyone. */
  delete(): Promise<PresenceUpdate>;
  /** Every state known here as one update — what a newcomer is handed; `nodes` narrows it. */
  encode(nodes?: readonly string[] | null): PresenceUpdate;
  /**
   * Takes an update a transport brought: per node the newest by clock wins,
   * an expired one is stale, a signature that does not verify is forged, an
   * unsigned one under `'require'` refused; `from`, when given, must be the
   * node of every entry.
   */
  apply(update: unknown, options?: { from?: string | null }): Promise<PresenceApplied>;
  /** Leaves and stops: the timers cleared, every state forgotten. */
  destroy(): Promise<void>;
}

/** Presence over `storage`'s identity: signed when the signing plugin is registered. */
export function createPresence(storage: Storage, options?: PresenceOptions): Presence;
/** Whether a value is a presence update of the wire format. */
export function isUpdate(value: unknown): value is PresenceUpdate;
export declare const MAX_STATE_BYTES: 16384;
export declare const MAX_KEYS: 64;
export declare const MAX_DEPTH: 8;
export declare const MAX_STATES: 1024;
