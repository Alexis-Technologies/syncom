import { expectType } from 'tsd';
import { versions } from '../src/versions/versions.js';
import type { Plugin, Tag, TagView, HistoryResult, Patch } from '../src/versions/versions.js';
import { open } from '../index.js';

expectType<Plugin>(versions);
const storage = await open({ plugins: [versions] });
expectType<Promise<HistoryResult>>(storage.history('id'));
expectType<Promise<unknown>>(storage.get('id', { at: 'epoch:1' }));
expectType<Promise<Tag>>(storage.tag('v1'));
expectType<Tag[]>(storage.tags());
expectType<TagView>(storage.at('v1'));
expectType<Promise<Patch[]>>(storage.diff('id', 'epoch:1'));
expectType<Promise<number>>(storage.restore('id', { tag: 'v1' }));
// The present and its patches are the core's.
expectType<Promise<number>>((await open()).applyPatches('id', []));
expectType<Promise<number>>((await open()).compact('id'));
expectType<{ count: number; corrupt: boolean } | null>(storage.stats().tags);
