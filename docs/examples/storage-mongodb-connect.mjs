// docs-examples: browser-only (needs a MongoDB replica set)
// The MongoDB page (docs/guide/storage-mongodb.md) shows the region of this file: the driver connected by the
// application. storage-mongodb.mjs runs everything after it, against MONGODB_URL when set and against the
// in-memory driver of the repository's tests otherwise.
// #region connect
import { MongoClient } from 'mongodb';

const client = await new MongoClient(process.env.MONGODB_URL).connect();
// #endregion connect
await client.close();
