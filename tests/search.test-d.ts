import { expectAssignable, expectError, expectType } from 'tsd';
import {
  createSearch,
  normalize,
  trigrams,
  cosine,
  euclidean,
  manhattan,
  dot,
  isVector,
} from '../src/search/search.js';
import type { TextIndex, Distance } from '../src/search/search.js';
import { createDatabase } from '../index.js';
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
expectType<number>(cosine([1, 0], [0, 1]));
expectAssignable<Distance>(euclidean);
expectAssignable<Distance>(manhattan);
expectAssignable<Distance>(dot);
expectType<boolean>(isVector([1]));
void createDatabase({ search: createSearch(), schema: { entities: { Post: { search: ['title'] } } } });
