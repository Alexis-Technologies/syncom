import { expectType } from 'tsd';
import { couchdb } from '../src/connector/couchdb.js';
import type { CouchdbHandlers } from '../src/connector/couchdb.js';
import { replicate } from '../src/connector/connector.js';
import { createDatabase } from '../index.js';

const db = await createDatabase({ path: 'data' });
const handlers = couchdb({
  url: 'https://couch.example.com/tasks',
  headers: { authorization: 'Basic …' },
  longpoll: 30_000,
});
expectType<CouchdbHandlers>(handlers);
expectType<string | undefined>(handlers.revisionOf('t1'));
replicate(db, { name: 'couch', collection: 'Task', ...handlers });
