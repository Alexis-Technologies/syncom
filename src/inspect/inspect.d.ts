// The `@alexify/syncom/inspect` subpath: devtools — what a record is made
// of, raw, and a copy of anything with every string hashed out.

import type { Storage, SyncOpType } from '../../index.js';

/** One field of a record as the metadata holds it: its kind, whether the composed reading shows it, and the kind's own counts and stamps. */
export interface FieldInspection {
  field: string;
  kind: string;
  /** Whether the composed reading shows the field (a child of a list element not shown is not). */
  reachable: boolean;
  /** A register: `[ts, origin]`, or null. */
  stamp?: [number, string] | null;
  /** A counter: per origin `[seq, sum, ts]`. */
  sums?: { [origin: string]: [number, number, number] };
  /** A set: slots held, and those with a live element. */
  elements?: number;
  live?: number;
  /** A block: its code and newest stamp, and counts of what it holds. */
  k?: string;
  ts?: number;
  runs?: number;
  nodes?: number;
  moves?: number;
  cuts?: number;
  ext?: number;
  pos?: number;
  vals?: number;
  marks?: number;
}

/** One retained log entry of the record. */
export interface LogInspection {
  seq: number;
  eventId: string;
  type: SyncOpType;
  origin: string;
  /** The op's seq in its origin's stream. */
  stream: number;
  ts: number;
  scope: string;
  field: string | null;
  actor: string | null;
  message: string | null;
  signed: boolean;
  skipped: boolean;
  scrubbed: boolean;
}

export interface Inspection {
  id: string;
  present: boolean;
  encrypted: boolean;
  alive: boolean;
  /** The data in the op model's terms — every path a field — or null. */
  data: Record<string, unknown> | null;
  /** The composed reading, as `get()` would read it without the lens or the hooks; null when not alive. */
  reading: Record<string, unknown> | null;
  base?: [number, string] | null;
  deleted?: [number, string] | null;
  purged?: [number, string] | null;
  v?: number | null;
  fields: FieldInspection[];
  log: LogInspection[];
}

/** What record `id` is made of, raw: nothing read through the lens or the hooks, nothing written. */
export function inspect(storage: Storage, id: string): Promise<Inspection>;
/**
 * A copy of `value` with every string replaced by a stable hash of it under `salt` — the keys too when `keys` is true —
 * and numbers, booleans and nulls as they are: the shape for a bug report, none of the words.
 */
/**
 * A copy of any JSON value with every string — and every key, unless `keys` is false — replaced by a stable
 * 64-bit hash under `salt` (a fresh random one when none is given). Pseudonymous: numbers, lengths and the
 * shape stay, and a guessable string is found again by whoever holds the salt.
 */
export function anonymize<T>(value: T, options?: { salt?: string; keys?: boolean }): T;
