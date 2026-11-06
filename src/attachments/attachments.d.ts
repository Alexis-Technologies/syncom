// The `@alexify/syncom/attachments` subpath: bytes beside a record, kept in the engine's blobs store under their
// SHA-256 and named on the record as a register that replicates; the bytes fetched from a peer on demand.
// `createDatabase({ plugins: [attachments()] })` hands the core `db.attachments`.

import type { Plugin, AttachmentStore, AttachmentEntry, Attachment } from '../../index.js';
export type { Plugin, AttachmentStore, AttachmentEntry, Attachment };

export interface AttachmentsOptions {
  /** Store the bytes compressed through CompressionStream (`encoding` on the register); none by default. */
  compression?: 'gzip' | 'deflate' | null;
}

/** The plugin: `db.attachments` (`put`, `get`, `has`, `list`, `remove`). */
export function attachments(options?: AttachmentsOptions): Plugin;
/** The field the names live under on a record: `_attachments`. */
export const FIELD: '_attachments';
/** The class behind `db.attachments`. */
export const Attachments: { readonly prototype: AttachmentStore };
