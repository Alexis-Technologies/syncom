// The `@alexify/syncom/testing` subpath: what a test over syncom stands on — the memory engine, an in-process link
// that mimics wrpc at the boundary with the hazards a transport has, a mesh of databases from an adjacency list,
// `settle()` for when it has gone quiet, `waitUntil()`, `withDatabase()`. No framework, no runner: node:test, vitest
// or a browser's harness call these alike.

import type { Database, Node, StorageOptions, SyncLink, SyncOptions } from '../../index.js';
import type { SyncApi, SyncUnit, SyncUnitOptions } from '../sync/sync.js';
import type { MemoryEngine } from '../memory/memory.js';

export type { SyncLink, SyncUnit, SyncUnitOptions, MemoryEngine };
/** The memory engine (`@alexify/syncom/memory`): a database that lives in the process. */
export { memoryEngine } from '../memory/memory.js';

/** A database with the sync plugin: what a node of the mesh is. */
export type SyncedDatabase = Database & SyncApi;

/** What wrpc's `context.client` looks like to a handler of the unit. */
export interface MemoryClient {
  readonly id: string;
  data: Record<string, unknown>;
  readonly binary: boolean;
  readonly rooms: Set<string>;
  join(room: string): void;
}

/** A room-addressed emit: `server.to(room).except(client).emit(name, data)`. */
export interface MeshTarget {
  to(...rooms: string[]): MeshTarget;
  except(client: MemoryClient): MeshTarget;
  emit(name: string, data: unknown): void;
}

/** What wrpc's `context.server` does for the links of one host: the rooms the clients joined, `sendTo`. */
export interface MeshServer {
  readonly links: Set<MemoryLink>;
  to(...rooms: string[]): MeshTarget;
  except(client: MemoryClient): MeshTarget;
  sendTo(clientId: string, name: string, data: unknown): void;
}

/** The hazards a transport has, chosen per link. */
export interface MemoryLinkOptions {
  /** Milliseconds every call and every event waits. */
  latency?: number;
  /** A page of a subscription lost on the way: answer true to drop it. */
  drop?: (page: unknown) => boolean;
  /** A page delivered twice, as a flaky transport might: answer true to duplicate it. */
  duplicate?: (page: unknown) => boolean;
  /** The host's server over the links of one host; the mesh sets it. */
  server?: MeshServer | null;
}

export interface SubscriptionHandlers {
  lastEventId?: string;
  onData?: (value: unknown, eventId?: string) => void | Promise<void>;
  onError?: (error: Error & { code?: number }) => void;
  onEnd?: () => void;
}

/**
 * An in-process `SyncLink` over a host's `sync.unit()`: arguments and results cross as JSON, `changes` is driven as
 * an async generator, a `disconnect()` aborts it and `reconnect()` re-opens every subscription from its last event
 * id — what wrpc does at the boundary.
 */
export declare class MemoryLink implements SyncLink {
  constructor(unit: SyncUnit, options?: MemoryLinkOptions);
  /** The server-side client the host sees; `data` is its bag (emptied by a reconnect, so the host greets it again). */
  readonly client: MemoryClient;
  readonly context: { client: MemoryClient; server: MeshServer | null };
  /** The methods called, in order. */
  readonly calls: string[];
  /** The events sent, in order. */
  readonly sent: string[];
  /** Whether the socket is down. */
  readonly down: boolean;
  call(method: string, args: unknown): Promise<unknown>;
  subscribe(
    method: string,
    args: unknown,
    handlers: SubscriptionHandlers,
  ): { unsubscribe(): void; readonly lastEventId?: string };
  /** A fire-and-forget event to the host (the unit's `on` block), as wrpc would call it. */
  send(event: string, data: unknown): void;
  /** The host's event to this client — what wrpc's `client.api.syncom.on` hears. */
  deliver(event: string, data: unknown): void;
  /** The socket died: live feeds stop, calls fail (code 503), `close` is announced. */
  disconnect(): void;
  /** wrpc's reconnect: a new server-side client unless `freshClient: false`, every subscription re-opened, `reconnect` announced. */
  reconnect(options?: { freshClient?: boolean }): Promise<void>;
  close(): void;
  on(event: string, listener: (...args: any[]) => void): void;
  once(event: string, listener: (...args: any[]) => void): void;
  off(event: string, listener: (...args: any[]) => void): void;
  emit(event: string, ...args: unknown[]): Promise<void>;
}

export interface MeshOptions<D extends SyncedDatabase = SyncedDatabase> {
  /**
   * The database of a node: `options` carries `sync.connect` to the mesh's links and `autoStart: false`, over what
   * `nodes[name]` says for this node and `sync` for every one — spread it into `createDatabase()`'s.
   */
  createStorage(name: string, options: StorageOptions): D | Promise<D>;
  /** Every link's hazards. */
  link?: MemoryLinkOptions;
  /** Sync options for every node, under `connect` and `autoStart`. */
  sync?: SyncOptions;
  /** Options for one node by name. */
  nodes?: Record<string, StorageOptions>;
  /** What every node hosts (`sync.unit(options)`); `{ access: 'public' }` by default. */
  unit?: SyncUnitOptions;
  /** The scopes a node dials for, by its name. */
  scopes?: Record<string, string[]>;
}

export interface Mesh<D extends SyncedDatabase = SyncedDatabase> {
  readonly storages: Map<string, D>;
  /** The links by the url dialed (`mem://<name>`). */
  readonly links: Map<string, MemoryLink>;
  readonly units: Map<string, SyncUnit>;
  readonly servers: Map<string, MeshServer>;
  /** The `sync.connect` the nodes dial with: a link to the host named by `mem://<name>`. */
  connect(node: Node): MemoryLink;
  get(name: string): D;
  /** Every database closed, in the order made. */
  close(): Promise<void>;
}

/**
 * N databases wired by memory links from an adjacency list — `['A', 'B']` means A dials B — every one hosting a unit,
 * every manager started.
 */
export declare function createMesh<D extends SyncedDatabase = SyncedDatabase>(
  names: readonly string[],
  edges: ReadonlyArray<readonly [string, string]>,
  options: MeshOptions<D>,
): Promise<Mesh<D>>;

export interface WaitOptions {
  /** Milliseconds before the wait rejects; 5000 by default. */
  timeout?: number;
  /** Milliseconds between polls; 10 by default. */
  step?: number;
}

/** Resolves once every vector is equal and nothing is in flight, three polls in a row; rejects past `timeout`. */
export declare function settle(
  storages: Iterable<SyncedDatabase> | Map<string, SyncedDatabase>,
  options?: WaitOptions,
): Promise<void>;
/** Whether every database's vector is the same (a node's bootstrap stream, `@~`, never reaches the node it came from). */
export declare function sameVectors(storages: Iterable<Database> | Map<string, Database>): boolean;
/** Resolves once `predicate()` — a value or a promise — is true, polled every `step` ms; rejects past `timeout`. */
export declare function waitUntil(predicate: () => unknown, options?: WaitOptions): Promise<void>;
/** Deterministic pseudo-random numbers in [0, 1) over `seed`. */
export declare function prng(seed: number): () => number;
/** A database — or what opens one — for `fn`, closed after it whatever `fn` does; `fn`'s answer. */
export declare function withDatabase<D extends { close(): unknown }, T>(
  open: D | Promise<D> | (() => D | Promise<D>),
  fn: (db: D) => T | Promise<T>,
): Promise<T>;
