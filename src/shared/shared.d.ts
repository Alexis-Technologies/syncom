// The `@alexify/syncom/shared` subpath: several instances over one database — one leads (a full `Database`), the
// others follow (`createDatabase({ readOnly: true })` over the same engine) and write through the leader over a
// channel; the leader gone, a follower takes its place and every live thing is made again.

import type { Collection, Database, Document, RecordData, Schema, StorageOptions } from '../../index.js';
import type { TextHandleMethods, TextMethods } from '../text/text.js';
import type { TreeMethods } from '../tree/tree.js';
import type { SyncApi } from '../sync/sync.js';

/** The database with every shipped kind and the sync plugin: what the facade's writers are typed after. */
export type FullDatabase = Database & TextMethods & TextHandleMethods & TreeMethods & SyncApi;

/** The channel a follower carries its writes over: anything carrying JSON both ways (`createSharedChannel` of the wrpc subpath). */
export interface LeaderChannel {
  call(method: string, args: unknown[]): Promise<unknown>;
  close?(): unknown;
}

/** Web Locks as the election: `navigator.locks` in a browser, a fake in tests. */
export interface LocksLike {
  request(name: string, options: { mode: 'exclusive' }, callback: (lock: unknown) => unknown): Promise<unknown>;
}

/** A BroadcastChannel as the election's wire where there are no Web Locks. */
export interface BroadcastLike {
  postMessage(message: unknown): void;
  addEventListener?(type: 'message', listener: (event: { data: unknown }) => void): void;
  removeEventListener?(type: 'message', listener: (event: { data: unknown }) => void): void;
  onmessage?: ((event: { data: unknown }) => void) | null;
  close?(): void;
}

export interface ElectionOptions {
  /** Web Locks; `navigator.locks` is the one to pass in a browser. */
  locks?: LocksLike | null;
  /** The heartbeat's wire, where there are no locks. */
  channel?: BroadcastLike | null;
  /** ms between beats; 1000 by default. */
  heartbeat?: number;
  /** Beats missed before a candidate claims; 3 by default. */
  misses?: number;
  token?: string;
}

/** What `elect()` answers: `lead` resolves when this instance leads. */
export interface Election {
  readonly token: string;
  readonly mode: 'locks' | 'heartbeat' | 'alone';
  readonly lead: Promise<void>;
  readonly leader: boolean;
  onLost(listener: () => void): () => void;
  release(): void;
}

export function elect(options: ElectionOptions & { name: string }): Election;

export interface SharedOptions<S extends Schema = Schema> extends StorageOptions<S> {
  /** The `createDatabase` of the flavour in use (the core's, `/all`'s): nothing of the core is bundled here. */
  createDatabase: (options: any) => Promise<Database>;
  path: string;
  /** Dials the leader for a follower; called again after a failover. None: a follower cannot write. */
  channel?: ((context: { path: string; generation: number }) => LeaderChannel | Promise<LeaderChannel>) | null;
  election?: ElectionOptions;
  /** ms to wait for the grant before opening as a follower; 50 by default. */
  grace?: number;
  /** ms a follower's write waits for a leader to answer before `LEADER_LOST`; 10 000 by default. */
  failover?: number;
}

export interface SharedEvents {
  /** This instance leads: at the start, or after a failover (`generation` counted up). */
  leader: (event: { path: string; generation: number }) => void;
  /** This instance follows: at the start, or after it yielded. */
  follower: (event: { path: string; generation: number }) => void;
  /** Every live thing was made again over a new instance. */
  rebind: (event: { path: string; generation: number }) => void;
  /** The current instance's `error` events, and `LEADER_LOST` when the elected instance could not open. */
  error: (error: Error & { code: string }) => void;
}

/** A Document that follows the instance: re-read once after a failover (`update` with the data, delta null). */
export interface SharedDocument<R = RecordData> {
  readonly id: string;
  data(): Promise<R | null>;
  /** The current instance's Document behind this one (null until the first is read). */
  readonly document: Document<R> | null;
  on(event: 'update', listener: (data: R | null, delta: unknown) => void): this;
  once(event: 'update', listener: (data: R | null, delta: unknown) => void): this;
  off(event: 'update', listener: (data: R | null, delta: unknown) => void): this;
  close(): void;
}

/** A procedure for a wrpc router: `defineRouter({ 'syncom-db': shared.serve() })`. */
export interface ServedProcedure {
  access: string;
  handler: (context: unknown, args: unknown) => Promise<{ ok: true; value: unknown } | { ok: false; error: unknown }>;
}

export interface Shared {
  /** The current instance: the leader's `Database`, or a follower's read-only one. */
  readonly db: Database;
  readonly leader: boolean;
  isLeader(): boolean;
  readonly path: string;
  readonly nodeId: string;
  /** Counted up at every change of instance. */
  readonly generation: number;
  readonly mode: 'locks' | 'heartbeat' | 'alone';
  /** The leader's replication; `NOT_LEADER` on a follower. */
  readonly sync: FullDatabase['sync'];
  waitForLeadership(options?: { signal?: AbortSignal | null }): Promise<void>;
  onLeader(listener: SharedEvents['leader']): () => void;
  /** A live thing over the current instance, made again over the next; answers what stops it for good. */
  live(make: (db: Database) => (() => void) | void | Promise<(() => void) | void>): () => void;
  document<R = RecordData>(id: string): SharedDocument<R>;
  /** The collection named, of the current instance. */
  collection<R = RecordData, I = R>(name: string): Collection<R, I>;
  get: Database['get'];
  has: Database['has'];
  hasRecord: Database['hasRecord'];
  list: Database['list'];
  getCachedData: Database['getCachedData'];
  insert: Database['insert'];
  saveData: Database['saveData'];
  set: Database['set'];
  update: Database['update'];
  swap: Database['swap'];
  unset: Database['unset'];
  delete: Database['delete'];
  purge: Database['purge'];
  forget: Database['forget'];
  inc: Database['inc'];
  add: Database['add'];
  remove: Database['remove'];
  splice: FullDatabase['splice'];
  push: FullDatabase['push'];
  setAt: FullDatabase['setAt'];
  move: FullDatabase['move'];
  mark: FullDatabase['mark'];
  unmark: FullDatabase['unmark'];
  unmarkById: FullDatabase['unmarkById'];
  updateText: FullDatabase['updateText'];
  insertEmbed: FullDatabase['insertEmbed'];
  updateBlock: FullDatabase['updateBlock'];
  treeMove: FullDatabase['treeMove'];
  treeRemove: FullDatabase['treeRemove'];
  applyPatches: Database['applyPatches'];
  restore: Database['restore'];
  compact: Database['compact'];
  /** The leader's transaction; on a follower a recorded one, carried whole (no `insert`, no read of its own writes). */
  transact: Database['transact'];
  /** The procedures a leader mounts for its followers; `NOT_LEADER` on a follower. */
  serve(options?: { access?: string }): Record<string, ServedProcedure>;
  close(): Promise<void>;
  on<E extends keyof SharedEvents>(event: E, listener: SharedEvents[E]): this;
  once<E extends keyof SharedEvents>(event: E, listener: SharedEvents[E]): this;
  off<E extends keyof SharedEvents>(event: E, listener: SharedEvents[E]): this;
}

export function openShared<S extends Schema = Schema>(options: SharedOptions<S>): Promise<Shared>;
export const Shared: { readonly prototype: Shared };
export const SharedDocument: { readonly prototype: SharedDocument };
/** The writers a follower forwards; the writers a recorded transaction may call; the readers the facade answers. */
export const MUTATORS: readonly string[];
export const TX_WRITERS: readonly string[];
export const READERS: readonly string[];
