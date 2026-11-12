import { expectType } from 'tsd';
import { appwrite } from '../src/connector/appwrite.js';
import type {
  AppwriteClientLike,
  AppwriteDatabasesLike,
  AppwriteHandlers,
  AppwriteQueryLike,
} from '../src/connector/appwrite.js';
import { replicate } from '../src/connector/connector.js';
import { createDatabase } from '../index.js';

declare const client: AppwriteClientLike;
declare const databases: AppwriteDatabasesLike;
declare const Query: AppwriteQueryLike;
const db = await createDatabase({ path: 'data' });
const handlers = appwrite({
  client,
  databases,
  Query,
  databaseId: 'db',
  collectionId: 'tasks',
  deletedField: 'deleted',
});
expectType<AppwriteHandlers>(handlers);
replicate(db, { name: 'appwrite', collection: 'Task', ...handlers });
appwrite({ databases, Query, databaseId: 'db', collectionId: 'tasks', client: null });
