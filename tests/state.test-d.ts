import { expectError, expectType } from 'tsd';
import { createState } from '../src/state/state.js';
import type { State } from '../src/state/state.js';
import type { Database } from '../index.js';

declare const db: Database;
const state: State = createState(db, 'ui', { local: true });
expectType<string>(state.id);
expectType<Promise<unknown>>(state.get('theme'));
expectType<Promise<{ theme: string }>>(state.get<{ theme: string }>());
expectType<Promise<string>>(state.set('theme', 'dark'));
expectType<Promise<number>>(state.set<number>('count', (n) => (n ?? 0) + 1));
expectType<Promise<{ fresh: boolean }>>(state.set({ fresh: true } as { fresh: boolean }));
expectType<Promise<void>>(state.delete('theme'));
expectType<() => void>(state.observe('theme', (value) => expectType<unknown>(value)));
expectType<() => void>(state.observe((value) => expectType<unknown>(value)));
expectError(createState(db));
