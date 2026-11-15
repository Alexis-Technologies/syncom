import { expectError, expectType } from 'tsd';
import { cleanup, MINIMUM_DELETED_TIME } from '../src/cleanup/cleanup.js';
import type { Cleanup, CleanupCounts } from '../src/cleanup/cleanup.js';
import type { Shared } from '../src/shared/shared.js';
import type { Database } from '../index.js';

declare const db: Database;
const sweeper: Cleanup = cleanup(db, { minimumDeletedTime: 0, runEach: 1000, awaitSync: false });
expectType<Promise<CleanupCounts>>(sweeper.run({ drop: true }));
expectType<void>(sweeper.start());
expectType<number>(sweeper.stats.runs);
expectType<number>(MINIMUM_DELETED_TIME);
expectError(cleanup(db, { minimumDeletedTime: 'soon' }));

// `leader`: what openShared() answers, its `db` the database given — a boolean is none.
declare const shared: Shared;
expectType<Cleanup>(cleanup(shared.db, { leader: shared, runEach: 1000 }));
expectError(cleanup(db, { leader: true }));
expectError(sweeper.leader);
