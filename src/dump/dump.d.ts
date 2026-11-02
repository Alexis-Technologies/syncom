// The `@alexify/syncom/dump` subpath: a database as JSON and back — a backup,
// an import from another database, a move between engines.

import type { Database, Engine, Entry, VersionVector, RecordData } from '../../index.js';

/** A record of a dump: as a snapshot hands it (with its meta), or the data alone (`meta: false`). */
export interface DumpRecord {
  id: string;
  data: RecordData;
  meta?: Entry['meta'];
}

export interface Dump {
  format: 1;
  node: string;
  schema: { version: number; hash: string | null } | null;
  kinds: string[];
  eventId: string;
  vector: VersionVector;
  /** Whether the records carry their meta. */
  meta: boolean;
  records: DumpRecord[];
}

export interface ExportOptions {
  /** The collections to keep to; every record without. */
  collections?: readonly string[];
  /** The scopes to keep to (as a snapshot takes them). */
  scopes?: readonly string[] | null;
  /** With the meta (the default: another node joins it exactly), or the live data alone. */
  meta?: boolean;
  /** Records per page; 500. */
  limit?: number;
}

export interface ImportOptions {
  /** `merge` joins the records with their meta as a bootstrap does; `insert` writes the data under the same ids as plain writes. */
  mode?: 'merge' | 'insert';
  /** Take a dump made under another schema hash. */
  force?: boolean;
  /** Records per turn of the queue; 500. */
  batch?: number;
}

/** The records a page at a time, in id order. */
export function exportPages(db: Database, options?: ExportOptions): AsyncIterableIterator<DumpRecord[]>;
/** The whole database as one JSON value. */
export function exportJSON(db: Database, options?: ExportOptions): Promise<Dump>;
/** A dump (or a foreign `{ records: [{ id, data }] }`) into `db`; `SCHEMA_MISMATCH` for another schema unless forced. */
export function importJSON(
  db: Database,
  dump: { records: readonly DumpRecord[]; schema?: { hash: string | null } | null },
  options?: ImportOptions,
): Promise<{ mode: 'merge' | 'insert'; records: number }>;
/** A database moved between engines: `copy` (engines and a path; the same node) or `merge` (two open databases; a new node). */
export function migrateStorage(options: {
  from: Engine;
  to: Engine;
  path: string;
  mode?: 'copy';
  batch?: number;
}): Promise<{ records: number; pieces: number; copies: number; kv: number; entries: number }>;
export function migrateStorage(options: {
  from: Database;
  to: Database;
  mode: 'merge';
  batch?: number;
}): Promise<{ mode: 'merge'; records: number }>;
export const FORMAT: 1;
