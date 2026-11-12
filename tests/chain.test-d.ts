import { expectType } from 'tsd';
import { chain, Blockchain } from '../src/chain/chain.js';
import type { Plugin, Block } from '../src/chain/chain.js';
import { createDatabase } from '../index.js';
import { memory } from '../src/memory/memory.js';

expectType<Plugin>(chain);
const storage = await createDatabase({ plugins: [chain] });
expectType<Promise<boolean>>(storage.validate());
// The constructor returns a promise: the class is async-initialised.
expectType<Promise<Blockchain>>(new Blockchain('base'));
expectType<Promise<Blockchain>>(new Blockchain('base', { fsi: memory() }));
declare const instance: Blockchain;
expectType<Promise<string>>(instance.addBlock({ id: 'r1', hash: 'h' }));
// The block as a write set's kv puts, committed once the engine landed them.
const next = await instance.block({ id: 'r1', hash: 'h' });
expectType<string>(next.hash);
expectType<string>(next.puts[0][0]);
expectType<string>(next.puts[0][2]);
expectType<{ atomic?: boolean } | undefined>(next.puts[0][3]);
expectType<void>(instance.committed(next.hash));
expectType<Promise<Block>>(instance.readBlock('hash'));
expectType<Promise<boolean>>(instance.validate({ last: 10 }));
expectType<Promise<boolean>>(instance.validate());
