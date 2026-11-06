// The `@alexify/syncom/connector/gdrive` subpath: one JSON file of the collection in the user's Google Drive — the
// application data folder by default — through an injected `fetch` and token, its ETag the compare-and-set.

import type { JsonFileHandlers } from './jsonfile.js';
import type { RecordData } from '../../index.js';

export interface GdriveOptions {
  fetch?: typeof globalThis.fetch;
  /** The OAuth access token (`drive.appdata` for the application data folder); or `headers` carry it. */
  token?: string | null;
  headers?: Record<string, string>;
  /** The file's name in the folder; required unless `fileId` is given. */
  name?: string;
  /** The file itself, when known: no search by name. */
  fileId?: string | null;
  /** The parent: `appDataFolder` by default, or a folder's id. */
  folder?: string;
  /** `https://www.googleapis.com` by default. */
  endpoint?: string;
  /** ms between probes of the ETag for the stream; 0 (default) for none. */
  poll?: number;
}

export interface GdriveHandlers<T = RecordData> extends JsonFileHandlers<T> {
  /** The file's id once found or made, or null. */
  fileId(): string | null;
}

export function gdrive<T = RecordData>(options: GdriveOptions): GdriveHandlers<T>;
