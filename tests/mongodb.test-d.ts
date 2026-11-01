import { expectAssignable, expectType } from 'tsd';
import { mongoEngine } from '../src/mongodb/mongodb.js';
import type { MongoEngine, MongoLikeClient, MongoLikeDb, Engine } from '../src/mongodb/mongodb.js';
import { createDatabase } from '../index.js';

declare const client: MongoLikeClient;
declare const db: MongoLikeDb;

const engine = mongoEngine({ client, name: 'app', transactions: true });
expectType<MongoEngine>(engine);
expectAssignable<Engine>(engine);
expectType<'mongodb'>(engine.name);
expectType<MongoLikeDb>(engine.database);
expectType<Promise<void>>(engine.close());
expectType<Promise<void>>(engine.destroy());
await createDatabase({ engine });

mongoEngine({ db, changes: false });
// A duck-typed client: a database by name and a session.
const duck: MongoLikeClient = {
  db: () => db,
  startSession: () => ({ withTransaction: async (fn) => fn(duck.startSession!()), endSession: async () => {} }),
};
mongoEngine({ client: duck });
