import { expectError, expectType } from 'tsd';
import { between, spread, compare, isKey } from '../order.js';

expectType<string>(between());
expectType<string>(between('V', null, { jitter: 2 }));
expectType<string[]>(spread(null, 'V', 3));
expectType<-1 | 0 | 1>(compare('V', 'WV'));
expectType<boolean>(isKey('V'));
expectError(between(1));
