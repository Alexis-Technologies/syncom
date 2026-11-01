// The `@alexify/syncom/mongodb` subpath: the engine over MongoDB, the driver's
// client injected. Give it to `createDatabase({ engine })`. Node only, and
// the driver is the application's: nothing here requires `mongodb`.

import type { Engine } from '../../index.js';

export type { Engine } from '../../index.js';

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
