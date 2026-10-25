import { expectAssignable, expectError, expectType } from 'tsd';
import { layered } from '../src/layered/layered.js';
import type { Fsi, LayeredFsi, LayeredOptions } from '../src/layered/layered.js';
import { memory } from '../src/memory/memory.js';
import { open } from '../index.js';

const fsi = layered([memory(), memory()], { write: 'back', fill: false, queue: 16 });
expectType<LayeredFsi>(fsi);
expectAssignable<Fsi>(fsi);
expectType<readonly Fsi[]>(fsi.layers);
expectType<number>(fsi.pending);
expectType<Promise<void>>(fsi.flush());
expectType<Promise<void>>(fsi.close());
expectType<Promise<void>>(fsi.create('d', 'lock.json', '{}'));
expectAssignable<LayeredOptions>({ write: 'through' });
expectError(layered([memory()], { write: 'sideways' }));
expectError(layered(memory()));
await open({ fsi });
