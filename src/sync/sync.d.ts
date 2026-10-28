// The sync of ops as a plugin (@alexify/syncom/sync): `open({ plugins: [sync] })`
// gives the storage its `sync`, the SyncManager — the dialing side (nodes,
// links, pushes, the feed) and `unit()`, the hosting side a wrpc server
// mounts. The options (`open({ sync })`), the hooks, the link contract and
// the apply path are the core's (index.d.ts); the manager, its events and
// what it reports are declared here. Without the plugin `storage.sync` is
// `PLUGIN_MISSING`.

import type { Plugin, Storage, SyncOptions, SyncLink, Node, SchemaInfo, VersionVector } from '../../index.js';

export type { Plugin, Storage, SyncOptions, SyncLink, Node, SchemaInfo, VersionVector };

/** What the plugin adds to a storage: the manager at `storage.sync`. */
export interface SyncApi {
  readonly sync: SyncManager;
}

/** The plugin: the storage gets its SyncManager once the log is open. */
export declare const sync: Plugin<SyncApi>;

export { isSyncLink } from '../../index.js';

/** Hosting side: a peer with a live `changes` feed on this node. */
export interface HostedPeer {
  node: string;
  /** The scopes the feed serves; `null` for every scope. */
  scopes: string[] | null;
  since: number;
  cursor: string | null;
}

/** One dialed peer, as `sync.peers()` reports it. */
export interface PeerView {
  url: string;
  node: string | null;
  connected: boolean;
  subscribed: boolean;
  cursor: string | null;
  lastSync: number | null;
  /** Ops waiting in the outbox, plus one while a push is in flight. */
  pending: number;
  /**
   * A push to this peer failed (or its outbox overflowed `sync.maxOutbox`):
   * what it lacks is pushed from the vector at the next sign of life on the
   * link — a page received from it, an op to relay — or by `sync()`.
   */
  behind: boolean;
  /**
   * A page of this peer's feed failed to apply three times in a row; the
   * subscription is closed and nothing past that page is taken until the
   * application intervenes (`enableNode` off and on, or a bootstrap).
   */
  stuck: boolean;
  /** The last failure on the way to this peer, or null. */
  lastError: { code: string | number | null; message: string; at: number } | null;
}

export interface SyncUnitOptions {
  /** wrpc's access level for the four procedures (default `'session'`). */
  access?: string;
  /** Presence on this host: how long a state is kept for newcomers (`timeout`, 30 000 ms), updates per second per peer (`rate`, 20), states per scope (`max`, 1 024). */
  presence?: { timeout?: number; rate?: number; max?: number };
  /**
   * Gates a peer by whatever the transport presented, and by what hello says.
   * The `scopes` hello carries are what the peer may then write (`push`) and
   * read (`snapshot`, `changes`) here.
   */
  authorize?: (
    context: unknown,
    hello: {
      node: string;
      version?: number;
      vector?: VersionVector;
      scopes?: string[];
      token?: string;
      schema?: SchemaInfo | null;
    },
  ) => boolean | Promise<boolean>;
  /** How a `changes` value is labelled with its position (wrpc's tracked shape by default). */
  tracked?: (id: string, data: unknown) => unknown;
  pageSize?: number;
  pageBytes?: number;
  /** Per-peer push limits: a page over `opsPerPush`/`bytesPerPush` is refused with 413, a peer over `opsPerSecond` with 429. */
  limits?: SyncLimits;
  /** Copied onto all four procedures — what a wrpc `onRequest` hook reads as `context.procedure.meta`. */
  meta?: Record<string, unknown>;
}

export interface SyncLimits {
  opsPerPush?: number;
  /** The JSON length of a page's `ops`. */
  bytesPerPush?: number;
  /** A token bucket per peer, refilled at this rate and holding one second's worth. */
  opsPerSecond?: number;
}

export interface SyncProcedure {
  access: string;
  handler: (...args: any[]) => unknown;
  meta?: Record<string, unknown>;
}

/** What a host mounts: `defineRouter({ syncom: storage.sync.unit() })`. */
export interface SyncUnit {
  hello: SyncProcedure;
  push: SyncProcedure;
  snapshot: SyncProcedure;
  changes: SyncProcedure;
  /** The inbound events (wrpc's `on` block): `presence`, a peer's presence update, relayed to its scope's room. */
  on: { presence: SyncProcedure };
}

/** The events a SyncManager emits; listeners are contained. */
export interface SyncEvents {
  /** A link came up (with the host's node id and schema after hello), went down, or came back. */
  peer: (event: {
    url: string;
    connected: boolean;
    node?: string;
    reconnected?: boolean;
    schema?: SchemaInfo | null;
  }) => void;
  /** A push went out (`pushed`) or a page came in (`received` and the apply result). */
  sync: (event: {
    url: string;
    pushed?: number;
    received?: number;
    applied?: number;
    skipped?: number;
    duplicates?: number;
    gaps?: number;
    malformed?: number;
    unsigned?: number;
    forged?: number;
    outOfScope?: number;
    equivocations?: number;
  }) => void;
  bootstrap: (event: { url: string; records: number }) => void;
  /**
   * Hosting side: ops of a peer this node would not take — outside the
   * scopes its hello granted (`scope`), signed but not by their origin
   * (`forged`), unsigned under `sync.signatures: 'require'` (`unsigned`), or
   * another op than the one this node holds at their seq, or after the one
   * before it (`equivocation`).
   */
  /**
   * Hosting side: what a peer sent was refused. Ops — out of scope, forged,
   * unsigned under 'require', or a fork of a stream (`equivocation`: another
   * op at a seq this node holds, or a broken chain; `node` the pusher); a
   * presence update — not the peer's own, of a scope it did not ask for,
   * past the rate, malformed or unsigned (`PRESENCE_*`, one each); a presence
   * update before hello (`HELLO`, `node` null).
   */
  refused: (event: {
    node: string | null;
    reason:
      | 'scope'
      | 'forged'
      | 'unsigned'
      | 'equivocation'
      | 'HELLO'
      | 'PRESENCE_RATE'
      | 'PRESENCE_MALFORMED'
      | 'PRESENCE_SCOPE'
      | 'PRESENCE_FORGED'
      | 'PRESENCE_UNSIGNED';
    count: number;
  }) => void;
  /**
   * A failure on the way to a peer; `url` names it. A page of the feed that
   * could not be applied comes as `code: 'PAGE_FAILED'` (with `cursor`, the
   * last position saved, and `attempt`), and is retried from that cursor;
   * the third failure in a row is `code: 'STUCK'`. A host that answers 428
   * to five fresh hellos in a row is `code: 'HANDSHAKE_LOOP'`. A refusal the
   * host answered with comes as the link delivered it: a numeric `code`.
   */
  error: (error: Error & { url: string; code?: string | number; cursor?: string | null; attempt?: number }) => void;
  start: () => void;
  stop: () => void;
  node: (event: { url: string; action: 'add' | 'remove' | 'enable' | 'disable' }) => void;
  /** A link was accepted, before hello. */
  connect: (event: { url: string }) => void;
  /** Hosting side: a peer greeted this node and was authorized. */
  hello: (event: { node: string; scopes: string[]; schema: SchemaInfo | null }) => void;
}

export interface NodeData {
  url: string;
  token?: string;
  scopes?: string[];
}

export interface SyncManager {
  readonly storage: Storage;
  readonly started: boolean;
  /** Ops queued for peers over every dialed peer — what the outbox gauge reads. */
  pendingOps(): number;
  on<E extends keyof SyncEvents>(event: E, listener: SyncEvents[E]): void;
  once<E extends keyof SyncEvents>(event: E, listener: SyncEvents[E]): void;
  off<E extends keyof SyncEvents>(event: E, listener?: SyncEvents[E]): void;
  listenerCount(event: keyof SyncEvents): number;
  listeners<E extends keyof SyncEvents>(event: E): SyncEvents[E][];
  eventNames(): (keyof SyncEvents)[];
  /** Resolves with the next emission's first argument. */
  toPromise<E extends keyof SyncEvents>(event: E): Promise<Parameters<SyncEvents[E]>[0]>;
  /** Drops every listener of `event`, or of every event. */
  clear(event?: keyof SyncEvents): void;
  addNode(nodeData: NodeData): Promise<void>;
  removeNode(url: string): Promise<void>;
  enableNode(url: string, enabled?: boolean): Promise<void>;
  listNodes(): Node[];
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Pushes whatever the connected peers (or one) lack right now. */
  sync(url?: string): Promise<Array<{ url: string; pushed: number }>>;
  peers(): PeerView[];
  /** Hosting side: every peer with a live `changes` feed here. */
  hosted(): HostedPeer[];
  /**
   * Carries a presence instance (`@alexify/syncom/presence`): its updates go
   * to every connected host as the `syncom/presence` event, a host's come
   * back to it, a host hands its room's to this node at hello. Returns the
   * function that stops carrying it.
   */
  presence(instance: PresenceCarried): () => void;
  unit(options?: SyncUnitOptions): SyncUnit;
}

/** What `presence()` carries: the shape of a `Presence` of `@alexify/syncom/presence`. */
export interface PresenceCarried {
  readonly scope: string;
  readonly node: string;
  readonly local: Record<string, unknown> | null;
  apply(update: unknown, options?: { from?: string | null }): Promise<unknown>;
  encode(nodes?: readonly string[] | null): unknown;
  on(event: 'update', listener: (update: any) => void): void;
  off(event: 'update', listener?: (update: any) => void): void;
}

export interface SyncManagerConstructor {
  readonly prototype: SyncManager;
  new (storage: Storage, options?: SyncOptions): Promise<SyncManager>;
}

export declare const SyncManager: SyncManagerConstructor;
