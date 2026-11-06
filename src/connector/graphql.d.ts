// The `@alexify/syncom/connector/graphql` subpath: the connector's handlers over a GraphQL endpoint, the queries
// and the reading of their answers the application's — one adapter for every schema.

import type { ConnectorDocument, PullHandlers, PullResult, PushHandlers, PushRow } from './connector.js';
import type { RecordData } from '../../index.js';

export interface GraphqlPull<T = RecordData, C = unknown> {
  query: string;
  variables: (checkpoint: C | null, batchSize: number) => Record<string, unknown>;
  /** The answer's `data` read into the documents since the checkpoint and the position after them. */
  read: (data: any) => PullResult<T, C> | Promise<PullResult<T, C>>;
}

export interface GraphqlPush<T = RecordData> {
  query: string;
  variables: (rows: PushRow<T>[]) => Record<string, unknown>;
  /** The answer's `data` read into the conflicts (the rows refused, as the backend holds them); nothing is none. */
  read: (data: any) => ConnectorDocument<T>[] | void | Promise<ConnectorDocument<T>[] | void>;
}

export interface GraphqlOptions<T = RecordData, C = unknown> {
  /** The endpoint, posted `{ query, variables }` as JSON — or `request`. */
  url?: string;
  fetch?: typeof globalThis.fetch;
  headers?: Record<string, string>;
  /** The application's own client: answers the `data` of a query. */
  request?: (query: string, variables: Record<string, unknown>) => unknown | Promise<unknown>;
  pull?: GraphqlPull<T, C>;
  push?: GraphqlPush<T>;
  /** The application's subscription client, as `replicate()` takes a stream. */
  stream?: PullHandlers<T, C>['stream'];
}

export interface GraphqlHandlers<T = RecordData, C = unknown> {
  pull?: PullHandlers<T, C>;
  push?: PushHandlers<T>;
}

export function graphql<T = RecordData, C = unknown>(options: GraphqlOptions<T, C>): GraphqlHandlers<T, C>;
