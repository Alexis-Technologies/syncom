import { expectAssignable, expectType } from 'tsd';
import { memory } from '../src/memory/memory.js';
import type { Fsi, MemoryFsi } from '../src/memory/memory.js';
import { open } from '../index.js';

const fsi = memory();
expectType<MemoryFsi>(fsi);
expectAssignable<Fsi>(fsi);
expectType<number>(fsi.size);
expectType<Record<string, string>>(fsi.dump());
expectType<Promise<void>>(fsi.create('d', 'f.json', '{}'));
await open({ fsi });
