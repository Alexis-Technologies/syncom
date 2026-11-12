// The `@alexify/syncom/mongodb` subpath: the engine over MongoDB, the driver's
// client injected — give it to `createDatabase({ engine })` — and a shared log
// over MongoDB for the hubs of a mesh (`createDatabase({ sync: { sharedLog } })`).
// Node only, and the driver is the application's: nothing here requires `mongodb`.

import type { Engine, SharedLog } from '../../index.js';

export type { Engine, SharedLog } from '../../index.js';

/** What the engine asks of a session: a transaction around a callback, and an end. */
export interface MongoLikeSession {
  withTransaction<T>(fn: (session: MongoLikeSession) => Promise<T>): Promise<unknown>;
  endSession(): Promise<unknown>;
}

/** What the engine asks of a database: its collections, and a drop. The driver's `Db` fits. */
export interface MongoLikeDb {
  collection(name: string): object;
  dropDatabase(): Promise<unknown>;
}

/**
 * What the engine asks of the client: a database by name, a session. The driver's `MongoClient` fits — 6.0 or
 * later, whose `findOneAndUpdate` answers the document (the lease is taken through it).
 */
export interface MongoLikeClient {
  db(name?: string): MongoLikeDb;
  startSession?(): MongoLikeSession;
}

export interface MongoEngineOptions {
  /** The driver's connected `MongoClient`. */
  client?: MongoLikeClient;
  /** A `Db` in place of the client and the name (no transactions, then). */
  db?: MongoLikeDb;
  /** The MongoDB database every path lives in; `'syncom'` by default. */
  name?: string;
  /** Land a write set in one session transaction (a replica set): `capabilities.atomicBatch`. Default false. */
  transactions?: boolean;
  /** Whether the deployment has change streams (a replica set): `db.changes`, `capabilities.changeStream`. Default true. */
  changes?: boolean;
}

/** The engine over MongoDB: six collections keyed by the database's path, a bulk write per collection per write set, a lease per path (`capabilities.lock: 'native'`). */
export interface MongoEngine extends Engine {
  readonly name: 'mongodb';
  /** The MongoDB database every path lives in. */
  readonly database: MongoLikeDb;
  /** Nothing to close: the client is the caller's. */
  close(): Promise<void>;
  /** Drops the MongoDB database — every path's collections. */
  destroy(): Promise<void>;
}

export function mongoEngine(options: MongoEngineOptions): MongoEngine;

export interface MongoSharedLogOptions {
  /** The driver's connected `MongoClient`. */
  client?: MongoLikeClient;
  /** A `Db` in place of the client and the name. */
  db?: MongoLikeDb;
  /** The MongoDB database the log lives in; `'syncom'` by default. */
  name?: string;
  /** The collection of the entries (`<collection>_heads` holds the topics' heads); `'shared'` by default. */
  collection?: string;
  /** Whether the deployment has change streams (a replica set) to wake a tail with; polled every `poll` ms otherwise, or when one fails. Default true. */
  changes?: boolean;
  /** The tail's poll, in ms; 250 by default. */
  poll?: number;
  /** How long a reader waits for a number handed out whose entry is not there yet before it skips the hole (a crashed appender's), in ms; 2 000 by default. */
  gapTimeout?: number;
  /** Trim a topic to its newest `maxEntries` on every 64th append — the topics `topics` names, every one without a list (name them where an inbox is in play: the writer trims the inbox itself). */
  retention?: { maxEntries?: number; topics?: readonly string[] | null };
  /** Where a change stream's failure is said (`shared.stream.failed`). */
  logger?: { warn?: (entry: Record<string, unknown>) => void } | null;
}

/** A shared log over two collections of a MongoDB database: entries numbered per topic by its head document, ids `<epoch>.<n>`. */
export interface MongoSharedLog extends SharedLog {
  readonly name: 'mongodb';
  /** Drops all but the newest `keep` entries of a topic. */
  trim(topic: string, keep: number): Promise<void>;
  /** Drops everything of a topic at or before the entry `id` names (what a writer landed of its inbox); another epoch's id drops nothing. */
  trimBefore(topic: string, id: string): Promise<void>;
  /** The topic's head — its epoch, the next number, the oldest kept — or null for a topic never appended to. */
  head(topic: string): Promise<{ epoch: string; next: number; first: number } | null>;
  /** Stops every tail; a read after it fails with 503. The client is the caller's. */
  close(): Promise<void>;
}

export function mongoSharedLog(options: MongoSharedLogOptions): MongoSharedLog;
