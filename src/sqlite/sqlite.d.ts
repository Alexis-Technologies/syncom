// The `@alexify/syncom/sqlite` subpath: the engine over SQLite — `node:sqlite`
// by default, or any driver with `exec` and `prepare`. Give it to
// `createDatabase({ engine })`. Node only: nothing of it ships to the browser.

import type { Engine } from '../../index.js';

export type { Engine } from '../../index.js';

/** A parameter a statement is given: a text, a number or null. */
export type SqliteParam = string | number | null;

/** A prepared statement as the engine runs it; every result may be a promise. */
export interface SqliteStatement {
  run(...params: SqliteParam[]): unknown;
  get(...params: SqliteParam[]): unknown;
  all(...params: SqliteParam[]): unknown;
}

/** What the engine asks of a driver's database: SQL run whole, prepared statements, an optional close. */
export interface SqliteDatabase {
  exec(sql: string): unknown;
  prepare(sql: string): SqliteStatement | Promise<SqliteStatement>;
  close?(): unknown;
}

/** Opens a database for a file: `node:sqlite`'s `DatabaseSync`, better-sqlite3, expo-sqlite… */
export interface SqliteDriver {
  open(file: string): SqliteDatabase | Promise<SqliteDatabase>;
}

export interface SqliteEngineOptions {
  /** The SQLite file every database opened through the engine lives in; `':memory:'` by default. */
  file?: string;
  /** An open connection the caller owns: used as it is, never closed by the engine. */
  database?: SqliteDatabase;
  /** Opens `file`; `node:sqlite` by default. */
  driver?: SqliteDriver;
  /** `PRAGMA synchronous = FULL` from the start (any database opened with `durable: true` sets it too). */
  durable?: boolean;
}

/** The engine over SQLite: six tables keyed by the database's path, one transaction per write set and per log group. */
export interface SqliteEngine extends Engine {
  readonly name: 'sqlite';
  /** The file given. */
  readonly file: string;
  /** Closes a connection the engine opened; the next call opens the file again (a `:memory:` database starts over). */
  close(): Promise<void>;
  /** Closes, then deletes the file and its WAL; nothing for `:memory:` or a connection given. */
  destroy(): Promise<void>;
}

export function sqliteEngine(options?: SqliteEngineOptions): SqliteEngine;
