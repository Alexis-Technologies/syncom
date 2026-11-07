// The `@alexify/syncom/shared` subpath: several instances over one database — one leads (a full `Database`), the
// others follow (`createDatabase({ readOnly: true })` over the same engine) and write through the leader over a
// channel; the leader gone, a follower takes its place and every live thing is made again.

import type {
  AttachmentEntry,
  AttachmentSweep,
  Attachment,
  Collection,
  Database,
  Document,
  LocalStore,
  RecordData,
  Schema,
  StorageOptions,
} from '../../index.js';
import type { TextHandleMethods, TextMethods } from '../text/text.js';
import type { TreeMethods } from '../tree/tree.js';
import type { SyncApi } from '../sync/sync.js';

/** The database with every shipped kind and the sync plugin: what the facade's writers are typed after. */
export type FullDatabase = Database & TextMethods & TextHandleMethods & TreeMethods & SyncApi;

/** The channel a follower carries its writes over: anything carrying JSON both ways (`createSharedChannel` of the wrpc subpath). */
export interface LeaderChannel {
  /** The payload is a `SharedCall` — `{ id, args, retry }` — which the leader's `serve()` answers once per id. */
  call(method: string, call: SharedCall): Promise<unknown>;
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
  /** This instance never leads (a tab beside a SharedWorker that does): `mode: 'follower'`. */
  follower?: boolean;
  /** ms between beats; 1000 by default. */
  heartbeat?: number;
  /** Beats missed before a candidate claims; 3 by default. */
  misses?: number;
  token?: string;
}

/** What `elect()` answers: re-armable — `onLead` fires at every grant, `yield()` steps aside, `request()` asks again. */
export interface Election {
  readonly token: string;
  readonly mode: 'locks' | 'heartbeat' | 'follower' | 'alone';
  readonly leader: boolean;
  /** Called at every grant; answers the off. */
  onLead(listener: () => void): () => void;
  /** Called when the lead is lost: a smaller token leads, the lock was stolen. */
  onLost(listener: () => void): () => void;
  /** Lets the lock (or the lead) go; `request()` asks for it again. */
  yield(): void;
  request(): void;
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
  /** The current instance's `error` events, and `PROMOTE_FAILED` when the elected instance could not open. */
  error: (error: Error & { code: string }) => void;
}

/** A Document that follows the instance: re-read once after a failover (`update` with the data, delta null). */
export interface SharedDocument<R = RecordData> {
  readonly id: string;
  /** The record as the current instance reads it; rejects with what the bind threw where it failed. */
  data(): Promise<R | null>;
  /** The current instance's Document behind this one (null until the first is read). */
  readonly document: Document<R> | null;
  on(event: 'update', listener: (data: R | null, delta: unknown) => void): this;
  once(event: 'update', listener: (data: R | null, delta: unknown) => void): this;
  off(event: 'update', listener: (data: R | null, delta: unknown) => void): this;
  close(): void;
}

/** A forwarded call as the wire carries it: `id` is `'<follower token>:<n>'`, `retry` once the call may have reached a leader. */
export interface SharedCall {
  id: string;
  args: unknown[];
  retry?: boolean;
}

/** A procedure for a wrpc router: `defineRouter({ 'syncom-db': shared.serve() })`. */
export interface ServedProcedure {
  access: string;
  handler: (
    context: unknown,
    call: SharedCall,
  ) => Promise<{ ok: true; value: unknown } | { ok: false; error: unknown }>;
}

/** A recorded transaction's api on a follower — and what the leader's transaction has too: the writers, no `insert`. */
export interface SharedTransaction {
  get<R = RecordData>(id: string): Promise<R | null>;
  has(id: string): Promise<boolean>;
  set(id: string, data: RecordData, options?: Record<string, unknown>): Promise<void>;
  update(id: string, delta: RecordData, options?: Record<string, unknown>): Promise<void>;
  swap(id: string, data: RecordData, options?: Record<string, unknown>): Promise<void>;
  unset(id: string, fields: string[], options?: Record<string, unknown>): Promise<void>;
  delete(id: string, options?: Record<string, unknown>): Promise<void>;
  purge(id: string, options?: Record<string, unknown>): Promise<void>;
  inc(id: string, field: string, by?: number, options?: Record<string, unknown>): Promise<void>;
  add(id: string, field: string, elements: unknown, options?: Record<string, unknown>): Promise<void>;
  remove(id: string, field: string, elements: unknown, options?: Record<string, unknown>): Promise<void>;
  [writer: string]: (...args: any[]) => Promise<unknown>;
}

/** A bulk write's verdicts as a SharedCollection answers them on either role: the ids written, the rows refused with their errors made again. */
export interface SharedBulkResult<T = unknown> {
  success: string[];
  error: Array<{ index: number; id: string | null; data: T; error: Error & { code?: string } }>;
}

/**
 * A collection of the shared database: the readers the current instance's collection's, the writers the leader's —
 * `insert`, `upsert` and `insertIfAbsent` answer the id on either role, a bulk its verdicts; `modify()` and
 * `remove()` are `NOT_LEADER` on a follower.
 */
export interface SharedCollection<R = RecordData, I = R> {
  readonly name: string;
  /** The current instance's collection: its cursors, documents and events. */
  readonly collection: Collection<R, I>;
  get: Collection<R, I>['get'];
  select: Collection<R, I>['select'];
  count: Collection<R, I>['count'];
  findByIds: Collection<R, I>['findByIds'];
  distinct: Collection<R, I>['distinct'];
  countBy: Collection<R, I>['countBy'];
  document: Collection<R, I>['document'];
  record: Collection<R, I>['record'];
  insert(data: I, options?: Record<string, unknown>): Promise<string>;
  upsert(data: I, options?: Record<string, unknown>): Promise<string>;
  insertIfAbsent(data: I, options?: Record<string, unknown>): Promise<string>;
  set(id: string, data: I, options?: Record<string, unknown>): Promise<void>;
  update(id: string, delta: Partial<R> | Record<string, unknown>, options?: Record<string, unknown>): Promise<unknown>;
  unset(id: string, fields: string[], options?: Record<string, unknown>): Promise<void>;
  delete(id: string, options?: Record<string, unknown>): Promise<void>;
  bulkInsert(rows: I[], options?: Record<string, unknown>): Promise<SharedBulkResult<I>>;
  bulkUpsert(rows: I[], options?: Record<string, unknown>): Promise<SharedBulkResult<I>>;
  bulkRemove(ids: string[], options?: Record<string, unknown>): Promise<SharedBulkResult<string>>;
  modify: Collection<R, I>['modify'];
  remove: Collection<R, I>['remove'];
}

/** The attachments of the shared database: `put` from either role (the blob into the shared store), `get` fetching through the leader. */
export interface SharedAttachments {
  put(
    id: string,
    name: string,
    bytes: Uint8Array | ArrayBuffer | string,
    options?: { type?: string },
  ): Promise<AttachmentEntry>;
  get(id: string, name: string, options?: { fetch?: boolean }): Promise<Attachment | null>;
  has(id: string, name: string): Promise<boolean>;
  list(id: string): Promise<Array<AttachmentEntry & { name: string }>>;
  remove(id: string, name: string): Promise<void>;
  /** The leader's sweep over the shared store; `READ_ONLY` on a follower. */
  sweep(options?: { dryRun?: boolean; tags?: boolean }): Promise<AttachmentSweep>;
}

/** The local documents of the shared database: reads this instance's, `set(key, value)`/`delete` the leader's; no `set(key, fn)`, no `observe`. */
export interface SharedLocal {
  readonly local: true;
  get<T = unknown>(key: string): Promise<T | null>;
  set<T>(key: string, value: T): Promise<T>;
  delete(key: string): Promise<void>;
  list(): Promise<string[]>;
  scoped(prefix: string): SharedLocal;
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
  readonly mode: 'locks' | 'heartbeat' | 'follower' | 'alone';
  /** The election's token: what names this instance's calls to the leader. */
  readonly token: string;
  /** The leader's replication; `NOT_LEADER` on a follower. */
  readonly sync: FullDatabase['sync'];
  waitForLeadership(options?: { signal?: AbortSignal | null }): Promise<void>;
  onLeader(listener: SharedEvents['leader']): () => void;
  /** A live thing over the current instance, made again over the next; answers what stops it for good. */
  live(make: (db: Database) => (() => void) | void | Promise<(() => void) | void>): () => void;
  document<R = RecordData>(id: string): SharedDocument<R>;
  /** The collection named: readers the current instance's, writers the leader's (an id answered, a bulk's verdicts). */
  collection<R = RecordData, I = R>(name: string): SharedCollection<R, I>;
  /** The attachments (`PLUGIN_MISSING` without the plugin): `put` from either role, `get` fetching through the leader. */
  readonly attachments: SharedAttachments;
  /** The local documents: reads this instance's, `set`/`delete` the leader's. */
  readonly local: SharedLocal;
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
  transact<T>(fn: (tx: SharedTransaction) => T | Promise<T>, options?: Record<string, unknown>): Promise<T>;
  /** The procedures a leader mounts for its followers (`access` `'session'` by default); `NOT_LEADER` on a follower. */
  serve(options?: { access?: string }): Record<string, ServedProcedure>;
  /** The role, the generation, the election's mode and the counts: the calls forwarded to the leader, tried again, lost (`LEADER_LOST`), answered from what the leader kept (a retry it saw), the dials, the changes of role. */
  stats(): SharedStats;
  close(): Promise<void>;
  on<E extends keyof SharedEvents>(event: E, listener: SharedEvents[E]): this;
  once<E extends keyof SharedEvents>(event: E, listener: SharedEvents[E]): this;
  off<E extends keyof SharedEvents>(event: E, listener: SharedEvents[E]): this;
}

/** `shared.stats()`: the role, the generation, the election's mode and the counts. */
export interface SharedStats {
  leader: boolean;
  generation: number;
  mode: 'locks' | 'heartbeat' | 'follower' | 'alone';
  /** Calls carried to a leader and answered (a value or its refusal); tried again; lost to a change of leader (`LEADER_LOST`); on a leader, retries answered from what it kept. */
  forwarded: number;
  retried: number;
  lost: number;
  answered: number;
  /** Channels dialed to a leader. */
  dials: number;
  /** Promoted at a failover (never the first lead), demoted (the election lost), yielded (`PROMOTE_FAILED`). */
  promotions: number;
  demotions: number;
  yields: number;
}

export function openShared<S extends Schema = Schema>(options: SharedOptions<S>): Promise<Shared>;
export const Shared: { readonly prototype: Shared };
export const SharedDocument: { readonly prototype: SharedDocument };
export const SharedCollection: { readonly prototype: SharedCollection };
export const SharedAttachments: { readonly prototype: SharedAttachments };
export const SharedLocal: { readonly prototype: SharedLocal };
/**
 * The writers a follower forwards; the writers a recorded transaction may call; the readers the facade answers; a
 * collection's writers forwarded; every procedure `serve()` mounts (the writers, `transact`, `collection`, `local`,
 * `fetchBlob`) — what a SharedWorker's router names.
 */
export const MUTATORS: readonly string[];
export const TX_WRITERS: readonly string[];
export const READERS: readonly string[];
export const COLLECTION_WRITERS: readonly string[];
export const PROCEDURES: readonly string[];
