import { expectAssignable, expectType } from 'tsd';
import { memory, memoryEngine } from '../src/memory/memory.js';
import type { Fsi, MemoryFsi, MemoryEngine, Engine } from '../src/memory/memory.js';
import { createDatabase } from '../index.js';

const fsi = memory();
expectType<MemoryFsi>(fsi);
expectAssignable<Fsi>(fsi);
expectType<number>(fsi.size);
expectType<Record<string, string>>(fsi.dump());
expectType<Promise<void>>(fsi.create('d', 'f.json', '{}'));
await createDatabase({ fsi });

const engine = memoryEngine();
expectType<MemoryEngine>(engine);
expectAssignable<Engine>(engine);
expectType<string[]>(engine.paths);
await createDatabase({ engine });
