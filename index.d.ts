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
export function loadKeys(basePath: string, options?: { fsi?: Fsi }): Promise<KeyPair>;

/** The Ed25519 pair that signs a node's ops; `id` is the raw public key, base64url — the node id. */
export interface SigningKeyPair extends KeyPair {
  readonly id: string;
}

export function generateSigningKeys(): Promise<SigningKeyPair>;
/** `sign-public.pem` and `sign-private.pem` under `basePath`: read, or made and written. */
export function loadSigningKeys(basePath: string, options?: { fsi?: Fsi }): Promise<SigningKeyPair>;
/** Signs `message` (UTF-8) with a PEM Ed25519 private key: 64 bytes, base64url. */
export function sign(message: string, privateKey: string): string;
/**
 * Whether `signature` is `publicKey`'s — a node id, the raw key base64url —
 * over `message`; `false`, never a throw, for a malformed key or signature.
 */
export function verify(message: string, signature: string, publicKey: string): boolean;

// ---------------------------------------------------------------------------
// Backends (src/backend.js, src/fsi.js, src/fsi.browser.js)

/**
 * The storage backend: five functions over "a directory and a file name".
 * `node:fs` and OPFS are the defaults; `@alexify/syncom/idb` and
 * `createMemoryFsi()` are two more; anything with these functions fits
 * `open({ fsi })`.
 */
export interface Fsi {
  read(dir: string, filename: string): Promise<string>;
  /**
   * Creates the directory. `options.mode` is a hint for a backend with file
   * permissions (the private key asks for owner-only); the others ignore it.
   */
  write(dir: string, filename: string, content: string, options?: { mode?: number }): Promise<void>;
  exists(dir: string, filename: string): Promise<boolean>;
  /** A no-op when the file is absent. */
  remove(dir: string, filename: string): Promise<void>;
  /** File names, sorted; an absent directory is an empty listing. */
  list(dir: string): Promise<string[]>;
  /** fsync, where the backend has one; what `open({ durable: true })` calls after every write. */
  sync?(dir: string, filename: string): Promise<void>;
  /** Exclusive create — rejects with `code: 'EEXIST'` when the file is there; what the directory lock uses when present. */
  create?(dir: string, filename: string, content: string): Promise<void>;
}

/** Whether `value` has the five functions of the backend contract. */
export function isFsi(value: unknown): value is Fsi;

/** A backend in memory — shared by every storage opened over it, gone with the process. */
export function createMemoryFsi(): Fsi & { readonly size: number; dump(): Record<string, string> };

// The platform's own backend, as functions.
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

export type SyncOpType = 'write' | 'set' | 'inc' | 'add' | 'remove' | 'delete' | 'merge' | 'advance' | 'purge';

/** What a `remove` carries per element: the element and, per origin, the newest add ts the remover had observed. */
export type SetRemoval = readonly [element: unknown, tags: { readonly [origin: string]: number }];

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
  /** `inc`, `add`, `remove`: the field. */
  key?: string;
  /** `inc`: the amount added; `add`: the elements; `remove`: the elements with the tags the remover observed. */
  value?: number | readonly unknown[] | readonly SetRemoval[];
  /** The schema version of the node that made it; absent without a schema, and on `merge`/`advance`. */
  v?: number;
  /** Who made it — `open({ actor })` or the write's own; a claim the origin signed, not a proof of identity. Absent on `merge`/`advance`. */
  actor?: string;
  /** The origin's Ed25519 signature over the header and `digest` (base64url); absent under `sync.signatures: false` and on ops of older peers. */
  sig?: string;
  /** SHA-256 of the payload (`data`, `meta`, `key`, `value`, `vector`) in canonical JSON, salted with `nonce`; stays after a purge scrubbed the payload. */
  digest?: string;
  /** The digest's salt; scrubbed with the payload. */
  nonce?: string;
}

export interface EntryMeta {
  clock: { [field: string]: ClockStamp };
  base: ClockStamp | null;
  deleted: ClockStamp | null;
  counters: { [field: string]: { [origin: string]: readonly [number, number, number] } };
  /**
   * An observed-remove set per field: per element (its JSON text), per origin,
   * the ts of that origin's newest `add` and the newest add ts a `remove` had
   * observed (0 = none); the element is live for the origin while the first
   * is the greater.
   */
  sets: { [field: string]: { [elementKey: string]: { [origin: string]: readonly [number, number] } } };
  /** The schema version of the last whole-record write (or of the `set` that created the entry). */
  v?: number;
  /** The stamp of a `purge`: the record is gone for good, whatever lands later. */
  purged?: ClockStamp | null;
}

export interface Entry {
  data: Record<string, unknown>;
  meta: EntryMeta;
}

export interface ApplyResult {
  entry: Entry;
  changed: boolean;
  delta: Record<string, unknown>;
  rejected: Array<{ field: string; reason: FieldKind }>;
}

/** What a field is, once written: a register (last writer wins), a counter (`inc`) or a set (`add`/`remove`). */
export type FieldKind = 'register' | 'counter' | 'set';

/**
 * The codes a SyncomError carries — one constant per thing that can go
 * wrong at run time, documented under each operation in the API reference.
 */
export type SyncomErrorCode =
  | 'CLOSED'
  | 'IN_HOOK'
  | 'NOT_FOUND'
  | 'FIELD_KIND'
  | 'ENCRYPTED'
  | 'INTEGRITY'
  | 'CORRUPT'
  | 'DOWNGRADE'
  | 'LOCKED'
  | 'KEYS_INCOMPLETE'
  | 'IDENTITY_MISMATCH'
  | 'BAD_SIGNATURE'
  | 'UNSIGNED'
  | 'BAD_ENVELOPE'
  | 'BLOCK_NOT_FOUND'
  | 'NOT_CONTRACT'
  | 'NODE_EXISTS'
  | 'NODE_NOT_FOUND'
  | 'BAD_HELLO'
  | 'HANDSHAKE_LOOP'
  | 'PAGE_FAILED'
  | 'STUCK'
  | 'STREAMS_UNSUPPORTED'
  | 'UNRECOVERABLE'
  | 'SKEW'
  | 'OP_UNREADABLE'
  | 'OP_REFUSED'
  | 'OP_INVALID'
  | 'HOOK_FAILED'
  | 'VALIDATION_FAILED';

/**
 * What syncom rejects with when an operation cannot be done — as opposed to
 * a `TypeError`, which is a wrong argument, option or hook result and carries
 * no code (except `INVALID_ID`, `TYPE_IMMUTABLE` and `NO_CHAIN`, whose value
 * is data or configuration). `code` is one constant; the fields the code
 * documents (`op`, `cursor`, `rejected`…) ride on the error, `cause` is the
 * underlying one. A host's wire refusal is not one of these: it is a plain
 * `Error` with the numeric `code` the transport carries and a `reason`.
 */
export class SyncomError extends Error {
  constructor(code: SyncomErrorCode, message: string, fields?: { cause?: unknown; [field: string]: unknown });
  readonly name: string;
  readonly code: SyncomErrorCode;
  cause?: unknown;
}

/**
 * Thrown (rejected) by the operation a hook belongs to when that hook threw.
 * `hook` names it, `cause` is the original error; the operation itself is
 * described by the hook's documentation — a `before*` hook aborts it, an
 * `after*` hook fails the call while what it observed stays committed.
 */
export class HookError extends SyncomError {
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
  /** The payload was scrubbed (a purge): `data`, `meta`, `key` and `value` are gone. */
  scrubbed?: true;
}

export interface OpLogOptions {
  rollAfter?: number;
  retention?: { ops?: number; days?: number };
  logger?: Logger | false;
  telemetry?: SyncomTelemetryOptions;
  fsi?: Fsi;
  /**
   * Seal only the batches the owner has marked `applied`: what Storage asks
   * for, so a reopen's replay always covers a batch whose records may not
   * have been written. A log on its own seals everything.
   */
  sealApplied?: boolean;
  /** Told after every seal: what was sealed and dropped, and where the floor is. */
  onRoll?: (roll: { sealed: number; dropped: number; floor: number; segments: number }) => void;
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
  /** Strips the payload of every entry of `id`, in memory and on disk; resolves to how many. */
  scrub(id: string): Promise<number>;
  /**
   * The entries after `eventId` in `scopes` (all, or the first `limit`), and
   * `last`: the seq of the last entry examined, in scope or not — where a
   * reader's cursor may move so an entry of another scope is looked at once.
   * `null` when the position cannot be resumed (another epoch, compacted past).
   */
  read(
    eventId: string | null | undefined,
    options?: { scopes?: readonly string[] | null; limit?: number },
  ): { entries: LogEntry[]; last: number | null } | null;
  /** `read(...).entries`, or null when the position cannot be resumed. */
  since(eventId: string | null | undefined, options?: { scopes?: readonly string[] | null; limit?: number }): LogEntry[] | null;
  /** Every retained entry of the record `id`, oldest first — what `Storage.repair()` rebuilds from. */
  entriesOf(id: string): LogEntry[];
  advance(vector: VersionVector): Promise<void>;
  tail(): LogEntry[];
  flush(): Promise<void>;
  close(): Promise<void>;
  /** The batches within `from..to` are reflected in the records (see `sealApplied`). */
  applied(from: number, to?: number): void;
  /** One key of the vector (`origin` or `origin@scope`), without copying the whole. */
  seqOf(key: string): number;
  /** How many ops the log keeps at least (`retention.ops`); `Infinity` when no count bounds it. */
  readonly retainedOps: number;
  /** Sealed segments on disk. */
  readonly segments: number;
  /** The newest stamp this log has held since it was opened — what the clock is seeded from. */
  readonly latestTs: number;
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
  new (basePath: string, options?: { fsi?: Fsi }): Promise<Blockchain>;
}

export const Blockchain: BlockchainConstructor;

// Smart contracts live in the `@alexify/syncom/contracts` subpath (contracts.d.ts).

// ---------------------------------------------------------------------------
// Schema (src/schema.js)

/** One problem a validator found: `path` from the record root, `code` as the library names it. */
export interface ValidationIssue {
  path: Array<string | number>;
  message: string;
  code?: string;
  /** `code: 'unique'`: the id already holding the key (`path` lists its fields). */
  conflict?: string;
}

/**
 * What a write rejects with when the record would not pass its entity's
 * validator — nothing was stamped, logged or written. `entity` names the
 * collection, `issues` the problems; `cause` is set when the validator threw
 * something of its own.
 */
export class ValidationError extends SyncomError {
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
  /**
   * How far ahead of this node's clock a peer's stamp may be, in
   * milliseconds (default 24 hours; `Infinity` disables). Beyond it the op is
   * refused as malformed rather than observed into the clock.
   */
  maxSkew?: number;
  /**
   * Signed ops. `'verify'` (the default): this node signs its ops; a peer's
   * op that carries a signature is verified and refused when it does not
   * check against its origin, an unsigned one is accepted. `'require'`:
   * unsigned ops, and ops whose origin is no signing key, are refused too —
   * the one mode that resists a relay stripping signatures. `false`: nothing
   * is signed or verified. The node id is the signing key in every mode.
   */
  signatures?: 'verify' | 'require' | false;
  /**
   * Ops queued for one peer beyond this (default 10 000) are dropped and the
   * peer is marked `behind`; the vector-based push that recovers it carries
   * what it lacks.
   */
  maxOutbox?: number;
  /** Lifecycle hooks — see SyncHooks. */
  hooks?: SyncHooks;
  /** Reserved for the broker-backed hub mode; refused in this version. See SharedLog. */
  sharedLog?: never;
}

/** What a write hook sees: the op being made, and the record it lands on. */
export interface WriteContext {
  type: Exclude<SyncOpType, 'advance'>;
  id: string;
  /** The whole record for `write`, the delta for `set`, the joined data for `merge`. */
  data?: Record<string, unknown>;
  /** `inc`, `add`, `remove`: the field. */
  key?: string;
  /** `inc`: the amount; `add`/`remove`: the elements, as the caller gave them. */
  value?: number | readonly unknown[];
  /** `merge` only: the metadata being joined. */
  meta?: EntryMeta;
  /** The record before the write — `null` when absent or deleted. Read-only. */
  current: Record<string, unknown> | null;
  /** Sealed for this node: the write is encrypted, or the record already is. */
  encrypted: boolean;
  /** The Record whose `save()` this is, or `null`. */
  source: SyncomRecord | null;
  /** The link a `merge` came in on; `null` for a local write. */
  via: PeerRef | null;
  /** The peer a `merge` came from; `null` for a local write. */
  from: string | null;
  /** This node's schema version, stamped on the op; `null` without a schema. */
  v: number | null;
  /** The actor the op will carry; `null` when none. */
  actor: string | null;
}

export interface ReadContext {
  id: string;
}

/** What a remote op faces before it is applied here. */
export interface ApplyContext {
  op: SyncOp;
  /** The link the op arrived on. */
  via: PeerRef | null;
  /** Who sent it — `url` is `null` when this node is the host. */
  peer: PeerRef | null;
  /** The record before the op — `null` when absent or deleted. Read-only. */
  current: Record<string, unknown> | null;
}

/** A peer, by url (null on the hosting side) and node id (null until its hello answered). */
export interface PeerRef {
  url: string | null;
  node: string | null;
}

/** The lockfile's knobs: `open({ lock: { mode, staleAfter, poll, timeout } })`. */
export interface LockOptions {
  mode?: 'fail' | 'wait';
  /** A lockfile whose process cannot be checked is stale after this many ms (default 30 minutes). */
  staleAfter?: number;
  /** How often `'wait'` looks again, in ms (default 100). */
  poll?: number;
  /** How long `'wait'` waits before `LOCKED`, in ms (default forever). */
  timeout?: number;
}

/** What `storage.stats()` answers — every number from memory, no I/O. */
export interface StorageStats {
  closed: boolean;
  /** Writes waiting on, or running in, the mutation queue. */
  queue: number;
  cache: { size: number; max: number; pinned: number };
  /** Rows, tombstones included, and the puts since the last save. */
  catalog: { entries: number; dirty: number };
  log: { length: number; floor: number; next: number; epoch: string; segments: number; latestTs: number };
  chain: { tail: string } | null;
  lock: { mode: 'fail' | 'wait' } | null;
}

/** Hosting side: a peer with a live `changes` feed on this node. */
export interface HostedPeer {
  node: string;
  /** The scopes the feed serves; `null` for every scope. */
  scopes: string[] | null;
  since: number;
  cursor: string | null;
}

/** One `applyRemote` call, after its batch is durable. */
export interface ApplyBatchContext extends ApplyRemoteResult {
  via: PeerRef | null;
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
  /** The backend; the platform's (`node:fs`, OPFS) when absent. */
  fsi?: Fsi;
  /** Call the backend's `sync` after every write (fsync). A backend without one logs at debug and is as durable as it is. */
  durable?: boolean;
  /**
   * One instance per directory: `'fail'` (default) rejects `open()` with
   * `code: 'LOCKED'` while another holds it, `'wait'` waits for it, `false`
   * leaves the coordination to the caller. Web Locks in the browser, a
   * `lock.json` with the pid otherwise (stale when its process is gone).
   */
  lock?: 'fail' | 'wait' | false | LockOptions;
  /** The listener cap of the storage and its sync manager (default 100); exceeding it throws. */
  maxListeners?: number;
  /** The in-memory entry cache: the last `max` records read or written (default 5000); a live Record pins its own. */
  cache?: { max?: number };
  /** `'verify'` (default) re-checks a record against its chain block on a cold read; `'lazy'` trusts the file. */
  integrity?: 'verify' | 'lazy';
  /**
   * `false` keeps no hash-linked chain of what this node applied (a hub that
   * only replicates has nothing to audit): two file writes less per record,
   * reads lazy, and `validate()` rejects with `code: 'NO_CHAIN'`.
   */
  chain?: boolean;
  /**
   * The record catalog is persisted at close and, in between, every `flushEvery` changes (default 64) while it is
   * small, every sixteenth of its size as it grows, never more than half the log's `retention.ops` apart; the log
   * catches up the rest on the next open.
   */
  catalog?: { flushEvery?: number };
  schema?: S;
  /** Compiles entity schemas that are plain objects without `~standard`. */
  validator?: SchemaValidator;
  /** Who writes — stamped on every op as `actor`: a string, or a function asked per write. */
  actor?: string | (() => string | Promise<string>);
  /**
   * Mints record ids. An id is a file name on every platform: letters,
   * digits, `.`, `_`, `-`, `@`, not starting with a dot, 128 characters at
   * most — anything else is refused with `code: 'INVALID_ID'`.
   */
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
  /** The actor of this write, over `open({ actor })`. */
  actor?: string;
}

export interface WriteOptions {
  actor?: string;
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
  /**
   * Gates a peer by whatever the transport presented, and by what hello says.
   * The `scopes` hello carries are what the peer may then write (`push`) and
   * read (`snapshot`, `changes`) here.
   */
  authorize?: (
    context: unknown,
    hello: { node: string; vector?: VersionVector; scopes?: string[]; token?: string; schema?: SchemaInfo | null },
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

/**
 * @experimental Reserved: the contract of a log shared by several hub
 * processes, for a hub mode after this version — structurally wrpc's
 * `BrokerLog`, so a broker's `.log` fits with no adapter.
 */
export interface SharedLogEntry {
  id: string;
  value: string;
  headers: Record<string, string>;
}

export interface SharedLogRead extends AsyncIterable<SharedLogEntry> {
  readonly ready: Promise<void>;
}

export interface SharedLog {
  name?: string;
  append(topic: string, value: string | Uint8Array, options?: { headers?: Record<string, string>; key?: string }): Promise<string>;
  read(topic: string, options?: { after?: string | null; from?: 'latest' | 'earliest'; signal?: AbortSignal | null }): SharedLogRead;
  parseId(text: unknown): string | null;
}

/** Whether `value` has the three functions of the shared-log contract. */
export function isSharedLog(value: unknown): value is SharedLog;

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
    malformed?: number;
    unsigned?: number;
    forged?: number;
  }) => void;
  bootstrap: (event: { url: string; records: number }) => void;
  /** Hosting side: ops of a peer this node would not take — outside the scopes its hello granted. */
  refused: (event: { node: string; reason: 'scope'; count: number }) => void;
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
  /**
   * Refused before anything read them, neither logged nor relayed: not the
   * shape of an op (origin, seq, ts, type, a valid record id or an advance
   * vector), or a stamp beyond `sync.maxSkew` ahead of this node's clock.
   */
  malformed: number;
  /** Refused under `sync.signatures: 'require'` for carrying no signature, or an origin that is no key; neither logged nor relayed. */
  unsigned: number;
  /** Refused for a signature that does not verify against the origin, or a payload its digest does not match; neither logged nor relayed. */
  forged: number;
}

/** The events a Storage emits; listeners are contained. */
export interface StorageEvents {
  /** Every op applied here — local (`via` null) or from a peer (`via` names it). */
  change: (op: SyncOp, via: PeerRef | null) => void;
  /** The log sealed a segment (and maybe dropped old ones): `floor` is where a resume is still possible. */
  log: (event: { kind: 'roll'; sealed: number; dropped: number; floor: number; segments: number }) => void;
  /**
   * A peer's op refused by the field-kind rule (`OP_REFUSED`,
   * `rejected`), skipped because the record would not pass its entity's
   * validator (`OP_INVALID`, `entity`, `issues`), refused for a stamp
   * beyond `sync.maxSkew` (`SKEW`), or refused for its signature — once per
   * page, `op` the first refused and `count` how many (`BAD_SIGNATURE`,
   * `UNSIGNED`).
   */
  error: (
    error: SyncomError & {
      code: 'OP_REFUSED' | 'OP_INVALID' | 'OP_UNREADABLE' | 'SKEW' | 'BAD_SIGNATURE' | 'UNSIGNED';
      op: SyncOp;
      count?: number;
      rejected?: Array<{ field: string; reason: FieldKind }>;
      entity?: string | null;
      issues?: ValidationIssue[];
    },
  ) => void;
  /** A peer's batch is durable. */
  apply: (batch: ApplyBatchContext) => void;
  /**
   * A peer's op left a unique key shared by two records: `id` (the op's)
   * and `other`. Both are kept — the application decides which yields.
   */
  conflict: (event: { kind: 'unique'; entity: string; fields: string[]; id: string; other: string; op: SyncOp }) => void;
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
  /** The backend every file goes through — the adapter given to `open()` (wrapped when `durable`), or the platform's. */
  readonly fsi: Fsi;
  readonly schema: Schema | null;
  /** The schema version and snapshot hash this node runs, with `previous` when `schema.json` differed; `null` without a schema. */
  readonly schemaInfo: SchemaStatus | null;
  readonly sync: SyncManager;
  readonly nodeId: string;
  /** `open({ sync: { signatures } })`: `'verify'`, `'require'` or `false`. */
  readonly signatures: 'verify' | 'require' | false;
  readonly path: string;
  readonly log: OpLog;
  readonly vector: VersionVector;
  /** The writer built from `open({ logger })`: every level a function, `false` silenced it. */
  readonly logger: Logger;
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
  listeners<E extends keyof StorageEvents>(event: E): StorageEvents[E][];
  eventNames(): (keyof StorageEvents)[];
  /** Resolves with the next emission's first argument. */
  toPromise<E extends keyof StorageEvents>(event: E): Promise<Parameters<StorageEvents[E]>[0]>;
  /** Drops every listener of `event`, or of every event. */
  clear(event?: keyof StorageEvents): void;

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
  /** The record as it reads (the lens applied, the read hooks run), as a copy: editing it changes nothing. */
  get(id: string): Promise<unknown>;
  set(id: string, data: unknown, options?: StorageDataOptions): Promise<void>;
  delete(id: string, options?: WriteOptions): Promise<void>;
  /** Forgets the record for good: a `purge` op no later write revives, and a scrub of its entries from the log — here and on every peer it reaches. */
  purge(id: string, options?: WriteOptions): Promise<void>;
  update(id: string, delta: unknown, options?: WriteOptions): Promise<void>;
  inc(id: string, key: string, value?: number, options?: WriteOptions): Promise<void>;
  /**
   * Adds `elements` to set field `key` — an observed-remove set: two nodes
   * that add concurrently both keep theirs, and an add a remove did not
   * observe survives it. Elements are JSON values, told apart by their text;
   * the set reads sorted by that text. Creates the field, and the record,
   * when absent.
   */
  add(id: string, key: string, elements: readonly unknown[], options?: WriteOptions): Promise<void>;
  /** Removes from set field `key` the `elements` this node has seen added; one it never saw is left alone. */
  remove(id: string, key: string, elements: readonly unknown[], options?: WriteOptions): Promise<void>;
  /**
   * Compare-and-swap: writes `changes` only if every field of `prev` still
   * holds its value, compared inside the mutation queue — two concurrent
   * swaps on one expectation cannot both pass. `false`, and no write, on a
   * mismatch; rejects when the record is absent.
   */
  swap(id: string, changes: object, prev: object, options?: WriteOptions): Promise<boolean>;
  /**
   * Rebuilds the record from what the log holds of it — a file that fails
   * its integrity check, or is torn: the retained entries replayed from the
   * first whole-record op (`write`, `merge`, `delete`, `purge`), written with
   * a chain block of its own. Rejects with `UNRECOVERABLE` when the log holds
   * no such op (compacted away, never written here, encrypted). `ops` is how
   * many entries went in.
   */
  repair(id: string): Promise<{ ops: number; alive: boolean }>;
  /** Every live id, sorted — from the catalog, no I/O. */
  list(): Promise<string[]>;
  /**
   * Runs `data` through an entity's validator the way a write would and
   * returns what it gives back (defaults filled, aliases resolved); rejects
   * with a ValidationError. Nothing is written.
   */
  check(entity: string, data: unknown): Promise<unknown>;
  /**
   * Rewrites every record of an older schema version as this one, through
   * the lens — a whole-record write of the view, the counters and the sets
   * added back (a set with nothing live is dropped). Idempotent; `entities`
   * limits it to those collections.
   */
  migrate(options?: {
    entities?: readonly string[];
    batch?: number;
    actor?: string;
  }): Promise<{ migrated: number; counters: number; sets: number }>;
  record(id: string): Promise<Storage.StorageRecord>;
  /** The raw data of a cached entry (no lens), `null` when not cached, absent or deleted. */
  getCachedData(id: string): unknown | null;
  /** Whether `id` is a live record here — from the catalog, no I/O. */
  hasRecord(id: string): boolean;
  /** The node's health as an operator reads it — queue, cache, catalog, log, chain, lock. No I/O. */
  stats(): StorageStats;
  /**
   * `adoptFrom`: the node id whose own `advance` ops may move this node's
   * vector — the host a subscription is read from. Absent, an `advance` is
   * logged and relayed but grants nothing.
   */
  applyRemote(
    ops: readonly SyncOp[],
    options?: { via?: PeerRef | null; scopes?: readonly string[] | null; peer?: PeerRef | null; adoptFrom?: string | null },
  ): Promise<ApplyRemoteResult>;
  adoptVector(vector: VersionVector, options?: { via?: PeerRef | null; from?: string }): Promise<SyncOp | null>;
  snapshot(options?: { cursor?: string | null; limit?: number; scopes?: readonly string[] | null }): Promise<SnapshotPage>;
  mergeSnapshot(records: readonly (Entry & { id: string })[], options?: { via?: PeerRef | null; from?: string }): Promise<void>;
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Queries (src/query.js)

export interface MangoOperators {
  $eq?: unknown;
  $ne?: unknown;
  $in?: readonly unknown[];
  $nin?: readonly unknown[];
  $gt?: number | string | boolean;
  $gte?: number | string | boolean;
  $lt?: number | string | boolean;
  $lte?: number | string | boolean;
  $exists?: boolean;
  $regex?: RegExp | string;
  $options?: string;
}

/**
 * `{ field: value }` is equality (a dotted path reaches into the record; an
 * array field holds a scalar value), `{ field: { $op } }` the operators,
 * `$and`/`$or` arrays of queries, `$not` one.
 */
export type MangoQuery = {
  [field: string]: unknown;
  $and?: readonly MangoQuery[];
  $or?: readonly MangoQuery[];
  $not?: MangoQuery;
};

/** A row a cursor yields: the record as it reads, under its `id`. */
export type QueryRow = Record<string, unknown> & { id: string };

export interface Cursor<T = QueryRow> {
  order(field: string): this;
  desc(field: string): this;
  limit(n: number): this;
  offset(n: number): this;
  /** A predicate over the loaded row; a cursor with one always reads the records. */
  filter(fn: (row: T) => boolean): this;
  /** The fields each row carries (plus `id`); a dotted field comes back under its dotted name. */
  projection(fields: readonly string[]): this;
  fetch(): Promise<T[]>;
  count(): Promise<number>;
  one(): Promise<T | null>;
  /** Runs now and after every change to the collection (coalesced); returns the stop function. */
  watch(listener: (rows: T[]) => void, options?: { onError?: (error: Error) => void }): () => void;
  [Symbol.asyncIterator](): AsyncIterator<T>;
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
  listenerCount(event: keyof RecordEvents): number;
  listeners<E extends keyof RecordEvents>(event: E): RecordEvents[E][];
  eventNames(): (keyof RecordEvents)[];
  toPromise<E extends keyof RecordEvents>(event: E): Promise<Parameters<RecordEvents[E]>[0]>;
  clear(event?: keyof RecordEvents): void;
  data(): Promise<unknown>;
  delta(): Record<string, unknown>;
  save(options?: WriteOptions): Promise<void>;
  inc(key: string, value?: number, options?: WriteOptions): Promise<void>;
  /** Adds to a set field — `storage.add` with this record's id. */
  add(key: string, elements: readonly unknown[], options?: WriteOptions): Promise<void>;
  /** Removes from a set field — `storage.remove` with this record's id. */
  remove(key: string, elements: readonly unknown[], options?: WriteOptions): Promise<void>;
  delete(options?: WriteOptions): Promise<void>;
  // Live properties: one getter/setter per field of the loaded object.
  [field: string]: unknown;
}

export declare class SyncomCollection {
  constructor(storage: Storage, name: string);
  readonly name: string;
  insert(data: unknown, options?: StorageDataOptions): Promise<SyncomRecord>;
  get(id: string): Promise<unknown | null>;
  /** A cursor over this collection — see Cursor. */
  select(query?: MangoQuery): Cursor;
  count(query?: MangoQuery): Promise<number>;
  /** Replaces the record wholesale, stamped as this collection's. */
  set(id: string, data: unknown, options?: StorageDataOptions): Promise<void>;
  delete(id: string, options?: WriteOptions): Promise<void>;
  /** Sets the listed fields; `$type` may not be among them. */
  update(id: string, delta: unknown, options?: WriteOptions): Promise<void>;
  record(id: string): Promise<SyncomRecord>;
}

export declare const SyncomRecordCtor: {
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
