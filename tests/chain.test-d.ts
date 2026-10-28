import { expectType } from 'tsd';
import { chain, Blockchain } from '../src/chain/chain.js';
import type { Plugin, Block } from '../src/chain/chain.js';
import { open } from '../index.js';
import { memory } from '../src/memory/memory.js';

expectType<Plugin>(chain);
const storage = await open({ plugins: [chain] });
expectType<Promise<boolean>>(storage.validate());
// The constructor returns a promise: the class is async-initialised.
expectType<Promise<Blockchain>>(new Blockchain('base'));
expectType<Promise<Blockchain>>(new Blockchain('base', { fsi: memory() }));
declare const instance: Blockchain;
expectType<Promise<string>>(instance.addBlock({ id: 'r1', hash: 'h' }));
expectType<Promise<Block>>(instance.readBlock('hash'));
expectType<Promise<boolean>>(instance.validate({ last: 10 }));
expectType<Promise<boolean>>(instance.validate());
