// The `@alexify/syncom/connector/onedrive` subpath: one JSON file of the collection in the user's OneDrive through
// Microsoft Graph, an injected `fetch` and token, its eTag the compare-and-set.

import type { JsonFileHandlers } from './jsonfile.js';
import type { RecordData } from '../../index.js';

export interface OnedriveOptions {
  fetch?: typeof globalThis.fetch;
  /** The Graph access token (`Files.ReadWrite`); or `headers` carry it. */
  token?: string | null;
  headers?: Record<string, string>;
  /** The file's path in the drive: `syncom/tasks.json`. */
  path: string;
  /** `me/drive` by default, or `drives/<id>`. */
  drive?: string;
  /** `https://graph.microsoft.com/v1.0` by default. */
  endpoint?: string;
  /** ms between probes of the eTag for the stream; 0 (default) for none. */
  poll?: number;
}

export function onedrive<T = RecordData>(options: OnedriveOptions): JsonFileHandlers<T>;
