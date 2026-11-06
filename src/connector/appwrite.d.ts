// The `@alexify/syncom/connector/appwrite` subpath: the connector's handlers over one Appwrite collection through
// the injected SDK — `$updatedAt` the position, a boolean attribute the tombstone, a read then a write the push
// (no compare-and-set in Appwrite), Realtime the signal.

import type { PullHandlers, PushHandlers } from './connector.js';
import type { RecordData } from '../../index.js';

/** What the adapter asks of the SDK's `Databases` service. */
export interface AppwriteDatabasesLike {
  listDocuments(databaseId: string, collectionId: string, queries?: string[]): Promise<{ documents: any[] }>;
  createDocument(databaseId: string, collectionId: string, documentId: string, data: object): Promise<any>;
  updateDocument(databaseId: string, collectionId: string, documentId: string, data: object): Promise<any>;
  getDocument(databaseId: string, collectionId: string, documentId: string): Promise<any>;
}

/** What the adapter asks of the SDK's `Query` builder. */
export interface AppwriteQueryLike {
  equal(attribute: string, value: unknown): string;
  greaterThan(attribute: string, value: unknown): string;
  orderAsc(attribute: string): string;
  limit(n: number): string;
  or(queries: string[]): string;
  and(queries: string[]): string;
}

/** What the adapter asks of the SDK's client: Realtime. */
export interface AppwriteClientLike {
  subscribe(channels: string | string[], callback: (event: any) => void): () => void;
}

export interface AppwriteCheckpoint {
  /** The `$updatedAt` of the last document pulled. */
  updatedAt: string;
  id: string;
}

export interface AppwriteOptions {
  databases: AppwriteDatabasesLike;
  Query: AppwriteQueryLike;
  databaseId: string;
  collectionId: string;
  /** The client, for the stream; none for no stream. */
  client?: AppwriteClientLike | null;
  /** The boolean attribute of a tombstone; `deleted` by default. */
  deletedField?: string;
  /** Follow the collection through Realtime; default true. */
  stream?: boolean;
}

export interface AppwriteHandlers<T = RecordData> {
  pull: PullHandlers<T, AppwriteCheckpoint>;
  push: PushHandlers<T>;
}

export function appwrite<T = RecordData>(options: AppwriteOptions): AppwriteHandlers<T>;
