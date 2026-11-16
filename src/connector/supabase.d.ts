// The `@alexify/syncom/connector/supabase` subpath: the connector's handlers over one table through the injected
// Supabase client — the modified column the compare-and-set, Realtime's `postgres_changes` the signal.

import type { PullHandlers, PushHandlers } from './connector.js';
import type { RecordData } from '../../index.js';

/** What the adapter asks of the client: `from(table)` with the builder it speaks, and Realtime's channels. */
export interface SupabaseLikeClient {
  from(table: string): any;
  channel?(name: string): any;
  removeChannel?(channel: unknown): unknown;
}

export interface SupabaseOptions {
  client: SupabaseLikeClient;
  table: string;
  /** The primary key column; `id` by default. */
  primaryKey?: string;
  /** The column the database sets on every write; `updated_at` by default. */
  modifiedColumn?: string;
  /** The boolean column of a deletion; `deleted` by default. */
  deletedColumn?: string;
  schema?: string;
  /** The Realtime channel; `syncom:<table>` by default. */
  channel?: string | null;
  /** Follow the table through Realtime; default true (where the client has channels). */
  stream?: boolean;
  /**
   * How far before its checkpoint a pull run starts, in ms; 0 (none) by default. A pull that resumes after a stamp
   * never sees a document that became visible later with an older one (a transaction that committed late); with a
   * lookback the run reads that much again — what the connector knows of it is passed over, nothing landed or counted
   * — and the late one is pulled. The window is read at every pull: keep it as short as the lateness expected.
   */
  lookback?: number;
  /** The stamp a push writes to the modified column; an ISO date by default. */
  now?: () => string;
}

/** The position of a pull: the modified stamp of the last row and its primary key (the ties at one stamp by key). */
export interface SupabaseCheckpoint {
  at: string;
  id: string;
  /** Under a `lookback`, while a run is under way: the position its next page reads on after. */
  from?: { at: string; id: string };
}

export interface SupabaseHandlers<T = RecordData> {
  pull: PullHandlers<T, SupabaseCheckpoint>;
  push: PushHandlers<T>;
  /** The modified stamp this adapter last saw for a row, or undefined. */
  stampOf(id: string): string | undefined;
}

export function supabase<T = RecordData>(options: SupabaseOptions): SupabaseHandlers<T>;
