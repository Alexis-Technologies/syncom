import { expectType } from 'tsd';
import { openShared, elect, PROCEDURES, COLLECTION_WRITERS } from '../src/shared/shared.js';
import type {
  Shared,
  SharedDocument,
  LeaderChannel,
  Election,
  SharedCall,
  SharedCollection,
  SharedAttachments,
  SharedLocal,
} from '../src/shared/shared.js';
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
expectType<'locks' | 'heartbeat' | 'follower' | 'alone'>(shared.mode);
expectType<string>(await shared.insert({ title: 'x' }));
await shared.set('t1', { title: 'y' });
await shared.transact(async (tx) => {
  await tx.update('t1', { done: true });
});
const tasks = shared.collection<{ title: string }>('Task');
expectType<SharedCollection<{ title: string }>>(tasks);
expectType<string>(await tasks.insert({ title: 'x' }));
expectType<string>(await tasks.upsert({ title: 'x' }));
const verdicts = await tasks.bulkInsert([{ title: 'a' }]);
expectType<string[]>(verdicts.success);
expectType<number>(verdicts.error[0].index);
await tasks.update('t1', { title: 'y' });
expectType<number>(await tasks.count({}));
expectType<SharedAttachments>(shared.attachments);
expectType<string>((await shared.attachments.put('t1', 'a.txt', new Uint8Array(1))).digest);
expectType<SharedLocal>(shared.local);
expectType<SharedLocal>(shared.local.scoped('Task'));
await shared.local.set('k', { v: 1 });
expectType<readonly string[]>(PROCEDURES);
expectType<readonly string[]>(COLLECTION_WRITERS);
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
const off = election.onLead(() => {});
expectType<boolean>(election.leader);
expectType<'locks' | 'heartbeat' | 'follower' | 'alone'>(election.mode);
election.yield();
election.request();
off();
election.release();
expectType<string>(shared.token);
const tab = await openShared({ createDatabase, engine: memoryEngine(), path: 'data', election: { follower: true } });
expectType<'locks' | 'heartbeat' | 'follower' | 'alone'>(tab.mode);
expectType<string>(shared.serve().set.access);
const answer = await shared.serve().set.handler({}, { id: 'tok:1', args: ['t1', {}], retry: false });
expectType<boolean>(answer.ok);
const call: SharedCall = { id: 'tok:2', args: [] };
expectType<string>(call.id);
