import { expectType } from 'tsd';
import { firestore } from '../src/connector/firestore.js';
import type { FirestoreHandlers, FirestoreSdk } from '../src/connector/firestore.js';
import { replicate } from '../src/connector/connector.js';
import { createDatabase } from '../index.js';

declare const sdk: FirestoreSdk;
declare const database: unknown;
declare const collection: unknown;
const db = await createDatabase({ path: 'data' });
const handlers = firestore<{ title: string }>({
  sdk,
  database,
  collection,
  stampField: 'serverTimestamp',
  stream: false,
});
expectType<FirestoreHandlers<{ title: string }>>(handlers);
replicate(db, { name: 'firestore', collection: 'Task', ...handlers });
