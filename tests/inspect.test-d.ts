import { expectType } from 'tsd';
import type { Storage } from '../index.js';
import { inspect, anonymize, indexAdvisor } from '../src/inspect/inspect.js';
import type { Inspection, IndexSuggestion } from '../src/inspect/inspect.js';

declare const storage: Storage;
expectType<Promise<Inspection>>(inspect(storage, 'id'));
const advisor = indexAdvisor(storage);
expectType<IndexSuggestion[]>(advisor.suggest());
expectType<void>(advisor.stop());
expectType<{ id: string; n: number }>(anonymize({ id: 'x', n: 1 }, { salt: 's', keys: false }));
