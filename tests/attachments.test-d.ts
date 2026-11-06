import { expectType } from 'tsd';
import { attachments, FIELD } from '../src/attachments/attachments.js';
import type { Attachment, AttachmentEntry } from '../src/attachments/attachments.js';
import { createDatabase } from '../src/all/all.js';

const db = await createDatabase({ path: 'data', plugins: [attachments({ compression: 'gzip' })] });
const entry = await db.attachments.put('t1', 'notes.txt', new Uint8Array([1, 2]), { type: 'text/plain' });
expectType<AttachmentEntry>(entry);
expectType<string>(entry.digest);
const got = await db.attachments.get('t1', 'notes.txt', { fetch: false });
expectType<Attachment | null>(got);
if (got !== null) expectType<Uint8Array>(got.bytes);
expectType<boolean>(await db.attachments.has('t1', 'notes.txt'));
expectType<Array<AttachmentEntry & { name: string }>>(await db.attachments.list('t1'));
await db.attachments.remove('t1', 'notes.txt');
expectType<'_attachments'>(FIELD);
expectType<Uint8Array>(await db.sync.fetchBlob('a'.repeat(64)));
db.sync.unit({ allow: { blob: false } });
