import { expectType } from 'tsd';
import { onedrive } from '../src/connector/onedrive.js';
import type { JsonFileHandlers } from '../src/connector/jsonfile.js';
import { replicate } from '../src/connector/connector.js';
import { createDatabase } from '../index.js';

const db = await createDatabase({ path: 'data' });
const handlers = onedrive({ token: 'eyJ…', path: 'syncom/tasks.json', drive: 'me/drive', poll: 30_000 });
expectType<JsonFileHandlers>(handlers);
expectType<number | undefined>(handlers.positionOf('t1'));
replicate(db, { name: 'onedrive', collection: 'Task', ...handlers });
