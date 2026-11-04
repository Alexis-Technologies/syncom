import { expectError, expectType } from 'tsd';
import { cleanup, MINIMUM_DELETED_TIME } from '../src/cleanup/cleanup.js';
import type { Cleanup, CleanupCounts } from '../src/cleanup/cleanup.js';
import type { Database } from '../index.js';

declare const db: Database;
const sweeper: Cleanup = cleanup(db, { minimumDeletedTime: 0, runEach: 1000, awaitSync: false });
expectType<Promise<CleanupCounts>>(sweeper.run({ drop: true }));
expectType<void>(sweeper.start());
expectType<number>(sweeper.stats.runs);
expectType<number>(MINIMUM_DELETED_TIME);
expectError(cleanup(db, { minimumDeletedTime: 'soon' }));
