// The `@alexify/syncom/connector/couchdb` subpath: the connector's handlers over one CouchDB database, reached
// through an injected `fetch` — `_changes` with the documents for a pull (a long poll as the stream), `_bulk_docs`
// with the revisions last seen for a push, a `conflict` answered as the document stands.

import type { PullHandlers, PushHandlers } from './connector.js';
import type { RecordData } from '../../index.js';

export interface CouchdbOptions {
  /** The database: `https://host/db`. */
  url: string;
  /** The platform's unless given. */
  fetch?: typeof globalThis.fetch;
  /** On every request: an `Authorization`, say. */
  headers?: Record<string, string>;
  /** The long poll's wait, in ms; 60 000 by default. */
  longpoll?: number;
}

export interface CouchdbHandlers<T = RecordData> {
  pull: Required<PullHandlers<T, string | number>>;
  push: PushHandlers<T>;
  /** The `_rev` this adapter last saw for a document, or undefined. */
  revisionOf(id: string): string | undefined;
}

export function couchdb<T = RecordData>(options: CouchdbOptions): CouchdbHandlers<T>;
