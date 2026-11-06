// The shape the Google Drive and OneDrive adapters share: one JSON file of the collection, `n` the position of a
// document's newest write (the checkpoint), the file's ETag the compare-and-set. No subpath of its own.

import type { PullHandlers, PushHandlers } from './connector.js';
import type { RecordData } from '../../index.js';

/** The backend's door onto one file. */
export interface JsonFileStore {
  /** The file as it stands, or null for none. */
  load(): Promise<{ etag: string | null; text: string } | null>;
  /** The file written whole under `etag` (If-Match); an error with `status: 412` is the conflict. */
  save(text: string, etag: string | null): Promise<{ etag: string | null }>;
  /** The file's ETag without its text, or null for none — what the stream probes. */
  probe?(): Promise<string | null>;
}

export interface JsonFileHandlers<T = RecordData> {
  pull: PullHandlers<T, number>;
  push: PushHandlers<T>;
  /** The position of a document's newest write as the file was last read, or undefined. */
  positionOf(id: string): number | undefined;
}
