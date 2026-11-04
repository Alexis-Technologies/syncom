import { expectType } from 'tsd';
import { local } from '../src/local/local.js';
import type { Plugin, LocalStore } from '../src/local/local.js';
import { open } from '../index.js';

expectType<Plugin>(local);
const db = await open({ plugins: [local] });
expectType<LocalStore>(db.local);
expectType<Promise<{ panel: number } | null>>(db.local.get<{ panel: number }>('layout'));
expectType<Promise<number>>(db.local.set('n', 1));
expectType<Promise<void>>(db.local.delete('n'));
expectType<Promise<string[]>>(db.local.list());
expectType<() => void>(db.local.observe('n', (value) => expectType<unknown>(value)));
expectType<LocalStore>(db.local.scoped('Post'));
