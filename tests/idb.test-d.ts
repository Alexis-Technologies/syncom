import { expectAssignable, expectError, expectType } from 'tsd';
import { createIdbFsi } from '../idb.js';
import type { Fsi } from '../idb.js';
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
