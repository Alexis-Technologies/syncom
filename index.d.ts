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

// The key functions — generateKeys/encrypt/decrypt/loadKeys, the signing
// pair, sign/verify — are the `@alexify/syncom/encryption` and
// `@alexify/syncom/signing` subpaths'; the core keeps the PEM pair shape.

// ---------------------------------------------------------------------------
// Backends (src/backend.js, src/fsi.js, src/fsi.browser.js)

/**
 * The storage backend: five functions over "a directory and a file name".
 * `node:fs` and OPFS are the defaults; `@alexify/syncom/idb`, `@alexify/syncom/memory`
 * and `@alexify/syncom/layered` are more; anything with these functions fits
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

export type SyncOpType =
  | 'write'
  | 'set'
  | 'inc'
  | 'unset'
  | 'add'
  | 'remove'
  | 'splice'
  | 'assign'
  | 'move'
  | 'mark'
  | 'tree'
  | 'delete'
  | 'merge'
  | 'advance'
  | 'purge';

/** What a `remove` carries per element: the element and, per origin, the newest add ts the remover had observed. */
export type SetRemoval = readonly [element: unknown, tags: { readonly [origin: string]: number }];

/**
 * What a `splice` carries: the ranges to cut (`[run, offset, length]`), and
 * either the anchor of a new run (`at`: `^` the head, `>e`/`<e` the right or
 * left child of element `e`) or the run of the writer to extend (`run`,
 * `from`). `content` names the kind — a string for a text, an array for a
 * list — and is empty when the op only cuts.
 */
export interface SplicePayload {
  cut?: readonly (readonly [run: string, offset: number, length: number])[];
  at?: string;
  run?: string;
  from?: number;
  content: string | readonly unknown[];
}

/** What an `assign` carries: a list element by name and its new value. */
export interface AssignPayload {
  elem: string;
  value: unknown;
}

/**
 * What a `move` carries: the element, the slot it showed at (cut), the
 * anchor of its new one-element position run, and its value for that run.
 */
export interface MovePayload {
  elem: string;
  cut: readonly [run: string, offset: number, length: 1];
  at: string;
  value: unknown;
}

/** How a style behaves under text typed at its edges. */
export type MarkExpand = 'before' | 'after' | 'both' | 'none';

/**
 * What a `mark` carries: the anchors of the range — an element and a side
 * (`<e`, `>e`), the head `^` or the end `$` — the style's name and value
 * (`null` removes it), `many` for a mark that stacks; or `off`, the id of a
 * mark to switch off.
 */
export interface MarkPayload {
  start?: string;
  end?: string;
  key?: string;
  value?: unknown;
  many?: true;
  off?: string;
}

/**
 * What a `tree` op carries: the node, its new parent (`null`: a root,
 * `'$trash'`: removed) and its place among the siblings — a fractional
 * index (`@alexify/syncom/order`), ties broken by stamp.
 */
export interface TreePayload {
  node: string;
  parent: string | null;
  fi: string;
}

/** A node of a tree field as it reads: its id and its children, in order. */
export interface TreeNode {
  id: string;
  children: TreeNode[];
}

/**
 * A tree field's block (src/tree.js): per node the moves made of it, each
 * `[ts, origin, parent, fi]`, in stamp order. The field reads as the fold of
 * every move in stamp order, a move that would put a node under itself
 * skipped (Kleppmann et al., 2021).
 */
export interface TreeBlock {
  k: 'tree';
  /** The newest stamp the block holds. */
  ts: number;
  moves: { [node: string]: readonly (readonly [ts: number, origin: string, parent: string | null, fi: string])[] };
}

/** Which side of its slot a cursor keeps to. */
export type CursorSide = 'before' | 'after';

/** A run of equal style in a text: `marks` per name, a `many` name listing every mark. */
export interface TextSpan {
  text: string;
  marks: { [name: string]: unknown | readonly { id: string; value: unknown }[] };
}

/**
 * A list or text field's block (src/sequence.js): the runs by key
 * (`ts:origin`) as `[anchor, content, element?]`, with content run-length
 * encoded — present items (a string or an array) alternating with gap
 * lengths (tombstones); pending cuts and extensions; a movable list's
 * position and value registers; a text's marks.
 */
export interface SequenceBlock {
  k: 'l' | 't';
  /** The newest stamp the block holds. */
  ts: number;
  runs: { [run: string]: readonly [at: string, content: readonly (string | number | readonly unknown[])[], elem?: string] };
  cuts?: { [run: string]: readonly (readonly [offset: number, length: number])[] };
  ext?: { [run: string]: readonly (readonly [from: number, content: string | readonly unknown[]])[] };
  pos?: { [elem: string]: readonly [ts: number, origin: string, run: string] };
  vals?: { [elem: string]: readonly [ts: number, origin: string, value: unknown] };
  marks?: { [mark: string]: readonly [start: string, end: string, key: string, value: unknown, flags: number] };
}

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
  value?:
    | number
    | readonly unknown[]
    | readonly SetRemoval[]
    | SplicePayload
    | AssignPayload
    | MovePayload
    | MarkPayload
    | TreePayload;
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
  /** A field of a plugin's kind — a list or a text (SequenceBlock), a tree (TreeBlock) — by field; `k` names the kind, `ts` the newest stamp the block holds. */
  blocks: { [field: string]: SequenceBlock | TreeBlock };
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
  rejected: Refusal[];
}

/** What a field is, once written: a register (last writer wins), a counter (`inc`), a set (`add`/`remove`), a list, a text or a tree. */
export type FieldKind = 'register' | 'counter' | 'set' | 'list' | 'text' | 'tree';
/**
 * Why a field of an op was refused: another kind holds the field; work past
 * a bound of a list or text field, or a counter's sum past the safe range
 * (`'bound'`); a payload the engine does not admit (`'malformed'` — a
 * TypeError on the local path).
 */
export type RefusalReason = FieldKind | 'bound' | 'malformed' | 'kind';
/** One refused field: for `'bound'`, which bound (`detail`), the count and the limit; for `'kind'`, the plugin the op needed (`kind`). */
export interface Refusal {
  field: string | null;
  reason: RefusalReason;
  kind?: string;
  detail?: 'pending' | 'run' | 'field' | 'counter';
  count?: number;
  max?: number;
}

/**
 * The codes a SyncomError carries — one constant per thing that can go
 * wrong at run time, documented under each operation in the API reference.
 */
export type SyncomErrorCode =
  | 'CLOSED'
  | 'IN_HOOK'
  | 'NOT_FOUND'
  | 'FIELD_KIND'
  | 'OUT_OF_RANGE'
  | 'CYCLE'
  | 'SURROGATE'
  | 'HISTORY_GONE'
  | 'INVALID_VERSION'
  | 'TAG_EXISTS'
  | 'TAG_NOT_FOUND'
  | 'BRANCH_EXISTS'
  | 'ENCRYPTED'
  | 'INTEGRITY'
  | 'CORRUPT'
  | 'DOWNGRADE'
  | 'LOCKED'
  | 'KEYS_INCOMPLETE'
  | 'DECRYPT_FAILED'
  | 'IDENTITY_MISMATCH'
  | 'KINDS_MISMATCH'
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
  | 'UNPERSISTED'
  | 'REWOUND'
  | 'UNDELIVERABLE'
  | 'SKEW'
  | 'OP_UNREADABLE'
  | 'OP_REFUSED'
  | 'OP_INVALID'
  | 'HOOK_FAILED'
  | 'VALIDATION_FAILED';

/**
 * What syncom rejects with when an operation cannot be done — as opposed to
 * a `TypeError`, which is a wrong argument, option or hook result and carries
 * no code (except `INVALID_ID`, `TYPE_IMMUTABLE`, `INVALID_VERSION`,
 * `NO_CHAIN` and `PLUGIN_MISSING`, whose value is data or configuration). `code` is one constant; the fields the code
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

/** The node's bounds for a fold: `pendingMax`, a list or text field's pending work (`sync.pendingMax`), and `plugins`, the registry whose kinds the ops may be of (the core's alone when absent). */
export interface FoldLimits {
  pendingMax?: number;
  plugins?: Plugins;
}
export function applyOp(entry: Entry | null, op: SyncOp, limits?: FoldLimits | null): ApplyResult;
export function mergeEntry(a: Entry | null, b: Entry | null, limits?: FoldLimits | null): Entry | null;
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
  telemetry?: SyncomTelemetryOptions | SyncomTelemetryWriter;
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
  /** How many readers hold segments through `pin()`. */
  readonly pins: number;
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
  /**
   * Entries compaction must not drop, whatever the retention: the segment
   * holding one `keep` answers true for stays. A node that dials keeps its
   * own ops until every node it syncs with has them. `null` clears it.
   */
  retain(keep: ((entry: LogEntry) => boolean) | null): void;
  /**
   * Like `retain`, for a reader of the past: the entries `keep` answers true
   * for stay, with their segment and everything after it, until the returned
   * function is called. Pins add up; `retain` stays the sync manager's.
   */
  pin(keep: (entry: LogEntry) => boolean): () => void;
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
  /**
   * The newest stamp among the ops the log no longer holds (compacted, or
   * unreadable at open); 0 while nothing was ever dropped. A record's past is
   * whole from a reset stamped above it.
   */
  readonly droppedTs: number;
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

/**
 * The writer the engine records through: what the telemetry plugin builds
 * from `SyncomTelemetryOptions`, and what `open({ telemetry })` takes as it
 * is without the plugin. `enabled` false is the frozen disabled writer, whose
 * `withSpan` still runs its callback.
 */
export interface SyncomTelemetryWriter {
  readonly enabled: boolean;
  withSpan<T>(name: string, attributes: Record<string, unknown>, fn: (handle: unknown) => T): T;
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

// The chain — `Block`, `Blockchain`, the plugin — is the `@alexify/syncom/chain`
// subpath (src/chain/chain.d.ts); smart contracts are `@alexify/syncom/contracts`.

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
  /**
   * The fields `$text` searches (dotted paths; string values and the string
   * elements of arrays, as the record reads). Needs `open({ search })`:
   * `createSearch()` from `@alexify/syncom/search`, or a `TextIndex` of your
   * own. Changing them rebuilds the catalog once.
   */
  search?: readonly string[];
}

/**
 * What `open({ search })` hands back per searchable entity: the catalog puts
 * the joined text of a record's `search` fields on every write (and replays
 * every row at open), removes it when the record goes, and asks `query` for
 * every match, best first, when a cursor carries `$text`. Postings live in
 * memory only; the catalog persists the text.
 */
export interface TextIndex {
  put(id: string, text: string): void;
  remove(id: string): void;
  query(text: string): ReadonlyArray<{ id: string; score: number }>;
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
  /** Ops per push page (default 500); `snapshot` and `changes` pages are `unit({ pageSize })`'s. */
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
   * How much pending work a list or text field takes from ops that ran
   * ahead of what they depend on — runs waiting for their anchor, cuts and
   * extensions for their run, registers and switched-off marks for elements
   * not here — before an op is refused (`OP_REFUSED`, reason `'bound'`) and
   * a snapshot block is dropped. 4096 by default; a refusal is final on this
   * node, so a mesh with several hosts raises it rather than lowers it.
   * `Infinity` disables the bound.
   */
  pendingMax?: number;
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
  /** `inc`, `add`, `remove`, `splice`, `assign`, `move`, `mark`, `tree`: the field. */
  key?: string;
  /** `inc`: the amount; `add`/`remove`: the elements, as the caller gave them. */
  value?: number | readonly unknown[];
  /** A `remove` from `applyPatches()`: exactly these tags revoked… */
  removals?: readonly SetRemoval[];
  /** …or this node's adds of the elements alone (an undo). */
  own?: true;
  /**
   * `splice`: the index (`null`: the end), how many to remove and what to
   * insert; `assign`: the index and the value; `move`: the index (`from`)
   * and `to` — as the caller gave them.
   */
  index?: number | null;
  count?: number;
  content?: string | readonly unknown[];
  to?: number;
  /** `mark`: the range, the style name, the expand rule and whether the mark stacks; or the id switched off. */
  start?: number;
  end?: number;
  name?: string;
  expand?: MarkExpand;
  many?: boolean;
  off?: string;
  /** `tree`: the node, its parent (`null` a root, `'$trash'` removed) and the sibling it goes after or before — as the caller gave them. */
  node?: string;
  parent?: string | null;
  after?: string;
  before?: string;
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
  /** `get(id, { at })`: the version asked for, as the caller gave it; `history()`: each version's event id. */
  at?: Version;
  /** `history()`: the one `beforeRead` before the versions are read. */
  history?: true;
}

/**
 * A version of a record: an event id of this node's log (the record as this
 * node held it after that entry), a stamp — a number or a Date — (every op
 * stamped at or below it), a version vector (every op it covers), or a tag.
 */
export type Version = string | number | Date | { vector: VersionVector } | { tag: string };

/** One op of a record's past and the record after it. */
export interface HistoryVersion {
  eventId: string;
  seq: number;
  ts: number;
  origin: string;
  actor: string | null;
  type: SyncOpType;
  /** The fields the op changed (removed ones included). */
  fields: string[];
  /** The record as it read after the op, through the lens and `afterRead`; `null` once deleted or when the content is scrubbed. */
  data: unknown;
  /** The op's payload is gone (a purge). */
  scrubbed?: true;
}

export interface HistoryResult {
  /** Newest first. */
  versions: HistoryVersion[];
  /** The list reaches the first op this node applied to the record: nothing dropped by compaction, nothing cut by `limit`. */
  complete: boolean;
  /** The versions are what this node held; false once compaction took something a retained op still depends on. */
  exact: boolean;
}

/**
 * What turns one state of a record into another, in the terms of the write
 * API — what `diff()` hands out and `applyPatches()` realizes as ops.
 */
export type Patch =
  | { action: 'put'; field: string; value: unknown }
  | { action: 'unset'; field: string }
  | { action: 'write'; data: Record<string, unknown> }
  | { action: 'inc'; field: string; value: number }
  | { action: 'add'; field: string; elements: readonly unknown[] }
  | { action: 'remove'; field: string; elements: readonly unknown[]; own?: true }
  | { action: 'remove'; field: string; removals: readonly SetRemoval[] }
  | { action: 'splice'; field: string; index: number; count?: number; content?: string | readonly unknown[] }
  | {
      action: 'mark';
      field: string;
      start: number;
      end: number;
      name: string;
      value: unknown;
      expand?: MarkExpand;
      many?: true;
    }
  | { action: 'treeMove'; field: string; node: string; parent?: string | null; after?: string; before?: string }
  | { action: 'treeRemove'; field: string; node: string }
  | { action: 'delete' }
  | { action: 'purge' };

/** What a local commit leaves for a listener: the op, its log seq, the record before and after, every field's kind. */
export interface CommitEvent {
  op: SyncOp;
  seq: number;
  /** The Record whose `save()` this was, or the `source` `applyPatches()` was given; `null` otherwise. */
  source: unknown;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  kinds: { [field: string]: FieldKind };
}

/** A named version of the whole storage, kept on this node: the log position it was taken at. */
export interface Tag {
  name: string;
  eventId: string;
  seq: number;
  /** The newest stamp the log held when the tag was taken. */
  ts: number;
  vector: VersionVector;
  createdAt: number;
}

/** A collection as it was at a tag: queries over the tag's catalog, reading the records as they were. */
export interface TagCollection {
  readonly name: string;
  /** The record as it was, or `null` when it was not there or is of another collection. */
  get(id: string): Promise<unknown | null>;
  /** A cursor at the tag; `watch()` on it throws — a tag does not change; `$text` is not available. */
  select(query?: MangoQuery): Cursor;
  count(query?: MangoQuery): Promise<number>;
}

/**
 * The storage as it was at a tag. The tag's catalog is read at the view's
 * first read (an open reads the newest tag's alone); a reader of a tag whose
 * catalog is gone is told `TAG_NOT_FOUND` then.
 */
export interface TagView extends Tag {
  /** The record as it was at the tag, through the lens and the read hooks (`at: { tag }`); `null` when it was not there. */
  get(id: string): Promise<unknown>;
  /** Whether `id` was a live record at the tag. */
  has(id: string): Promise<boolean>;
  /** Every live id at the tag, sorted. */
  list(): Promise<string[]>;
  /** A collection at the tag; throws for an entity the schema has not. */
  collection(name: string): TagCollection;
  /** One page of the storage as it was at the tag — what another storage's `mergeSnapshot` joins to stand at the tag. */
  snapshot(options?: { cursor?: string | null; limit?: number; scopes?: readonly string[] | null }): Promise<SnapshotPage>;
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
  log: {
    length: number;
    floor: number;
    next: number;
    epoch: string;
    segments: number;
    latestTs: number;
    droppedTs: number;
    /** Readers holding segments past retention: undo managers, mostly. */
    pins: number;
  };
  /** The tags held; `corrupt` when `tags.json` could not be read at open (no tags, `tag()` refused until it is repaired). */
  /** The tags kept here; `null` without the `versions` plugin. */
  tags: { count: number; corrupt: boolean } | null;
  /** Records whose files lag the log: held after a write that failed (replayed at the next open), or deferred by `open({ defer })`. */
  held: number;
  deferred: number;
  /** Local writes appended but not yet on disk — the queue is free from the append, the caller waits for the landing. */
  inflight: number;
  chain: { tail: string } | null;
  lock: { mode: 'fail' | 'wait' } | null;
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
   * Record files may lag the log by this many ms (16, a frame, by default;
   * 0: never). The log is durable at once, every read sees the write, a
   * crash replays the batch at the next open, `flush()`, `tag()` and
   * `close()` land the files first; the writes of one record within the
   * window coalesce into one file and one block.
   */
  defer?: number;
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
  /** The text index behind `$text`, one per searchable entity — `createSearch()` from `@alexify/syncom/search`. */
  search?: (entity: string) => TextIndex;
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
  telemetry?: SyncomTelemetryOptions | SyncomTelemetryWriter;
  /** Lifecycle hooks — see StorageHooks. */
  hooks?: StorageHooks;
  /**
   * The plugins this storage runs with — `text` from `@alexify/syncom/text`,
   * `tree` from `/tree`… Registered per storage, never process-wide; a method
   * of a plugin not given here throws `PLUGIN_MISSING` naming the subpath.
   */
  plugins?: readonly Plugin<any>[];
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
  /**
   * This node's own streams as far as the peer is known to hold them
   * (`origin` / `origin@scope` → seq): what the log keeps its own ops for.
   */
  acked?: VersionVector;
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

/** The structural check on an injected link: call/subscribe/on/off/close. */
export function isSyncLink(value: unknown): value is SyncLink;

export interface OutboundOptions {
  /** The receiver's node id: its own ops, and the merges made from its snapshot, are left out. */
  exclude: string;
  /** What the receiver holds. */
  vector: VersionVector;
  /** The scopes to select in; `null` (default) is every scope. */
  scopes?: string[] | null;
  /** The sender's node id: `first` reports its own streams… */
  own: string;
  /** …or every origin's (a branch merge). */
  allStreams?: boolean;
}

/**
 * What `log` has that a receiver lacks, by its version vector — the
 * selection a push and a branch merge make — and `first`, the first seq the
 * log retains per stream (`origin` / `origin@scope`): a receiver behind one
 * cannot be caught up from here. With `applyRemote()` on the other side,
 * the updates API of a transport of the application's own, no `sync` plugin
 * needed.
 */
export function outbound(log: OpLog, options: OutboundOptions): { ops: SyncOp[]; first: Record<string, number> };
/**
 * How two version vectors stand: -1 behind, 1 ahead, 0 equal, undefined
 * when concurrent (each ahead somewhere); a key one side lacks reads as 0.
 */
export function compareVectors(a: VersionVector, b: VersionVector): -1 | 0 | 1 | undefined;

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
  /**
   * Accepted but not applied here: a beforeApply hook returned `false`, the
   * record would not pass its entity's validator, its file could not be read,
   * it is sealed for this node, or the op waits for a newer schema version.
   */
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
  /**
   * Refused under `bound` (a host's push): the record the op writes is
   * outside the pushing peer's scopes, before the op or after it, as this
   * node's `sync.scope` reads it; neither logged nor relayed.
   */
  outOfScope: number;
}

/** The events a Storage emits; listeners are contained. */
export interface StorageEvents {
  /** Every op applied here — local (`via` null) or from a peer (`via` names it). */
  change: (op: SyncOp, via: PeerRef | null) => void;
  /** A local op is durable: what it changed, as copies — built only when someone listens. */
  commit: (event: CommitEvent) => void;
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
    error:
      | (SyncomError & {
          code: 'OP_REFUSED' | 'OP_INVALID' | 'OP_UNREADABLE' | 'SKEW' | 'BAD_SIGNATURE' | 'UNSIGNED';
          op: SyncOp;
          count?: number;
          rejected?: Refusal[];
          entity?: string | null;
          issues?: ValidationIssue[];
        })
      /** Records logged but not written — held in memory until they land (see Health). */
      | (SyncomError & { code: 'UNPERSISTED'; ids: string[] }),
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

// ---------------------------------------------------------------------------
// Plugins (src/plugin.js)

/**
 * A plugin module, registered per storage with `open({ plugins })` — never
 * process-wide. A kind module (`text` from `@alexify/syncom/text`, `tree`
 * from `/tree`) brings field kinds, how their ops apply and the storage
 * methods of its API; an API module brings methods and hooks over the core.
 * `Api` is the methods the plugin adds to the storage: a compile-time
 * shape, what `open()` intersects into its result.
 */
export interface Plugin<Api = {}> {
  readonly name: string;
  /** Phantom: the storage methods the plugin adds. Never read at run time. */
  readonly api?: Api;
}

/** The registry `createPlugins()` builds — frozen, per storage: the names registered and every kind's rank in the precedence. */
export interface Plugins {
  readonly names: readonly string[];
  readonly rank: { readonly [kind: string]: number };
}

/** Builds a registry from plugin modules; throws a TypeError naming what a module got wrong. */
export function createPlugins(modules: readonly Plugin<any>[]): Plugins;

type UnionToIntersection<U> = (U extends unknown ? (x: U) => void : never) extends (x: infer I) => void ? I : never;
/** The methods the plugins of `P` add to a storage, intersected. */
export type PluginMethods<P extends readonly Plugin<any>[]> = UnionToIntersection<
  P[number] extends Plugin<infer A> ? A : never
>;

/** The storage methods the `text` plugin adds: lists and texts that merge by position (Fugue), marks, cursors. */
export interface TextMethods {
  /**
   * Splices list or text field `key` at `index`: removes `count` elements
   * and inserts `content` — an array for a list, a string for a text — in
   * their place. The first write decides the kind; elements merge by
   * position (Fugue), each writer's run whole. Creates the field, and the
   * record, when absent; rejects with `OUT_OF_RANGE` past the length.
   */
  splice(
    id: string,
    key: string,
    index: number,
    count?: number,
    content?: string | readonly unknown[],
    options?: WriteOptions,
  ): Promise<void>;
  /** Appends `content` to list or text field `key` — a splice at the end. */
  push(id: string, key: string, content: string | readonly unknown[], options?: WriteOptions): Promise<void>;
  /**
   * Makes text field `key` read as `text`: diffed inside the mutation queue
   * (Myers), one `splice` per hunk, last first, in one turn of the queue.
   * Resolves to how many ops it took.
   */
  updateText(id: string, key: string, text: string, options?: WriteOptions): Promise<number>;
  /**
   * Marks visible range `[start, end)` of text field `key` with `name: value`.
   * `expand` says whether text typed at the edges takes the style ('after'
   * by default); per name the newest mark wins; `many` makes it stack with
   * every other of its name, removable only by id. Resolves to the mark's id.
   */
  mark(
    id: string,
    key: string,
    start: number,
    end: number,
    name: string,
    value: unknown,
    options?: WriteOptions & { expand?: MarkExpand; many?: boolean },
  ): Promise<string | null>;
  /** Removes a style over `[start, end)` by name (under the reversed expand rule). */
  unmark(
    id: string,
    key: string,
    start: number,
    end: number,
    name: string,
    options?: WriteOptions & { expand?: MarkExpand },
  ): Promise<void>;
  /** Switches one mark off by its id (what `mark()` resolved to) — the only way for a `many` mark. */
  unmarkById(id: string, key: string, markId: string, options?: WriteOptions): Promise<void>;
  /** Text field `key` as runs of equal style; raw (no lens, no read hooks); `null` unless the field is a text. */
  spans(id: string, key: string): Promise<TextSpan[] | null>;
  /**
   * A cursor into list or text field `key`: a place that survives edits
   * around it — before the element at `index`, or after the one before it.
   * `null` out of range or when the field is not a list or a text.
   */
  cursor(id: string, key: string, index: number, options?: { side?: CursorSide }): Promise<string | null>;
  /** Where `cursor` is now; `null` once its place is gone. */
  index(id: string, key: string, cursor: string): Promise<number | null>;
  /**
   * Replaces the element at `index` of list field `key`: a register per
   * element, last writer wins, following the element through a concurrent move.
   */
  setAt(id: string, key: string, index: number, value: unknown, options?: WriteOptions): Promise<void>;
  /**
   * Moves the element at `from` of list field `key` to `to`, its index once
   * it is out. Two nodes moving one element concurrently leave it once, at
   * the newer move's place; a move concurrent with a removal brings it back.
   */
  move(id: string, key: string, from: number, to: number, options?: WriteOptions): Promise<void>;
}

/** The storage methods the `tree` plugin adds: a movable tree per field. */
export interface TreeMethods {
  /**
   * Puts node `node` of tree field `key` under `parent` (`null`: a root),
   * after sibling `after`, before sibling `before`, or last. Creates the
   * node, the field and the record when absent. Two nodes moving
   * concurrently so that each would hang under the other: the newer move
   * loses, on every node. Rejects with `CYCLE` for a parent under the node
   * and `NOT_FOUND` for a sibling not under `parent`; no op when the node
   * is already there.
   */
  treeMove(
    id: string,
    key: string,
    node: string,
    parent?: string | null,
    options?: WriteOptions & { after?: string; before?: string },
  ): Promise<void>;
  /** Removes node `node` of tree field `key` with everything under it — a move under the trash. */
  treeRemove(id: string, key: string, node: string, options?: WriteOptions): Promise<void>;
}

export interface Storage {
  /** The backend every file goes through — the adapter given to `open()` (wrapped when `durable`), or the platform's. */
  readonly fsi: Fsi;
  readonly schema: Schema | null;
  /** The schema version and snapshot hash this node runs, with `previous` when `schema.json` differed; `null` without a schema. */
  readonly schemaInfo: SchemaStatus | null;
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
  /**
   * The record as it reads (the lens applied, the read hooks run), as a
   * copy: editing it changes nothing. With `at`, the record at that version
   * — folded from the log, or a tag's copy: rejects with `HISTORY_GONE`
   * when the log cannot give it exactly, `INVALID_VERSION` for a malformed
   * `at` or a seq this log has not reached, `TAG_NOT_FOUND`, `ENCRYPTED`
   * for an encrypted record's history.
   */
  get(id: string, options?: { at?: Version }): Promise<unknown>;
  /**
   * The record's past as this node's log holds it, newest first — one
   * version per op this node applied, with the record as it read after it.
   */
  history(id: string, options?: { limit?: number; before?: string }): Promise<HistoryResult>;
  /**
   * Names the storage as it is now. A tag is kept on this node — the
   * catalog of the moment plus a copy of each record's file taken before
   * its first change after the tag — and read through `at(name)` or
   * `get(id, { at: { tag: name } })`. Rejects with `TAG_EXISTS`.
   */
  tag(name: string): Promise<Tag>;
  /** Drops a tag; what the next older tag needs of its copies moves there. Rejects with `TAG_NOT_FOUND`. */
  untag(name: string): Promise<void>;
  /** The tags, oldest first. */
  tags(): Tag[];
  /** The storage as it was at tag `name`; throws `TAG_NOT_FOUND`. */
  at(name: string): TagView;
  /**
   * The patches that turn the record as it was at `from` into how it is at
   * `to` (the present when omitted) — raw, no read hooks; a text's marks are
   * not diffed. Rejects as `get(id, { at })` would for either version.
   */
  diff(id: string, from?: Version, to?: Version): Promise<Patch[]>;
  /** Realizes patches as ops of this node's own, in one turn of the mutation queue; resolves to how many. */
  applyPatches(id: string, patches: readonly Patch[], options?: WriteOptions & { source?: unknown }): Promise<number>;
  /** Makes the record read as it did at `at`, with new ops that lead back; resolves to how many. */
  restore(id: string, at: Version, options?: WriteOptions & { source?: unknown }): Promise<number>;
  /**
   * Rewrites the record as the ops its reading takes today — a `write` of
   * the registers, then one op per field of another kind (a text or a list
   * as one run, a tree as one move per node) — so what lies under it goes by
   * the reset rule here and on every peer, a text's marks laid again. `get()`
   * and `spans()` read the same, but for a list, text, set or tree that reads
   * empty, which is left out; the elements are named anew, so a cursor taken
   * before reads null and a stacking mark has a new id.
   * Resolves to how many ops it took; `0` for a record that is not there.
   */
  compact(id: string, options?: WriteOptions & { source?: unknown }): Promise<number>;
  set(id: string, data: unknown, options?: StorageDataOptions): Promise<void>;
  delete(id: string, options?: WriteOptions): Promise<void>;
  /** Forgets the record for good: a `purge` op no later write revives, and a scrub of its entries from the log — here and on every peer it reaches. */
  purge(id: string, options?: WriteOptions): Promise<void>;
  update(id: string, delta: unknown, options?: WriteOptions): Promise<void>;
  /** Removes fields of any kind — one name or an array; a field the record does not hold is no op. An `unset` op: a register's tombstone an older concurrent `set` loses to. */
  unset(id: string, fields: string | readonly string[], options?: WriteOptions): Promise<void>;
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
  }): Promise<{ migrated: number; counters: number; sets: number; lists: number; texts: number; trees: number }>;
  record(id: string): Promise<Storage.StorageRecord>;
  /** The raw data of a cached entry (no lens), `null` when not cached, absent or deleted. */
  getCachedData(id: string): unknown | null;
  /** Whether `id` is a live record here — from the catalog, no I/O. */
  hasRecord(id: string): boolean;
  /** The node's health as an operator reads it — queue, cache, catalog, log, chain, lock. No I/O. */
  stats(): StorageStats;
  /** Lands what waits — the writes in flight, then the deferred record files — so what was written is on disk. */
  flush(): Promise<void>;
  /**
   * `adoptFrom`: the node id whose own `advance` ops may move this node's
   * vector — the host a subscription is read from. Absent, an `advance` is
   * logged and relayed but grants nothing. `bound`: the scopes of the peer
   * that pushed the page — an op writing a record outside them is refused
   * (`outOfScope`); a host's `push` passes the peer's grant.
   */
  applyRemote(
    ops: readonly SyncOp[],
    options?: {
      via?: PeerRef | null;
      scopes?: readonly string[] | null;
      peer?: PeerRef | null;
      adoptFrom?: string | null;
      bound?: readonly string[] | null;
    },
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
  /** Full-text search over the entity's `search` fields, top level only; rows come back best first unless ordered. */
  $text?: string;
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
  /** Removes fields; the storage-level `unset` with this record's id. */
  unset(fields: string | readonly string[], options?: WriteOptions): Promise<void>;
  inc(key: string, value?: number, options?: WriteOptions): Promise<void>;
  /** Adds to a set field — `storage.add` with this record's id. */
  add(key: string, elements: readonly unknown[], options?: WriteOptions): Promise<void>;
  /** Removes from a set field — `storage.remove` with this record's id. */
  remove(key: string, elements: readonly unknown[], options?: WriteOptions): Promise<void>;
  /** Splices a list or text field — `storage.splice` with this record's id. */
  splice(key: string, index: number, count?: number, content?: string | readonly unknown[], options?: WriteOptions): Promise<void>;
  /** Appends to a list or text field — `storage.push` with this record's id. */
  push(key: string, content: string | readonly unknown[], options?: WriteOptions): Promise<void>;
  /** Makes a text field read as `text` — `storage.updateText` with this record's id. */
  updateText(key: string, text: string, options?: WriteOptions): Promise<number>;
  /** Marks a range of a text field — `storage.mark` with this record's id. */
  mark(
    key: string,
    start: number,
    end: number,
    name: string,
    value: unknown,
    options?: WriteOptions & { expand?: MarkExpand; many?: boolean },
  ): Promise<string | null>;
  /** Removes a style from a text field — `storage.unmark` with this record's id. */
  unmark(key: string, start: number, end: number, name: string, options?: WriteOptions & { expand?: MarkExpand }): Promise<void>;
  /** Switches one mark off by its id — `storage.unmarkById` with this record's id. */
  unmarkById(key: string, markId: string, options?: WriteOptions): Promise<void>;
  /** The text field as runs of equal style — `storage.spans` with this record's id. */
  spans(key: string): Promise<TextSpan[] | null>;
  /** A cursor into a list or text field — `storage.cursor` with this record's id. */
  cursor(key: string, index: number, options?: { side?: CursorSide }): Promise<string | null>;
  /** Where a cursor is now — `storage.index` with this record's id. */
  index(key: string, cursor: string): Promise<number | null>;
  /** Replaces an element of a list field — `storage.setAt` with this record's id. */
  setAt(key: string, index: number, value: unknown, options?: WriteOptions): Promise<void>;
  /** Moves an element of a list field — `storage.move` with this record's id. */
  move(key: string, from: number, to: number, options?: WriteOptions): Promise<void>;
  /** Puts a node of a tree field under a parent — `storage.treeMove` with this record's id. */
  treeMove(
    key: string,
    node: string,
    parent?: string | null,
    options?: WriteOptions & { after?: string; before?: string },
  ): Promise<void>;
  /** Removes a node of a tree field with its subtree — `storage.treeRemove` with this record's id. */
  treeRemove(key: string, node: string, options?: WriteOptions): Promise<void>;
  delete(options?: WriteOptions): Promise<void>;
  // Live properties: one getter/setter per field of the loaded object.
  [field: string]: unknown;
}

export declare class SyncomCollection {
  constructor(storage: Storage, name: string);
  readonly name: string;
  insert(data: unknown, options?: StorageDataOptions): Promise<SyncomRecord>;
  get(id: string, options?: { at?: Version }): Promise<unknown | null>;
  /** A cursor over this collection — see Cursor. */
  select(query?: MangoQuery): Cursor;
  count(query?: MangoQuery): Promise<number>;
  /** Replaces the record wholesale, stamped as this collection's. */
  set(id: string, data: unknown, options?: StorageDataOptions): Promise<void>;
  delete(id: string, options?: WriteOptions): Promise<void>;
  /** Sets the listed fields; `$type` may not be among them. */
  update(id: string, delta: unknown, options?: WriteOptions): Promise<void>;
  unset(id: string, fields: string | readonly string[], options?: WriteOptions): Promise<void>;
  record(id: string): Promise<SyncomRecord>;
}

export declare const SyncomRecordCtor: {
  readonly prototype: SyncomRecord;
  new (id: string, storage: Storage): Promise<SyncomRecord>;
};

export interface StorageConstructor {
  readonly prototype: Storage;
  new <S extends Schema = Schema, const P extends readonly Plugin<any>[] = []>(
    options?: StorageOptions<S> & { plugins?: P },
  ): Promise<Storage & Collections<S> & PluginMethods<P>>;
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

export function open<S extends Schema = Schema, const P extends readonly Plugin<any>[] = []>(
  options?: StorageOptions<S> & { plugins?: P },
): Promise<Storage & Collections<S> & PluginMethods<P>>;
