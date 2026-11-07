import { expectAssignable, expectError, expectType } from 'tsd';
import { replicate } from '../src/connector/connector.js';
import type {
  Replication,
  ReplicateOptions,
  PullResult,
  PushRow,
  ConnectorDocument,
} from '../src/connector/connector.js';
import { createDatabase } from '../index.js';
import type { MongodbCheckpoint } from '../src/connector/mongodb.js';
import type { SupabaseCheckpoint } from '../src/connector/supabase.js';
import type { FirestoreCheckpoint } from '../src/connector/firestore.js';

expectAssignable<MongodbCheckpoint>({ at: 1, id: 'a' });
expectAssignable<SupabaseCheckpoint>({ at: '2026-01-01T00:00:00Z', id: 'a' });
expectAssignable<FirestoreCheckpoint>({ seconds: 1, nanoseconds: 500, id: 'a' });
expectError<FirestoreCheckpoint>({ at: 1, id: 'a' });

const db = await createDatabase({ path: 'data' });

interface Task {
  title: string;
  done?: boolean;
}

const options: ReplicateOptions<Task, number> = {
  name: 'tasks',
  collection: 'Task',
  pull: {
    handler: async (checkpoint, batchSize) => {
      expectType<number | null>(checkpoint);
      expectType<number>(batchSize);
      return { documents: [{ id: 't1', data: { title: 'a' } }], checkpoint: 1 };
    },
    stream: (emit, { checkpoint }) => {
      expectType<number | null>(checkpoint);
      emit({ documents: [], checkpoint: 2 });
      emit('RESYNC');
      emit('END');
      return () => {};
    },
  },
  push: {
    handler: async (rows) => {
      expectType<PushRow<Task>[]>(rows);
      expectType<Task | null | undefined>(rows[0].assumed);
      return [{ id: rows[0].id, data: { title: 'theirs' } }];
    },
  },
  live: true,
  retryTime: 1000,
  maxRetryTime: 30_000,
  safetyTime: 60_000,
  batchSize: 50,
  modifier: { pull: (data) => data, push: (data, id) => ({ ...data, id }) },
  resolve: ({ local, remote }) => remote ?? local,
  autoStart: false,
};
const replication = replicate(db, options);
expectType<Replication>(replication);
expectType<string>(replication.name);
expectType<boolean>(replication.active);
expectType<{ pull: unknown; pushed: string | null }>(replication.checkpoint);
expectType<Promise<void>>(replication.start());
expectType<Promise<void>>(replication.awaitInitialReplication());
expectType<Promise<void>>(replication.awaitInSync({ signal: new AbortController().signal }));
expectType<Promise<void>>(replication.reSync());
expectType<Promise<void>>(replication.cancel());
expectType<number>(replication.stats().pending);
replication.on('received', ({ documents, applied }) => expectType<number>(documents + applied));
replication.on('conflict', ({ id, resolved }) => expectType<string>(id + String(resolved)));
replication.on('error', (error) => expectType<'REPLICATION_FAILED'>(error.code));
replication.on('error', (error) => expectType<number | null>(error.retryIn));
replication.on('refused', ({ direction, id, reason }) => expectType<string>(direction + id + reason));
expectType<number>(replication.stats().refused);
expectType<number>(replication.stats().parked);
const parking: ReplicateOptions<Task> = {
  name: 'parking',
  collection: 'Task',
  push: { handler: (rows) => [{ id: rows[0].id, error: { code: 'bad_id', message: 'no' } }] },
};
expectAssignable<ReplicateOptions<Task>>(parking);
expectAssignable<PullResult>({ documents: [], checkpoint: null });
expectAssignable<ConnectorDocument>({ id: 'x', deleted: true });
expectError(replicate(db, { collection: 'Task' }));
expectError(replicate(db, { name: 'x', collection: 'Task', pull: { handler: 7 } }));
