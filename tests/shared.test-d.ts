import { expectType } from 'tsd';
import { openShared, elect } from '../src/shared/shared.js';
import type { Shared, SharedDocument, LeaderChannel, Election } from '../src/shared/shared.js';
import { createDatabase } from '../index.js';
import { memoryEngine } from '../src/memory/memory.js';
import { createSharedChannel } from '../src/wrpc/wrpc.js';
import type { Database } from '../index.js';

declare const client: { call(method: string, args: unknown): Promise<unknown>; close(): void };
const channel = createSharedChannel(client, { unit: 'syncom-db' });
expectType<LeaderChannel>(channel as LeaderChannel);

const shared = await openShared({
  createDatabase,
  engine: memoryEngine(),
  path: 'data',
  channel: async () => channel,
  election: { locks: navigator.locks, heartbeat: 1000, misses: 3 },
  grace: 50,
  failover: 10_000,
});
expectType<Shared>(shared);
expectType<Database>(shared.db);
expectType<boolean>(shared.leader);
expectType<'locks' | 'heartbeat' | 'alone'>(shared.mode);
expectType<string>(await shared.insert({ title: 'x' }));
await shared.set('t1', { title: 'y' });
await shared.transact(async (tx) => {
  await tx.update('t1', { done: true });
});
const doc = shared.document<{ title: string }>('t1');
expectType<SharedDocument<{ title: string }>>(doc);
expectType<{ title: string } | null>(await doc.data());
doc.on('update', (data) => data?.title);
shared.on('leader', ({ generation }) => generation);
const stop = shared.live((db) => {
  const off = () => db.off('transaction', listener);
  const listener = () => {};
  db.on('transaction', listener);
  return off;
});
stop();
await shared.waitForLeadership({ signal: AbortSignal.timeout(1000) });
const procedures = shared.serve({ access: 'public' });
expectType<string>(procedures.set.access);
await shared.close();

const election = elect({ name: 'syncom:leader:data', heartbeat: 500 });
expectType<Election>(election);
await election.lead;
election.release();
