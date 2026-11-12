import { expectType } from 'tsd';
import { gdrive } from '../src/connector/gdrive.js';
import type { GdriveHandlers } from '../src/connector/gdrive.js';
import { replicate } from '../src/connector/connector.js';
import { createDatabase } from '../index.js';

const db = await createDatabase({ path: 'data' });
const handlers = gdrive({ token: 'ya29…', name: 'tasks.json', poll: 30_000 });
expectType<GdriveHandlers>(handlers);
expectType<string | null>(handlers.fileId());
expectType<number | undefined>(handlers.positionOf('t1'));
replicate(db, { name: 'drive', collection: 'Task', ...handlers });
gdrive({ fileId: '1abc', headers: { authorization: 'Bearer …' } });
