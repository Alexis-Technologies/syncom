import { expectAssignable, expectError, expectType } from 'tsd';
import { createSearch, normalize, trigrams } from '../search.js';
import type { TextIndex } from '../search.js';
import { open } from '../index.js';
import type { StorageOptions } from '../index.js';

const factory = createSearch();
expectAssignable<StorageOptions['search']>(factory);
const index = factory('Post');
expectAssignable<TextIndex>(index);
expectType<number>(index.size);
expectType<void>(index.put('id', 'text'));
expectType<void>(index.remove('id'));
expectType<ReadonlyArray<{ id: string; score: number }>>(index.query('quick fox'));
expectType<string>(normalize('Crème'));
expectType<string[]>(trigrams('quick'));
expectAssignable<StorageOptions['search']>(createSearch({ minOverlap: 0.5 }));
expectError(createSearch({ minOverlap: 'high' }));
void open({ search: createSearch(), schema: { entities: { Post: { search: ['title'] } } } });
