import { expectType } from 'tsd';
import { encryption, atRest, generateKeys, encrypt, decrypt, loadKeys } from '../src/encryption/encryption.browser.js';
import type { Plugin, Fsi, KeyPair } from '../src/encryption/encryption.browser.js';
import { createMemoryFsi } from '../index.js';

expectType<Plugin>(encryption);
expectType<Fsi>(atRest(createMemoryFsi(), { key: new Uint8Array(32) }));
// Web Crypto is async where node:crypto is not.
expectType<Promise<string>>(encrypt({ a: 1 }, 'pub'));
expectType<Promise<unknown>>(decrypt('cipher', 'priv'));
expectType<Promise<KeyPair>>(generateKeys());
expectType<Promise<KeyPair>>(loadKeys('keys'));
