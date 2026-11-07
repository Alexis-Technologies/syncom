/**
 * The connector (src/connector/connector.js) over the fake backend of the tests:
 * what a pull of N documents costs landing them with their digests kept, what
 * a push of N local inserts costs in batches, and what a restart pays for a
 * backlog of edits made offline — pushed as probes against the digests kept
 * with the checkpoint, the backend asked what it holds before anything is
 * written (review №7, E4).
 *
 * Run with `node bench/connector.js` or `pnpm bench`.
 */

'use strict';

const { bench } = require('./support/harness.js');
const { createDatabase, memoryEngine } = require('../src/all/all.js');
const { replicate } = require('../src/connector/connector.js');
const { createFakeBackend } = require('../tests/utils/fake-backend.js');

const DOCUMENTS = 5_000;
const PUSHED = 1_000;
const schema = { entities: { Task: {} } };

const main = async () => {
  let opened = 0;
  const open = () =>
    createDatabase({ engine: memoryEngine(), path: `bench/c${opened++}`, logger: false, defer: 0, schema });
  const connect = (db, backend, options = {}) =>
    replicate(db, {
      name: 'main',
      collection: 'Task',
      ...backend.handlers(),
      retryTime: 50,
      live: false,
      batchSize: 100,
      ...options,
    });

  const seeded = createFakeBackend();
  for (let i = 0; i < DOCUMENTS; i++) seeded.write(`d${i}`, { title: `document ${i}`, n: i });
  await bench(
    `pull — ${DOCUMENTS} documents of the backend landed (one transaction a page), their digests kept`,
    async () => {
      const db = await open();
      const replication = connect(db, seeded);
      await replication.awaitInitialReplication();
      await replication.cancel();
      await db.close();
    },
    { warmup: 1, measureMs: 1, opsPerIteration: DOCUMENTS },
  );

  await bench(
    `push — ${PUSHED} local inserts pushed in batches of 100 (a call a batch), the backend's state learned`,
    async () => {
      const db = await open();
      const backend = createFakeBackend();
      const replication = connect(db, backend);
      await replication.awaitInitialReplication();
      for (let i = 0; i < PUSHED; i++) await db.Task.insert({ id: `t${i}`, title: `task ${i}` });
      await replication.awaitInSync();
      await replication.cancel();
      await db.close();
    },
    { warmup: 1, measureMs: 1, opsPerIteration: PUSHED },
  );

  let probed = 0;
  await bench(
    `restart — ${PUSHED} edits made offline pushed as probes (the digests kept, the texts not), then landed`,
    async () => {
      const db = await open();
      const backend = createFakeBackend();
      const first = connect(db, backend);
      await first.awaitInitialReplication();
      for (let i = 0; i < PUSHED; i++) await db.Task.insert({ id: `t${i}`, title: `task ${i}` });
      await first.awaitInSync();
      await first.cancel();
      for (let i = 0; i < PUSHED; i++) await db.Task.update(`t${i}`, { title: `task ${i} edited` });
      const again = connect(db, backend);
      await again.awaitInitialReplication();
      await again.awaitInSync();
      probed = again.stats().probed;
      await again.cancel();
      await db.close();
    },
    { warmup: 1, measureMs: 1, opsPerIteration: PUSHED },
  );
  console.log(`  (${probed} of ${PUSHED} rows went as probes at the restart)`);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
