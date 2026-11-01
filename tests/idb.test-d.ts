import { expectAssignable, expectError, expectType } from 'tsd';
import { createIdbFsi } from '../src/idb/idb.js';
import type { Fsi } from '../src/idb/idb.js';
import { open } from '../index.js';

const fsi = createIdbFsi();
expectAssignable<Fsi>(fsi);
expectType<Promise<void>>(fsi.close());
expectType<Promise<string[]>>(fsi.list('data'));
expectAssignable<Fsi>(createIdbFsi({ name: 'app', store: 'files' }));
declare const factory: IDBFactory;
expectAssignable<Fsi>(createIdbFsi({ indexedDB: factory }));
expectError(createIdbFsi({ name: 1 }));
void open({ fsi: createIdbFsi(), durable: true });

// The engine over object stores.
import { idbEngine } from '../src/idb/idb.js';
import type { Engine, IdbEngine } from '../src/idb/idb.js';
declare const KeyRange: typeof IDBKeyRange;
const engine = idbEngine({ indexedDB: factory, IDBKeyRange: KeyRange, durability: 'relaxed', channel: null });
expectType<IdbEngine>(engine);
expectAssignable<Engine>(engine);
expectType<Promise<void>>(engine.destroy());
expectError(idbEngine({ durability: 'fast' }));
void open({ engine: idbEngine() });
