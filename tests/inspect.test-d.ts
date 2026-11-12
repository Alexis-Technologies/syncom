import { expectType } from 'tsd';
import type { Database } from '../index.js';
import { inspect, anonymize, indexAdvisor } from '../src/inspect/inspect.js';
import type { Inspection, IndexSuggestion } from '../src/inspect/inspect.js';

declare const storage: Database;
expectType<Promise<Inspection>>(inspect(storage, 'id'));
const advisor = indexAdvisor(storage);
expectType<IndexSuggestion[]>(advisor.suggest());
expectType<void>(advisor.stop());
expectType<{ id: string; n: number }>(anonymize({ id: 'x', n: 1 }, { salt: 's', keys: false }));
