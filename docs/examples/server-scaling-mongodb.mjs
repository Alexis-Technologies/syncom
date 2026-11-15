// docs-examples: browser-only (needs a MongoDB replica set; server-scaling.mjs runs the same writer and follower over the memory engine)
// The Scaling page (docs/guide/server-scaling.md) shows the regions of this file.
import { MongoClient } from 'mongodb';
import { Server, defineRouter } from '@alexify/wrpc';
import { createDatabase } from '@alexify/syncom/all';
import { mongoEngine, mongoSharedLog } from '@alexify/syncom/mongodb';

const schema = { entities: { Task: { index: ['done'] } } };
const client = await MongoClient.connect(process.env.MONGO_URL);
const authorize = (context, hello) => hello.token === process.env.SYNC_TOKEN;

// #region writer
// One process holds the database's lease and lands every op.
const engine = mongoEngine({ client });
const sharedLog = mongoSharedLog({ client });
const writer = await createDatabase({ path: 'hub', engine, schema, sync: { sharedLog } });
// #endregion writer

// #region follower
// Any number of processes follow it: they read the records it lands and host over the log.
const follower = await createDatabase({ path: 'hub', engine, schema, readOnly: true, sync: { sharedLog } });
const router = defineRouter({ syncom: follower.sync.unit({ access: 'session', authorize }) });
const server = new Server({ router, host: '0.0.0.0', port: 8000, protocol: 'http' });
await server.listen();
// #endregion follower

await server.close();
await follower.close();
await writer.close();
await client.close();
