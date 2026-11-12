import type { Engine } from '../index.js';
import { expectAssignable, expectError, expectType } from 'tsd';
import {
  encryption,
  atRest,
  rotateAtRest,
  generateKeys,
  encrypt,
  decrypt,
  loadKeys,
} from '../src/encryption/encryption.js';
import type { Plugin, Fsi, KeyPair, AtRestOptions } from '../src/encryption/encryption.js';
import { createDatabase, filesEngine } from '../index.js';
import { memory, memoryEngine } from '../src/memory/memory.js';

expectType<Plugin>(encryption);
const storage = await createDatabase({ plugins: [encryption], encrypted: true });
expectType<Promise<string>>(storage.insert({ a: 1 }, { encrypted: false }));
// The wrapper is a backend like the one it wraps.
expectType<Fsi>(atRest(memory(), { key: new Uint8Array(32) }));
expectType<Engine>(atRest(memoryEngine(), { key: new Uint8Array(32) }));
const rotated = await rotateAtRest(memoryEngine(), {
  path: 'app',
  from: { key: new Uint8Array(32) },
  to: { key: new Uint8Array(32) },
  into: { path: 'app-2' },
});
expectType<number>(rotated.records);
expectType<number>(rotated.blobs);
const overBackend = await rotateAtRest(
  { fsi: memory(), filesEngine },
  { path: 'app', from: { key: new Uint8Array(32) }, to: { key: new Uint8Array(32) }, into: { fsi: memory() } },
);
expectType<number>(overBackend.blobs);
expectError(
  rotateAtRest({ fsi: memory(), filesEngine }, { path: 'app', from: {}, to: {}, into: { engine: memoryEngine() } }),
);
await createDatabase({ engine: atRest(memoryEngine(), { key: new Uint8Array(32) }) });
expectType<Fsi>(atRest(memory(), { password: 'pw', salt: 'a salt of eight', iterations: 10_000 }));
expectAssignable<AtRestOptions>({ password: 'pw', salt: 'salt-salt' });
expectError(atRest(memory()));
expectError(atRest(memory(), { key: 'not bytes' }));
await createDatabase({ fsi: atRest(memory(), { key: new Uint8Array(32) }) });
// node:crypto is synchronous, unlike the browser half.
expectType<Promise<KeyPair>>(generateKeys());
expectType<string>(encrypt({ a: 1 }, 'pub'));
expectType<unknown>(decrypt('cipher', 'priv'));
expectType<Promise<KeyPair>>(loadKeys('keys', { fsi: memory() }));
