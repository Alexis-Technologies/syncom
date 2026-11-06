// The `@alexify/syncom/connector/mongodb` subpath: the connector's handlers over one collection of the driver's,
// injected — `_rev`, `_deleted` and `_updated` the adapter's fields on every document, a change stream as the signal.

import type { PullHandlers, PushHandlers } from './connector.js';
import type { RecordData } from '../../index.js';

/** What the adapter asks of the driver's collection. */
export interface MongoLikeCollection {
  find(filter: object, options?: object): { toArray(): Promise<any[]> };
  findOne(filter: object): Promise<any>;
  replaceOne(
    filter: object,
    replacement: object,
    options?: object,
  ): Promise<{ matchedCount: number; upsertedCount: number }>;
  watch?(
    pipeline?: object[],
    options?: object,
  ): { on(event: string, listener: (...args: any[]) => void): unknown; close(): unknown };
}

export interface MongodbConnectorOptions {
  collection: MongoLikeCollection;
  /** Whether the deployment has change streams (a replica set): the stream. Default true. */
  changes?: boolean;
  /** The clock `_updated` is stamped by; `Date.now` by default. */
  now?: () => number;
}

export interface MongodbHandlers<T = RecordData> {
  pull: PullHandlers<T, number>;
  push: PushHandlers<T>;
  /** The `_rev` this adapter last saw for a document, or undefined. */
  revisionOf(id: string): number | undefined;
}

export function mongodb<T = RecordData>(options: MongodbConnectorOptions): MongodbHandlers<T>;
