// The `@alexify/syncom/connector/firestore` subpath: the connector's handlers over one Firestore collection through
// the injected modular SDK — the server stamp and a tombstone the adapter's fields, a cursor after the checkpoint,
// one transaction a push, `onSnapshot` the signal.

import type { PullHandlers, PushHandlers } from './connector.js';
import type { RecordData } from '../../index.js';

/** What the adapter calls of `firebase/firestore`, handed in whole. */
export interface FirestoreSdk {
  query: (...args: any[]) => any;
  orderBy: (field: any, direction?: 'asc' | 'desc') => any;
  limit: (n: number) => any;
  startAfter: (...values: any[]) => any;
  documentId: () => any;
  getDocs: (query: any) => Promise<any>;
  doc: (collection: any, id: string) => any;
  runTransaction: (database: any, fn: (tx: any) => Promise<unknown>) => Promise<unknown>;
  serverTimestamp: () => any;
  /** The SDK's `Timestamp`: made of seconds and nanoseconds (the cursor's), or from milliseconds. */
  Timestamp: { new (seconds: number, nanoseconds: number): any; fromMillis(ms: number): any };
  onSnapshot?: (query: any, next: (snapshot: any) => void, error?: (error: unknown) => void) => () => void;
  waitForPendingWrites?: (database: any) => Promise<void>;
}

/**
 * The position of a pull: the server stamp of the last document pulled, whole — `seconds` and `nanoseconds` as the
 * SDK's `Timestamp` holds them (milliseconds would skip or repeat the rest of a commit's documents) — and its id.
 */
export interface FirestoreCheckpoint {
  seconds: number;
  nanoseconds: number;
  id: string;
}

export interface FirestoreOptions {
  sdk: FirestoreSdk;
  /** The `Firestore` instance. */
  database: unknown;
  /** The `CollectionReference`. */
  collection: unknown;
  /** The field the server stamps on every write; `serverTimestamp` by default. */
  stampField?: string;
  /** The boolean field of a tombstone; `_deleted` by default. */
  deletedField?: string;
  /** Follow the collection through `onSnapshot`; default true. */
  stream?: boolean;
}

export interface FirestoreHandlers<T = RecordData> {
  pull: PullHandlers<T, FirestoreCheckpoint>;
  push: PushHandlers<T>;
}

export function firestore<T = RecordData>(options: FirestoreOptions): FirestoreHandlers<T>;
