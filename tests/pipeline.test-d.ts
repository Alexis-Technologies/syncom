import { expectError, expectType } from 'tsd';
import { createPipeline } from '../src/pipeline/pipeline.js';
import type { Pipeline } from '../src/pipeline/pipeline.js';
import type { Database } from '../index.js';

declare const db: Database;
const pipeline: Pipeline = createPipeline(db, {
  name: 'totals',
  source: 'Order',
  handler: async ({ ids, changes, replay, eventId }, tx) => {
    expectType<string[]>(ids);
    expectType<boolean>(replay);
    expectType<string>(eventId);
    if (changes !== null) expectType<string>(changes[0].id);
    await tx.set('total', { n: ids.length });
  },
});
expectType<Promise<void>>(pipeline.start());
expectType<string | null>(pipeline.checkpoint);
expectType<boolean>(pipeline.idle());
expectType<Promise<void>>(pipeline.awaitIdle());
expectError(createPipeline(db, { name: 'x', source: 'Order' }));
