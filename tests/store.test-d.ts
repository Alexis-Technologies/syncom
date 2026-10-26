import { expectError, expectType } from 'tsd';
import { toStore, fromEvents } from '../src/store/store.js';
import type { SyncomStore, StoreOptions } from '../src/store/store.js';
import type { Storage, Cursor, QueryRow, SyncomRecord, RecordData } from '../src/all/all.js';
import { createPresence } from '../src/presence/presence.js';

declare const storage: Storage;
declare const cursor: Cursor<QueryRow<{ title: string }>>;
declare const record: SyncomRecord<{ title: string }>;

const rows = toStore(cursor, { onError: (error) => error.message });
expectType<SyncomStore<QueryRow<{ title: string }>[] | undefined>>(rows);
expectType<() => void>(rows.subscribe((value) => value?.[0]?.title));
expectType<QueryRow<{ title: string }>[] | undefined>(rows.getSnapshot());
expectType<Error | null>(rows.error);
expectType<Promise<QueryRow<{ title: string }>[] | undefined>>(rows.ready);
expectType<SyncomStore<{ title: string } | null | undefined>>(toStore(record));
expectType<SyncomStore<Map<string, Record<string, unknown>>>>(toStore(createPresence(storage)));
expectType<SyncomStore<RecordData | null | undefined>>(toStore(storage, 'id'));
expectType<SyncomStore<{ n: number } | null | undefined>>(toStore<{ n: number }>(storage, 'id', { path: 'profile' }));
expectType<SyncomStore<number | undefined>>(fromEvents(storage, ['change'], async () => 1, { initial: 0 }));
expectError(toStore(storage, 'id', { path: 5 }));
expectError(rows.subscribe('x'));
const options: StoreOptions<number> = { initial: 1 };
expectType<number | undefined>(options.initial);
// React's useSyncExternalStore takes the two members as they are.
declare function useSyncExternalStore<T>(subscribe: (onChange: () => void) => () => void, getSnapshot: () => T): T;
expectType<QueryRow<{ title: string }>[] | undefined>(useSyncExternalStore(rows.subscribe, rows.getSnapshot));
