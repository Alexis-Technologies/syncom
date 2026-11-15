// docs-examples: browser-only (needs a NATS server with JetStream; replication-nats.mjs runs the same hubs over wrpc's in-process broker)
// The NATS and brokers page (docs/guide/replication-nats.md) shows the regions of this file. It is only parsed by
// tests/package/docs-examples.test.js.

const authorize = (context) => context.session !== null; // the app's own rule

// #region jetstream
// hub.mjs: every hub process runs this, behind one load balancer
import { connect, headers, createInbox } from '@nats-io/transport-node';
import { jetstream, jetstreamManager } from '@nats-io/jetstream';
import { createNatsBroker } from '@alexify/wrpc/broker/nats';
import { Server, defineRouter } from '@alexify/wrpc';
import { createDatabase } from '@alexify/syncom/all';

const nc = await connect({ servers: process.env.NATS_URL });
const broker = createNatsBroker({ nc, headers, createInbox, jetstream, jetstreamManager });

const hub = await createDatabase({
  path: '/var/lib/board',
  schema: { entities: { Task: {} } },
  sync: { sharedLog: { log: broker.log, topic: 'board' } },
});
const router = defineRouter({ syncom: hub.sync.unit({ access: 'session', authorize }) });
const server = new Server({ router, port: 8000, backplane: broker.backplane });
await server.listen();
// #endregion jetstream
