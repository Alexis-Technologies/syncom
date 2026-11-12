import { expectType } from 'tsd';
import { versions } from '../src/versions/versions.js';
import type { Plugin, Tag, TagView, HistoryResult, Patch } from '../src/versions/versions.js';
import { createDatabase } from '../index.js';
import type { RecordData } from '../index.js';

expectType<Plugin>(versions);
const storage = await createDatabase({ plugins: [versions] });
expectType<Promise<HistoryResult>>(storage.history('id'));
expectType<Promise<RecordData | null>>(storage.get('id', { at: 'epoch:1' }));
expectType<Promise<Tag>>(storage.tag('v1'));
expectType<Tag[]>(storage.tags());
expectType<TagView>(storage.at('v1'));
expectType<Promise<Patch[]>>(storage.diff('id', 'epoch:1'));
expectType<Promise<number>>(storage.restore('id', { tag: 'v1' }));
// The present and its patches are the core's.
expectType<Promise<number>>((await createDatabase()).applyPatches('id', []));
expectType<Promise<number>>((await createDatabase()).compact('id'));
expectType<{ count: number; corrupt: boolean } | null>(storage.stats().tags);
