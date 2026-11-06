import { expectAssignable, expectType } from 'tsd';
import { mongoEngine, mongoSharedLog } from '../src/mongodb/mongodb.js';
import type {
  MongoEngine,
  MongoLikeClient,
  MongoLikeDb,
  Engine,
  MongoSharedLog,
  SharedLog,
} from '../src/mongodb/mongodb.js';
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

// The shared log over MongoDB: the contract `sync.sharedLog` takes, with a trim and a head.
const log = mongoSharedLog({ client, name: 'app', collection: 'shared', poll: 100, retention: { maxEntries: 10_000 } });
expectType<MongoSharedLog>(log);
expectAssignable<SharedLog>(log);
expectType<'mongodb'>(log.name);
expectType<Promise<string>>(log.append('syncom', '{}', { headers: { by: 'h1' } }));
expectType<string | null>(log.parseId('a.1'));
expectType<Promise<void>>(log.trim('syncom', 1000));
expectType<Promise<{ epoch: string; next: number; first: number } | null>>(log.head('syncom'));
expectType<Promise<void>>(log.close());
const tail = async () => {
  for await (const entry of log.read('syncom', { after: 'a.1' })) expectType<string>(entry.value);
};
expectType<Promise<void>>(tail());
await createDatabase({ engine, sync: { sharedLog: log } });
await createDatabase({ engine, readOnly: true, sync: { sharedLog: { log, inbox: false } } });
mongoSharedLog({ db, changes: false, gapTimeout: 500, logger: { warn: () => {} } });

// The connector adapter over a collection of the driver's: a subpath of its own beside the engine's.
import { mongodb as mongodbConnector } from '../src/connector/mongodb.js';
import type { MongodbHandlers, MongoLikeCollection } from '../src/connector/mongodb.js';
import { replicate } from '../src/connector/connector.js';
declare const collection: MongoLikeCollection;
const handlers = mongodbConnector({ collection, changes: false });
expectType<MongodbHandlers>(handlers);
expectType<number | undefined>(handlers.revisionOf('t1'));
replicate(await createDatabase({ engine }), { name: 'mongo', collection: 'Task', ...handlers });
