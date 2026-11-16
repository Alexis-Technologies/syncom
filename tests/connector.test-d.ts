import { expectAssignable, expectError, expectType } from 'tsd';
import { replicate } from '../src/connector/connector.js';
import type {
  Replication,
  ReplicateOptions,
  PullResult,
  PushRow,
  ParkedRow,
  ConnectorDocument,
} from '../src/connector/connector.js';
import { createDatabase } from '../index.js';
import type { MongodbCheckpoint } from '../src/connector/mongodb.js';
import type { SupabaseCheckpoint } from '../src/connector/supabase.js';
import type { FirestoreCheckpoint } from '../src/connector/firestore.js';
import type { AppwriteCheckpoint } from '../src/connector/appwrite.js';

expectAssignable<MongodbCheckpoint>({ at: 1, id: 'a' });
expectAssignable<SupabaseCheckpoint>({ at: '2026-01-01T00:00:00Z', id: 'a' });
expectAssignable<FirestoreCheckpoint>({ seconds: 1, nanoseconds: 500, id: 'a' });
expectError<FirestoreCheckpoint>({ at: 1, id: 'a' });
// Under a lookback a run under way carries where its next page reads on.
expectAssignable<MongodbCheckpoint>({ at: 2, id: 'b', from: { at: 1, id: 'a' } });
expectAssignable<SupabaseCheckpoint>({
  at: '2026-01-01T00:00:01Z',
  id: 'b',
  from: { at: '2026-01-01T00:00:00Z', id: 'a' },
});
expectAssignable<FirestoreCheckpoint>({
  seconds: 2,
  nanoseconds: 0,
  id: 'b',
  from: { seconds: 1, nanoseconds: 500, id: 'a' },
});
expectAssignable<AppwriteCheckpoint>({
  updatedAt: '2026-01-01T00:00:01.000+00:00',
  id: 'b',
  from: { updatedAt: '2026-01-01T00:00:00.000+00:00', id: 'a' },
});
expectError<MongodbCheckpoint>({ at: 2, id: 'b', from: { at: '1', id: 'a' } });

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
replication.on('error', (error) => expectType<string>(error.connector));
replication.on('refused', ({ direction, id, reason }) => expectType<string>(direction + id + reason));
expectType<number>(replication.stats().refused);
expectType<number>(replication.stats().parked);
expectType<ParkedRow[]>(replication.parked);
expectType<{ id: string; reason: string }>(replication.parked[0]);
expectError((replication.parked = []));
const parking: ReplicateOptions<Task> = {
  name: 'parking',
  collection: 'Task',
  push: { handler: (rows) => [{ id: rows[0].id, error: { code: 'bad_id', message: 'no' } }] },
};
expectAssignable<ReplicateOptions<Task>>(parking);
expectAssignable<PullResult>({ documents: [], checkpoint: null });
// A handler that looks back says how many of its documents it read again.
expectAssignable<PullResult<Task, number>>({
  documents: [{ id: 't1', data: { title: 'a' } }],
  checkpoint: 1,
  reread: 1,
});
expectError<PullResult>({ documents: [], checkpoint: null, reread: '1' });
expectAssignable<ReplicateOptions<Task, number>>({
  name: 'looking',
  collection: 'Task',
  pull: { handler: async (checkpoint) => ({ documents: [], checkpoint: checkpoint ?? 0, reread: 0 }) },
});
expectAssignable<ConnectorDocument>({ id: 'x', deleted: true });
expectError(replicate(db, { collection: 'Task' }));
expectError(replicate(db, { name: 'x', collection: 'Task', pull: { handler: 7 } }));
