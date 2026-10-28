import { expectType } from 'tsd';
import type { Storage } from '../index.js';
import { inspect, anonymize } from '../src/inspect/inspect.js';
import type { Inspection } from '../src/inspect/inspect.js';

declare const storage: Storage;
expectType<Promise<Inspection>>(inspect(storage, 'id'));
expectType<{ id: string; n: number }>(anonymize({ id: 'x', n: 1 }, { salt: 's', keys: false }));
