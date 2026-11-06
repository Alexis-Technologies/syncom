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
  /** The stamp a push writes to the modified column; an ISO date by default. */
  now?: () => string;
}

export interface SupabaseHandlers<T = RecordData> {
  pull: PullHandlers<T, string>;
  push: PushHandlers<T>;
  /** The modified stamp this adapter last saw for a row, or undefined. */
  stampOf(id: string): string | undefined;
}

export function supabase<T = RecordData>(options: SupabaseOptions): SupabaseHandlers<T>;
