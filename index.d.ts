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
}

export interface EntryMeta {
  clock: { [field: string]: ClockStamp };
  base: ClockStamp | null;
  deleted: ClockStamp | null;
  counters: { [field: string]: { [origin: string]: readonly [number, number, number] } };
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
  append(ops: readonly SyncOp[]): Promise<LogEntry[]>;
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

export type SchemaEntity = { readonly [fieldName: string]: unknown };
export type SchemaEntities =
  | { readonly [entityName: string]: SchemaEntity }
  | Map<string, SchemaEntity>;

export interface Schema {
  entities?: SchemaEntities;
  readonly [key: string]: unknown;
}

export interface SyncOptions {
  /** Assigns a scope to a record; unscoped (`'*'`) records reach every peer. */
  scope?: (id: string, data: Record<string, unknown>) => string;
  retention?: { ops?: number; days?: number };
  log?: { rollAfter?: number };
}

export interface StorageOptions<S extends Schema = Schema> {
  path?: string;
  name?: string;
  schema?: S;
  getId?: () => string | Promise<string>;
  logger?: Logger | false;
  sync?: SyncOptions;
  /** Encrypt every record at rest by default (records then stay local). */
  encrypted?: boolean;
  /** Injected OpenTelemetry — see SyncomTelemetryOptions. */
  telemetry?: SyncomTelemetryOptions;
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
}

export interface NodeData {
  url: string;
  token?: string;
  scopes?: string[];
}

export interface SyncManager {
  readonly storage: Storage;
  addNode(nodeData: NodeData): Promise<void>;
  removeNode(url: string): Promise<void>;
  listNodes(): Node[];
  start(): Promise<void>;
  stop(): Promise<void>;
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
  applied: number;
  duplicates: number;
  gaps: number;
}

export interface Storage {
  readonly schema: Schema | null;
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

  /** Every op applied here — local (`via` null) or from a peer (`via` = the link). */
  on(event: 'change', listener: (op: SyncOp, via: unknown) => void): void;
  on(event: 'error', listener: (error: Error & { op?: SyncOp }) => void): void;
  off(event: 'change' | 'error', listener?: (...args: unknown[]) => void): void;

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
  record(id: string): Promise<Storage.StorageRecord>;
  getCachedData(id: string): unknown | null;
  hasRecord(id: string): boolean;
  applyRemote(
    ops: readonly SyncOp[],
    options?: { via?: unknown; scopes?: readonly string[] | null },
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
  on(event: 'update', listener: (data: unknown, delta: unknown) => void): void;
  once(event: 'update', listener: (data: unknown, delta: unknown) => void): void;
  off(event: 'update', listener?: (data: unknown, delta: unknown) => void): void;
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
  delete(id: string): Promise<void>;
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
