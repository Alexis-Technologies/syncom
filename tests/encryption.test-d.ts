import { expectAssignable, expectError, expectType } from 'tsd';
import { encryption, atRest, generateKeys, encrypt, decrypt, loadKeys } from '../src/encryption/encryption.js';
import type { Plugin, Fsi, KeyPair, AtRestOptions } from '../src/encryption/encryption.js';
import { open } from '../index.js';
import { memory } from '../src/memory/memory.js';

expectType<Plugin>(encryption);
const storage = await open({ plugins: [encryption], encrypted: true });
expectType<Promise<string>>(storage.insert({ a: 1 }, { encrypted: false }));
// The wrapper is a backend like the one it wraps.
expectType<Fsi>(atRest(memory(), { key: new Uint8Array(32) }));
expectType<Fsi>(atRest(memory(), { password: 'pw', salt: 'a salt of eight', iterations: 10_000 }));
expectAssignable<AtRestOptions>({ password: 'pw', salt: 'salt-salt' });
expectError(atRest(memory()));
expectError(atRest(memory(), { key: 'not bytes' }));
await open({ fsi: atRest(memory(), { key: new Uint8Array(32) }) });
// node:crypto is synchronous, unlike the browser half.
expectType<Promise<KeyPair>>(generateKeys());
expectType<string>(encrypt({ a: 1 }, 'pub'));
expectType<unknown>(decrypt('cipher', 'priv'));
expectType<Promise<KeyPair>>(loadKeys('keys', { fsi: memory() }));
