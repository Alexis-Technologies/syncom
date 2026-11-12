// The sync of ops as a plugin (@alexify/syncom/sync): `open({ plugins: [sync] })`
// gives the storage its `sync`, the SyncManager — the dialing side (nodes,
// links, pushes, the feed) and `unit()`, the hosting side a wrpc server
// mounts. The options (`open({ sync })`), the hooks, the link contract and
// the apply path are the core's (index.d.ts); the manager, its events and
// what it reports are declared here. Without the plugin `storage.sync` is
// `PLUGIN_MISSING`.

import type {
  Plugin,
  Database,
  SyncOptions,
  SyncLink,
  Node,
  SchemaInfo,
  VersionVector,
  SyncOp,
  PeerRef,
  RecordData,
} from '../../index.js';

export type { Plugin, Database, SyncOptions, SyncLink, Node, SchemaInfo, VersionVector };

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
  /** The host refused this node's feed for good — 403, a handshake loop, a stuck feed, a kinds mismatch: not waited for until a hello succeeds again. */
  terminal: boolean;
  /** The last failure on the way to this peer, or null. */
  lastError: { code: string | number | null; message: string; at: number } | null;
  direction: 'both' | 'pull' | 'push';
  /** The host's feed read to its end since the last page with ops (its idle page) — what `awaitInSync()` waits for. */
  caughtUp: boolean;
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
  /** Copied onto every procedure of the unit — what a wrpc `onRequest` hook reads as `context.procedure.meta`. */
  meta?: Record<string, unknown>;
  /**
   * Which procedures this unit serves (every one by default): a peer asking for `push` where it is off is refused
   * with 403 `READ_ONLY`, for `snapshot` or `changes` with 403 `NOT_SERVED`.
   */
  /**
   * Which procedures this unit serves. `blob` is `'named'` (`true`; the default: a digest served to a peer that names a
   * live record in its scopes holding it), `'any'` (by digest alone — a trusted mesh's) or `false`.
   */
  allow?: { push?: boolean; changes?: boolean; snapshot?: boolean; blob?: boolean | 'named' | 'any' };
  /**
   * The host's rule on what a peer may write, asked of every pushed op before it is applied, with the record as it
   * is here (`current`, null for none) and as the op would leave it (`after`): `false` refuses the op — logged as a
   * scrub leaves it (skipped, scrubbed), relayed as a no-op, no gap in its stream — and names it in the push's
   * answer (`refused`), with `current`, for the pusher to set itself straight (`WRITE_REFUSED`, a revert of its
   * own). A throw fails the page: the pusher offers it again.
   */
  authorizeWrite?: (context: {
    op: SyncOp;
    peer: PeerRef | null;
    current: RecordData | null;
    after: RecordData | null;
  }) => boolean | Promise<boolean>;
  /**
   * Ask every peer to prove it holds the key that is its node id before anything is taken or handed to it: hello
   * answers a `challenge`, the peer signs it (`syncom/prove`), and until then push, snapshot and changes are 403
   * `UNPROVEN`. On by default under `sync.signatures: 'require'`; needs the signing plugin.
   */
  prove?: boolean;
  /**
   * Serve `query` and `count` — a thin client's read of this host's records through the query plugin, in its scopes —
   * and whether a `$regex` is taken from the wire: `true` is `{ regex: false }` (refused, 400 `REGEX`); `'safe'` takes
   * a pattern `safeRegex` passes (no nested quantifier, backreference or lookaround); `true` any (a trusted peer's:
   * a pattern runs on this host's event loop).
   */
  query?: boolean | { regex?: false | true | 'safe' };
}

export interface SyncLimits {
  opsPerPush?: number;
  /** The JSON length of a page's `ops`. */
  bytesPerPush?: number;
  /** A token bucket per peer, refilled at this rate and holding one second's worth. */
  opsPerSecond?: number;
  /**
   * For a peer granted everything, the rows one `query` answers at most; for a scoped peer, the rows one `query` or
   * `count` READS — the walk goes on until the window is full or the budget is spent, and `capped` says when the
   * budget ended it (500 by default; `Infinity` for none).
   */
  rowsPerQuery?: number;
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
  /** The challenge hello handed a peer, signed under its key. */
  prove: SyncProcedure;
  /** `unit({ query: true })`: a query over an entity, its rows in the peer's scopes; a count. */
  query?: SyncProcedure;
  count?: SyncProcedure;
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
      | 'rule'
      | 'forged'
      | 'unsigned'
      | 'equivocation'
      | 'HELLO'
      | 'PRESENCE_RATE'
      | 'PRESENCE_MALFORMED'
      | 'PRESENCE_SCOPE'
      | 'PRESENCE_FORGED'
      | 'PRESENCE_UNSIGNED'
      | 'PRESENCE_UNPROVEN';
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
  /** Hosting side: `revoke(node, scopes)` took scopes back from a peer. */
  revoke: (event: { node: string; scopes: string[] }) => void;
}

export interface NodeData {
  url: string;
  token?: string;
  scopes?: string[];
  /**
   * What the link carries. `'both'` (the default) pushes and subscribes; `'pull'` only subscribes — nothing of this
   * node goes to the peer, and retention does not wait for it; `'push'` only pushes — no feed, no bootstrap.
   */
  direction?: 'both' | 'pull' | 'push';
}

export interface SyncManager {
  readonly storage: Database;
  readonly started: boolean;
  /** The host's rule on what a peer may write (`createDatabase({ sync: { authorizeWrite } })`), every unit's default and the writer's over the inbox; null for none. */
  readonly authorizeWrite: SyncUnitOptions['authorizeWrite'] | null;
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
   * Resolves once every enabled node is in sync with this one: each link up and greeted, nothing left to push to it
   * and its feed read to its end (the host's idle page); `signal` cuts the wait short.
   */
  awaitInSync(options?: { signal?: AbortSignal | null }): Promise<void>;
  /** Resolves once every enabled node has been in sync at least once since it was dialed — what a client waits for before it reads. */
  awaitInitialReplication(options?: { signal?: AbortSignal | null }): Promise<void>;
  /** Resolves once the newest op this node made for the record is acknowledged by every enabled node it goes to; at once when it made none. */
  awaitDocumentPushed(id: string, options?: { signal?: AbortSignal | null }): Promise<void>;
  /**
   * Hosting side: takes `scopes` back from the peer `node` on every unit of this manager — its live feeds end, it
   * is told at once (`syncom/revoke`), its grant is narrower from here on and its next hello says so (`revoked`).
   * A grant of everything (`'*'`) is not narrowed by a scope: revoke what hello granted.
   */
  revoke(node: string, scopes: string[]): void;
  /** The bytes of an attachment's blob asked of the connected peers by digest (`syncom/blob`), checked and kept here; `BLOB_NOT_FOUND` where none holds them. */
  fetchBlob(digest: string, named?: { id: string; name: string }): Promise<Uint8Array>;
  /** The shared log as this hub stands to it (`sync.sharedLog`), or null without one. */
  shared(): SharedStats | null;
  /**
   * Carries a presence instance (`@alexify/syncom/presence`): its updates go
   * to every connected host as the `syncom/presence` event, a host's come
   * back to it, a host hands its room's to this node at hello. Returns the
   * function that stops carrying it.
   */
  presence(instance: PresenceCarried): () => void;
  unit(options?: SyncUnitOptions): SyncUnit;
}

/** `sync.shared()`: the topics, the consumer's cursors, the relay's watermark (the last log position every op at or below which is in the topic) and the counts. */
export interface SharedStats {
  topic: string;
  inbox: string | false;
  running: boolean;
  cursor: { topic: string | null; inbox: string | null };
  /** The watermark: the last position of this node's log every op at or below which is in the topic; null while none is. */
  appended: string | null;
  /** Positions above the watermark known to be in the topic, waiting for the run from it to be whole. */
  covered: number;
  /** An append failed: nothing more goes out until the recovery appends what the log holds above `appended`. */
  behind: boolean;
  /** A topic whose entry a rule refused three times (a hook that throws, a bug): nothing past it is taken until `stop()` and `start()`. */
  stuck: { topic: boolean; inbox: boolean };
  /** A topic whose entry the engine refused: tried again, backed off, until it lands (`SHARED_LOG_FAILED` `apply`, once per run). */
  retrying: { topic: boolean; inbox: boolean };
  /** A read-only hub keeps the vector as the log moved it. */
  shadow: boolean;
  /** Ops this hub appended; entries read from the topic and the inbox; ops applied from them; ops forwarded to the inbox; entries that did not read; holes passed (a number whose entry never came, told as `SHARED_LOG_FAILED` `hole`). */
  relayed: number;
  entries: number;
  applied: number;
  forwarded: number;
  malformed: number;
  holes: number;
  appendFailures: number;
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
  new (storage: Database, options?: SyncOptions): Promise<SyncManager>;
}

export declare const SyncManager: SyncManagerConstructor;
