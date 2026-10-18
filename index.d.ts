export type JSONSafe =
  | string
  | number
  | boolean
  | null
  | { readonly [key: string]: JSONSafe }
  | readonly JSONSafe[];

export interface KeyPair {
  readonly publicKey: string;
  readonly privateKey: string;
}

export function generateKeys(): Promise<KeyPair>;
export function encrypt(data: unknown, publicKey: string): string;
export function decrypt(data: string, privateKey: string): unknown;
export function loadKeys(basePath: string): Promise<KeyPair>;

export function read(dir: string, filename: string): Promise<string>;
export function write(dir: string, filename: string, content: string): Promise<void>;
export function exists(dir: string, filename: string): Promise<boolean>;
export function remove(dir: string, filename: string): Promise<void>;
export function list(dir: string): Promise<string[]>;

// ---------------------------------------------------------------------------
// Replication model (src/ops.js, src/vector.js, src/log.js)

/** `[ts, origin]` — a millisecond stamp with the node id as the tie-break. */
export type ClockStamp = readonly [number, string];

/** The highest per-origin sequence number a node has applied. */
export type VersionVector = { readonly [origin: string]: number };

export type SyncOpType = 'write' | 'set' | 'inc' | 'delete' | 'merge' | 'advance';

export interface SyncOp {
  origin: string;
  seq: number;
  ts: number;
  type: SyncOpType;
  /** The record; absent only on `advance`. */
  id?: string;
  scope?: string;
  /** `advance`: the vector a joined snapshot covered. */
  vector?: VersionVector;
  /** `merge`/`advance`: the node whose snapshot this came from. */
  from?: string;
  /** `write`/`set`: the fields; `merge`: the joined entry's data. */
  data?: Record<string, unknown>;
  /** `merge`: the joined entry's metadata. */
  meta?: EntryMeta;
  /** `inc`: the counter field. */
  key?: string;
  /** `inc`: the amount added. */
  value?: number;
  /** The schema version of the node that made it; absent without a schema, and on `merge`/`advance`. */
  v?: number;
}

export interface EntryMeta {
  clock: { [field: string]: ClockStamp };
  base: ClockStamp | null;
  deleted: ClockStamp | null;
  counters: { [field: string]: { [origin: string]: readonly [number, number, number] } };
  /** The schema version of the last whole-record write (or of the `set` that created the entry). */
  v?: number;
}

export interface Entry {
  data: Record<string, unknown>;
  meta: EntryMeta;
}

export interface ApplyResult {
  entry: Entry;
  changed: boolean;
  delta: Record<string, unknown>;
  rejected: Array<{ field: string; reason: 'register' | 'counter' }>;
}

/**
 * Thrown (rejected) by the operation a hook belongs to when that hook threw.
 * `hook` names it, `cause` is the original error; the operation itself is
 * described by the hook's documentation — a `before*` hook aborts it, an
 * `after*` hook fails the call while what it observed stays committed.
 */
export class HookError extends Error {
  constructor(hook: string, cause: unknown);
  readonly name: 'HookError';
  readonly code: 'HOOK_FAILED';
  readonly hook: string;
  readonly cause: unknown;
}

export function applyOp(entry: Entry | null, op: SyncOp): ApplyResult;
export function mergeEntry(a: Entry | null, b: Entry | null): Entry | null;
export function isAlive(entry: Entry | null): boolean;

export interface LogEntry {
  seq: number;
  op: SyncOp;
  /** Accepted but not applied here: a `beforeApply` false, a failed validation, or a held op. */
  skipped?: true;
  /** The schema version the op waits for (`ahead: 'hold'`). */
  held?: number;
}

export interface OpLogOptions {
  rollAfter?: number;
  retention?: { ops?: number; days?: number };
  logger?: Logger | false;
  telemetry?: SyncomTelemetryOptions;
}

export interface OpLog {
  readonly epoch: string;
  readonly floor: number;
  readonly next: number;
  readonly vector: VersionVector;
  readonly length: number;
  readonly lastEventId: string;
  formatId(seq: number): string;
  append(
    ops: readonly SyncOp[],
    options?: { skipped?: ReadonlySet<SyncOp> | null; held?: ReadonlyMap<SyncOp, number> | null },
  ): Promise<LogEntry[]>;
  /** The entries held for a newer schema version, oldest first. */
  held(): LogEntry[];
  /** Held entries compaction dropped since the last reset — lost for good. */
  readonly droppedHeld: number;
  resetDroppedHeld(): Promise<void>;
  since(eventId: string | null | undefined, options?: { scopes?: readonly string[] | null; limit?: number }): LogEntry[] | null;
  advance(vector: VersionVector): Promise<void>;
  tail(): LogEntry[];
  flush(): Promise<void>;
  close(): Promise<void>;
}

export interface OpLogConstructor {
  readonly prototype: OpLog;
  new (basePath: string, options?: OpLogOptions): Promise<OpLog>;
}

export const OpLog: OpLogConstructor;

/** A Console, a pino-shaped logger, or `false` for silence. */
export interface Logger {
  debug?(...args: unknown[]): void;
  info?(...args: unknown[]): void;
  warn?(...args: unknown[]): void;
  error?(...args: unknown[]): void;
}

// ---------------------------------------------------------------------------
// OpenTelemetry
//
// Structural views of the OTel objects, so a real SDK is assignable without
// syncom importing (or depending on) @opentelemetry/api. Only `Span.end` is
// required — everything a span might not implement is optional, and syncom
// calls it optionally. The shapes match wrpc's, so one object serves both.

export interface SyncomSpan {
  setAttribute?(key: string, value: unknown): unknown;
  addEvent?(name: string, attributes?: Record<string, unknown>): unknown;
  recordException?(error: unknown): void;
  setStatus?(status: { code: number; message?: string }): unknown;
  end(): void;
}

export interface SyncomTracer {
  startSpan?(name: string, options?: unknown): SyncomSpan;
  startActiveSpan?<T>(name: string, options: unknown, fn: (span: SyncomSpan) => T): T;
}

export interface SyncomCounter {
  add(value: number, attributes?: Record<string, unknown>): void;
}

export interface SyncomHistogram {
  record(value: number, attributes?: Record<string, unknown>): void;
}

export interface SyncomMeter {
  createCounter(name: string, options?: unknown): SyncomCounter;
  createHistogram(name: string, options?: unknown): SyncomHistogram;
}

export interface SyncomTelemetryApi {
  trace?: { getTracer(name: string, version?: string): SyncomTracer };
  metrics?: { getMeter(name: string, version?: string): SyncomMeter };
}

/**
 * Two injection modes. `{ api }` — the `@opentelemetry/api` module, from
 * which syncom derives its own tracer and meter so spans carry the
 * `@alexify/syncom` instrumentation scope. `{ tracer, meter }` — pre-built
 * instances; either alone is a supported configuration.
 *
 * With neither, telemetry is off and every recording path is a no-op.
 * syncom carries no trace context of its own: its spans nest under whatever
 * is active — wrpc's server span inside a `syncom/push` handler — through
 * the context manager the host installed.
 *
 * @experimental The writer shape, span names and metric set may change in a
 * minor release.
 */
export interface SyncomTelemetryOptions {
  api?: SyncomTelemetryApi;
  tracer?: SyncomTracer;
  meter?: SyncomMeter;
  /**
   * Default true. When false, record ids and peer urls/node ids are left off
   * spans. They are never metric labels at any setting.
   */
  includeIdentity?: boolean;
}

export type CrdtDelta = Record<string, unknown>;

export type CrdtHistoryRecord =
  | { type: 'write'; id?: string; timestamp?: number; data?: unknown }
  | { type: 'delta'; data: unknown }
  | { type: 'delete'; key?: string; id?: string; timestamp?: number }
  | { type: 'inc'; key: string; value: number }
  | { type: 'dec'; key: string; value: number };

export function diff(source: unknown, target: unknown): CrdtDelta;
export function merge(source: unknown, delta: unknown): unknown;
export function apply(
  source: unknown,
  history: readonly CrdtHistoryRecord[],
): unknown;

export interface Block<T = unknown> {
  prev: string;
  timestamp: number;
  data: T;
}

export interface ChainDataEntry {
  id: string;
  hash: string;
}

export function calculateHash(data: JSONSafe): string;

export interface Blockchain {
  readonly path: string;
  tailHash: string;

  writeChain(): Promise<void>;
  addBlock(data: unknown): Promise<string>;
  writeBlock(block: Block): Promise<string>;
  readBlock(hash: string): Promise<Block>;
  validate(options?: { last?: number; from?: string }): Promise<boolean>;
}

export interface BlockchainConstructor {
  readonly prototype: Blockchain;
  new (basePath: string): Promise<Blockchain>;
}

export const Blockchain: BlockchainConstructor;

export interface ContractContext {
  storage: Storage;
  chain: Blockchain;
}

export interface ContractBlock {
  type: 'smart contract';
  name: string;
  source: string;
}

export interface ErrorBlock {
  contract: string;
  args: unknown;
  error: string;
  timestamp: number;
}

export type ContractExecuteArgs = { id: string } & Record<string, unknown>;

export type ContractProcedure = (
  reader: DataReader,
  args: ContractExecuteArgs,
) => unknown | Promise<unknown>;

export class DataReader {
  constructor(storage: Storage);
  get(id: string): Promise<unknown>;
}

export class SmartContract {
  constructor(name: string, proc: ContractProcedure, context: ContractContext);
  readonly name: string;

  execute(args: ContractExecuteArgs): Promise<unknown>;

  static save(
    name: string,
    chain: Blockchain,
    proc: ContractProcedure,
  ): Promise<string>;
  static load(hash: string, context: ContractContext): Promise<SmartContract>;
}

// ---------------------------------------------------------------------------
// Schema (src/schema.js)

/** One problem a validator found: `path` from the record root, `code` as the library names it. */
export interface ValidationIssue {
  path: Array<string | number>;
  message: string;
  code?: string;
}

/**
 * What a write rejects with when the record would not pass its entity's
 * validator — nothing was stamped, logged or written. `entity` names the
 * collection, `issues` the problems; `cause` is set when the validator threw
 * something of its own.
 */
export class ValidationError extends Error {
  constructor(entity: string | null, issues: ValidationIssue[]);
  readonly name: 'ValidationError';
  readonly code: 'VALIDATION_FAILED';
  readonly entity: string | null;
  readonly issues: ValidationIssue[];
  cause?: unknown;
}

/**
 * How a schema object without `~standard` (JSON Schema, TypeBox, …) becomes
 * a validator: `compile(schema, { entity })` returns a function that gets
 * the record and returns the value to write (or `true`/`undefined` for "as
 * given"), returns `false` with its `errors` set (ajv), or throws. An Ajv
 * instance fits as it is.
 */
export interface SchemaValidator {
  compile(schema: unknown, meta: { entity: string }): (data: unknown) => unknown | Promise<unknown>;
}

/** One collection: what validates its records and what is indexed. `{}` is a bare collection. */
export interface EntityDefinition {
  /**
   * A Standard Schema (`~standard`: metaschema, zod, valibot, arktype), a
   * compiled validator function (ajv), or an object `open({ validator })`
   * compiles. The record is validated under `idField`, without `$type`, and
   * what the validator returns is what is written and replicated.
   */
  schema?: unknown;
  /**
   * The key the record id is handed to the validator under (and dropped
   * from its output); `false` passes no id. Default: `id` when the schema's
   * field map has it, metaschema's `<entityName>Id` when it has that, `false`
   * when it shows fields and has neither, `id` when it shows no fields.
   */
  idField?: string | false;
  /** Read the schema's indexes and fields, validate nothing (`@alexify/metaschema/definition`). */
  validate?: false;
  /** Fields with an equality index; read off the schema's `indexes`/`fields` when absent. */
  index?: readonly string[];
  /** Unique keys, single or composite; read off the schema when absent. */
  unique?: ReadonlyArray<string | readonly string[]>;
  /** Free-form field notes, kept as given. */
  fields?: { readonly [name: string]: unknown };
}

export type SchemaEntity = EntityDefinition;
export type SchemaEntities =
  | { readonly [entityName: string]: EntityDefinition }
  | Map<string, EntityDefinition>;

export interface MigrationContext {
  /** The record's `$type`, or `null` outside any collection. */
  entity: string | null;
  id: string;
  from: number;
  to: number;
}

/** One step of the up-chain: the record (without `$type`) as it was under `from`, returned as it is under `to`. */
export interface Migration {
  up(data: Record<string, unknown>, context: MigrationContext): Record<string, unknown> | Promise<Record<string, unknown>>;
  /** Reserved. */
  down?(data: Record<string, unknown>, context: MigrationContext): Record<string, unknown> | Promise<Record<string, unknown>>;
}

export interface Schema {
  /** A positive integer; default 1. */
  version?: number;
  entities?: SchemaEntities;
  /**
   * Keyed by the version each one migrates TO (`2` takes a record from 1 to
   * 2): a storage-wide migration, or one per entity. Run on read, for a
   * record of an older version, before the entity's validator.
   */
  migrations?: { [version: number]: Migration | { [entity: string]: Migration } };
  /**
   * An op from a newer schema version: `'apply'` (default) applies it as it
   * is, unvalidated; `'hold'` keeps it in the log until this node runs that
   * version (needs `sync.retention.ops` of 1000 or more).
   */
  ahead?: 'apply' | 'hold';
  /**
   * What lenses a record older than `version` on read: the migrations, the
   * entity's Standard Schema validator (aliases, defaults), or both (default).
   */
  lens?: 'migrations' | 'validate' | 'both';
  /**
   * Any JSON describing the schema (metaschema's `model.toJSON()`): hashed,
   * kept in `schema.json`, exchanged in hello — the same version with
   * another hash on a peer is reported as drift.
   */
  snapshot?: unknown;
}

/** What hello carries: a node's schema version and the hash of its snapshot (`null` without one). */
export interface SchemaInfo {
  version: number;
  hash: string | null;
}

/** `storage.schemaInfo`: the schema this node runs, and what `schema.json` held before this open when that differed. */
export interface SchemaStatus extends SchemaInfo {
  previous: SchemaInfo | null;
  /** Ops held for this version and applied at open (`replayed`), and held ops compaction had dropped (`lost`); `null` when none. */
  held: { replayed: number; lost: number } | null;
}

/** The peer whose whole state is about to be joined. */
export interface BootstrapContext {
  url: string;
  node: string;
}

/**
 * Hooks of the sync manager (`open({ sync: { hooks } })`). Same contract as
 * StorageHooks: awaited inside the operation, a throw becomes a HookError —
 * reported through the manager's `error` event on the dialing side.
 */
export interface SyncHooks {
  /**
   * Before a registered node is dialled; `node` is a copy of its registry
   * entry. Return `false` to leave it registered but not dialled.
   */
  beforeConnect?: (node: Node) => void | boolean | Promise<void | boolean>;
  /**
   * Before this node joins a peer's whole state (its log could not resume
   * us). Return `false` to refuse: the peer stays connected for pushes but
   * nothing is received from it until the next handshake asks again. There
   * is deliberately no hook on the ops that leave for a peer — seqs run
   * contiguously per origin and scope, so a withheld op is a gap that stops
   * every later op of that stream; per-peer visibility is what scopes do.
   */
  beforeBootstrap?: (peer: BootstrapContext) => void | boolean | Promise<void | boolean>;
}

export interface SyncOptions {
  /** Returns a link for a registry node; required to dial. */
  connect?: (node: Node) => SyncLink | Promise<SyncLink>;
  /** Dial on open — `true` when `connect` is given. */
  autoStart?: boolean;
  /** Ops per push page and per `changes` page (default 500). */
  pageSize?: number;
  /** Assigns a scope to a record; unscoped (`'*'`) records reach every peer. */
  scope?: (id: string, data: Record<string, unknown>) => string;
  retention?: { ops?: number; days?: number };
  log?: { rollAfter?: number };
  /** Lifecycle hooks — see SyncHooks. */
  hooks?: SyncHooks;
}

/** What a write hook sees: the op being made, and the record it lands on. */
export interface WriteContext {
  type: Exclude<SyncOpType, 'advance'>;
  id: string;
  /** The whole record for `write`, the delta for `set`, the joined data for `merge`. */
  data?: Record<string, unknown>;
  /** `inc` only. */
  key?: string;
  /** `inc` only. */
  value?: number;
  /** `merge` only: the metadata being joined. */
  meta?: EntryMeta;
  /** The record before the write — `null` when absent or deleted. Read-only. */
  current: Record<string, unknown> | null;
  /** Sealed for this node: the write is encrypted, or the record already is. */
  encrypted: boolean;
  /** The Record whose `save()` this is, or `null`. */
  source: SyncomRecord | null;
  /** The link a `merge` came in on; `null` for a local write. */
  via: unknown;
  /** The peer a `merge` came from; `null` for a local write. */
  from: string | null;
  /** This node's schema version, stamped on the op; `null` without a schema. */
  v: number | null;
}

export interface ReadContext {
  id: string;
}

/** What a remote op faces before it is applied here. */
export interface ApplyContext {
  op: SyncOp;
  /** The link the op arrived on. */
  via: unknown;
  /** Who sent it — `url` is `null` when this node is the host. */
  peer: PeerRef | null;
  /** The record before the op — `null` when absent or deleted. Read-only. */
  current: Record<string, unknown> | null;
}

export interface PeerRef {
  url: string | null;
  node: string;
}

/** One `applyRemote` call, after its batch is durable. */
export interface ApplyBatchContext extends ApplyRemoteResult {
  via: unknown;
  peer: PeerRef | null;
  /** Every accepted op — the skipped ones included. */
  ops: SyncOp[];
}

/**
 * Hooks run INSIDE the storage's operations: awaited, one function per
 * name, able to alter the operation or abort it by throwing (the operation
 * then rejects with a HookError). They also run inside the mutation queue,
 * so a hook that awaits holds every other write, and a write issued from a
 * hook is refused. Events (`on`) are the contained, observe-only alternative.
 */
export interface StorageHooks {
  /**
   * Before a local write is stamped and applied. Return a plain object to
   * replace `data` (`write` and `set` only); throw to refuse the write —
   * nothing is stamped, logged or written.
   */
  beforeWrite?: (context: WriteContext) => void | Record<string, unknown> | Promise<void | Record<string, unknown>>;
  /**
   * After the write is durable — `op` is the op it became, `null` for an
   * encrypted (local) write. Not called when the write changed nothing. A
   * throw fails the call, but the op stays committed and announced.
   */
  afterWrite?: (context: WriteContext, op: SyncOp | null) => void | Promise<void>;
  /** Before `get(id)` reads; throw to refuse the read. */
  beforeRead?: (context: ReadContext) => void | Promise<void>;
  /**
   * After `get(id)` read. Return anything but `undefined` (including `null`)
   * to replace what the caller sees; the record itself is untouched, and
   * `swap`, `snapshot` and `getCachedData` keep reading the raw data.
   */
  afterRead?: (context: ReadContext, data: unknown) => unknown | Promise<unknown>;
  /**
   * Before a peer's op is applied. Return `false` to skip it: the op is
   * still logged and relayed (the vector must move, or the peer would offer
   * it forever), only this node's record is left alone. A throw aborts the
   * whole batch before anything is persisted.
   */
  beforeApply?: (context: ApplyContext) => void | boolean | Promise<void | boolean>;
  /** After a batch is durable; a throw fails the call, the batch stays. */
  afterApply?: (context: ApplyBatchContext) => void | Promise<void>;
}

export interface StorageOptions<S extends Schema = Schema> {
  path?: string;
  name?: string;
  schema?: S;
  /** Compiles entity schemas that are plain objects without `~standard`. */
  validator?: SchemaValidator;
  getId?: () => string | Promise<string>;
  logger?: Logger | false;
  sync?: SyncOptions;
  /** Encrypt every record at rest by default (records then stay local). */
  encrypted?: boolean;
  /** Injected OpenTelemetry — see SyncomTelemetryOptions. */
  telemetry?: SyncomTelemetryOptions;
  /** Lifecycle hooks — see StorageHooks. */
  hooks?: StorageHooks;
}

// The collections a schema turns into properties on the storage object:
// `open({ schema: { entities: { Post: {} } } })` yields `storage.Post`. A
// `Map` of entities is opaque to the type system and adds nothing.
export type Collections<S extends Schema> = S['entities'] extends Map<string, SchemaEntity>
  ? {}
  : S['entities'] extends { readonly [entityName: string]: SchemaEntity }
    ? { readonly [K in keyof S['entities'] & string]: SyncomCollection }
    : {};

export interface StorageDataOptions {
  encrypted?: boolean;
}

export interface StorageEntry {
  data: unknown;
  /** The replication bookkeeping; `null` for an encrypted (local) record. */
  meta: EntryMeta | null;
  encrypted: boolean;
  timestamp: number;
  block: string;
}

export interface Node {
  url: string;
  token?: string;
  scopes: string[];
  enabled: boolean;
  lastSync: number | null;
  /** Where the subscription resumes from; `null` until the first page. */
  cursor: string | null;
  /** What the last hello learned; `null` before the first. */
  remote: { id: string; epoch: string; schema: SchemaInfo | null } | null;
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
}

export interface SyncUnitOptions {
  /** wrpc's access level for the four procedures (default `'session'`). */
  access?: string;
  /** Gates a peer by whatever the transport presented, and by what hello says. */
  authorize?: (
    context: unknown,
    hello: { node: string; vector?: VersionVector; scopes?: string[]; token?: string; schema?: SchemaInfo | null },
  ) => boolean | Promise<boolean>;
  /** How a `changes` value is labelled with its position (wrpc's tracked shape by default). */
  tracked?: (id: string, data: unknown) => unknown;
  pageSize?: number;
  pageBytes?: number;
}

export interface SyncProcedure {
  access: string;
  handler: (...args: any[]) => unknown;
}

/** What a host mounts: `defineRouter({ syncom: storage.sync.unit() })`. */
export interface SyncUnit {
  hello: SyncProcedure;
  push: SyncProcedure;
  snapshot: SyncProcedure;
  changes: SyncProcedure;
}

/** The events a SyncManager emits; listeners are contained. */
export interface SyncEvents {
  /** A link came up (with the host's node id and schema after hello), went down, or came back. */
  peer: (event: { url: string; connected: boolean; node?: string; reconnected?: boolean; schema?: SchemaInfo | null }) => void;
  /** A push went out (`pushed`) or a page came in (`received` and the apply result). */
  sync: (event: {
    url: string;
    pushed?: number;
    received?: number;
    applied?: number;
    skipped?: number;
    duplicates?: number;
    gaps?: number;
  }) => void;
  bootstrap: (event: { url: string; records: number }) => void;
  /** A failure on the way to a peer; `url` names it. */
  error: (error: Error & { url: string }) => void;
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
  on<E extends keyof SyncEvents>(event: E, listener: SyncEvents[E]): void;
  once<E extends keyof SyncEvents>(event: E, listener: SyncEvents[E]): void;
  off<E extends keyof SyncEvents>(event: E, listener?: SyncEvents[E]): void;
  listenerCount(event: keyof SyncEvents): number;
  addNode(nodeData: NodeData): Promise<void>;
  removeNode(url: string): Promise<void>;
  enableNode(url: string, enabled?: boolean): Promise<void>;
  listNodes(): Node[];
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Pushes whatever the connected peers (or one) lack right now. */
  sync(url?: string): Promise<Array<{ url: string; pushed: number }>>;
  peers(): PeerView[];
  unit(options?: SyncUnitOptions): SyncUnit;
}

export interface SyncManagerConstructor {
  readonly prototype: SyncManager;
  new (storage: Storage, options?: SyncOptions): Promise<SyncManager>;
}

export const SyncManager: SyncManagerConstructor;

/** The structural check on an injected link: call/subscribe/on/off/close. */
export function isSyncLink(value: unknown): value is SyncLink;

/**
 * What the sync engine needs from a transport. Reconnecting, backing off and
 * resuming the subscription from its last event id are the link's job — a
 * WrpcClient does all three; `@alexify/syncom/wrpc` wraps one into this.
 */
export interface SyncLink {
  call(method: string, args: unknown): Promise<unknown>;
  subscribe(
    method: string,
    args: unknown,
    handlers: {
      lastEventId?: string;
      onData?: (value: unknown, eventId?: string) => void | Promise<void>;
      onError?: (error: Error & { code?: number }) => void;
      onEnd?: () => void;
    },
  ): { unsubscribe(): void; readonly lastEventId?: string };
  /** Binary-capable transports: the chunks of a streamed snapshot page. */
  stream?(id: string): AsyncIterable<Uint8Array | string>;
  on(event: 'open' | 'close' | 'reconnect', listener: (...args: unknown[]) => void): void;
  off(event: 'open' | 'close' | 'reconnect', listener: (...args: unknown[]) => void): void;
  close(): void;
}

export interface SnapshotPage {
  records: Array<Entry & { id: string }>;
  cursor: string | null;
  eventId: string;
  vector: VersionVector;
}

export interface ApplyRemoteResult {
  /** Accepted ops — the skipped ones included; they moved the vector too. */
  applied: number;
  /** Accepted but not applied here: a beforeApply hook returned `false`. */
  skipped: number;
  duplicates: number;
  gaps: number;
}

/** The events a Storage emits; listeners are contained. */
export interface StorageEvents {
  /** Every op applied here — local (`via` null) or from a peer (`via` = the link). */
  change: (op: SyncOp, via: unknown) => void;
  /**
   * A peer's op refused by the register/counter rule (`rejected`), or skipped
   * because the record would not pass its entity's validator (`entity`,
   * `issues`).
   */
  error: (
    error: Error & {
      op?: SyncOp;
      rejected?: Array<{ field: string; reason: 'register' | 'counter' }>;
      entity?: string;
      issues?: ValidationIssue[];
    },
  ) => void;
  /** A peer's batch is durable. */
  apply: (batch: ApplyBatchContext) => void;
  /**
   * `drift`: a peer runs this node's schema version with another snapshot
   * hash — two builds of "the same" schema that disagree. Reported after
   * hello on both sides; the link stays up. `ahead`: a peer's op is from a
   * newer version — applied as it is (`held` false) or held (`held` true).
   */
  schema: (
    event:
      | { kind: 'drift'; peer: PeerRef; version: number; hash: string; local: string }
      | { kind: 'ahead'; op: SyncOp; held: boolean },
  ) => void;
  close: () => void;
}

export interface RecordEvents {
  /** A staged assignment, or the record changing in storage (`null` once deleted). */
  update: (data: unknown, delta: unknown) => void;
}

export interface Storage {
  readonly schema: Schema | null;
  /** The schema version and snapshot hash this node runs, with `previous` when `schema.json` differed; `null` without a schema. */
  readonly schemaInfo: SchemaStatus | null;
  readonly sync: SyncManager;
  readonly nodeId: string;
  readonly path: string;
  readonly log: OpLog;
  readonly vector: VersionVector;
  /**
   * The telemetry writer built from `options.telemetry`. Opaque on purpose:
   * its shape is an implementation detail.
   * @experimental
   */
  readonly telemetry: unknown;

  on<E extends keyof StorageEvents>(event: E, listener: StorageEvents[E]): void;
  once<E extends keyof StorageEvents>(event: E, listener: StorageEvents[E]): void;
  off<E extends keyof StorageEvents>(event: E, listener?: StorageEvents[E]): void;
  listenerCount(event: keyof StorageEvents): number;

  saveData(
    id: string,
    data: unknown,
    options?: StorageDataOptions,
  ): Promise<void>;
  loadData(id: string): Promise<unknown | null>;
  validate(options?: { last?: number; from?: string }): Promise<boolean>;
  validate(id: string, data: unknown, blockHash: string): Promise<boolean>;
  insert(data: unknown, options?: StorageDataOptions): Promise<string>;
  has(id: string): Promise<boolean>;
  get(id: string): Promise<unknown>;
  set(id: string, data: unknown, options?: StorageDataOptions): Promise<void>;
  delete(id: string): Promise<void>;
  update(id: string, delta: unknown): Promise<void>;
  inc(id: string, key: string, value?: number): Promise<void>;
  swap(id: string, changes: unknown, prev: unknown): Promise<boolean>;
  list(): Promise<string[]>;
  /**
   * Runs `data` through an entity's validator the way a write would and
   * returns what it gives back (defaults filled, aliases resolved); rejects
   * with a ValidationError. Nothing is written.
   */
  check(entity: string, data: unknown): Promise<unknown>;
  /**
   * Rewrites every record of an older schema version as this one, through
   * the lens — a whole-record write of the view, the counters added back.
   * Idempotent; `entities` limits it to those collections.
   */
  migrate(options?: { entities?: readonly string[]; batch?: number }): Promise<{ migrated: number; counters: number }>;
  record(id: string): Promise<Storage.StorageRecord>;
  getCachedData(id: string): unknown | null;
  hasRecord(id: string): boolean;
  applyRemote(
    ops: readonly SyncOp[],
    options?: { via?: unknown; scopes?: readonly string[] | null; peer?: PeerRef | null },
  ): Promise<ApplyRemoteResult>;
  adoptVector(vector: VersionVector, options?: { via?: unknown; from?: string }): Promise<SyncOp | null>;
  snapshot(options?: { cursor?: string | null; limit?: number; scopes?: readonly string[] | null }): Promise<SnapshotPage>;
  mergeSnapshot(records: readonly (Entry & { id: string })[], options?: { via?: unknown; from?: string }): Promise<void>;
  close(): Promise<void>;
}

// A string field whose value is a known record id reads back as a Reference.
export interface Reference {
  record(): Promise<SyncomRecord>;
}

export interface SyncomRecord {
  readonly id: string;
  on<E extends keyof RecordEvents>(event: E, listener: RecordEvents[E]): void;
  once<E extends keyof RecordEvents>(event: E, listener: RecordEvents[E]): void;
  off<E extends keyof RecordEvents>(event: E, listener?: RecordEvents[E]): void;
  data(): Promise<unknown>;
  delta(): Record<string, unknown>;
  save(): Promise<void>;
  inc(key: string, value?: number): Promise<void>;
  delete(): Promise<void>;
  // Live properties: one getter/setter per field of the loaded object.
  [field: string]: unknown;
}

declare class SyncomCollection {
  constructor(storage: Storage, name: string);
  readonly name: string;
  insert(data: unknown): Promise<SyncomRecord>;
  get(id: string): Promise<unknown | null>;
  /** Replaces the record wholesale, stamped as this collection's. */
  set(id: string, data: unknown, options?: StorageDataOptions): Promise<void>;
  delete(id: string): Promise<void>;
  /** Sets the listed fields; `$type` may not be among them. */
  update(id: string, delta: unknown): Promise<void>;
  record(id: string): Promise<SyncomRecord>;
}

declare const SyncomRecordCtor: {
  readonly prototype: SyncomRecord;
  new (id: string, storage: Storage): Promise<SyncomRecord>;
};

export interface StorageConstructor {
  readonly prototype: Storage;
  new <S extends Schema = Schema>(options?: StorageOptions<S>): Promise<Storage & Collections<S>>;
  Collection: typeof SyncomCollection;
  Record: typeof SyncomRecordCtor;
  // The default `getId` — synchronous in both halves, unlike the crypto three.
  generateId(): string;
}

export const Storage: StorageConstructor;

export namespace Storage {
  export type StorageRecord = SyncomRecord;
  export type StorageCollection = SyncomCollection;
}

export function open<S extends Schema = Schema>(options?: StorageOptions<S>): Promise<Storage & Collections<S>>;
