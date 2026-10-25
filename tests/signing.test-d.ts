import { expectAssignable, expectError, expectType } from 'tsd';
import { signing, calculateHash, generateSigningKeys, loadSigningKeys, sign, verify } from '../src/signing/signing.js';
import type { Plugin, KeyPair, SigningKeyPair } from '../src/signing/signing.js';
import { open, createMemoryFsi } from '../index.js';

expectType<Plugin>(signing);
const storage = await open({ plugins: [signing], sync: { signatures: 'require' } });
expectType<string>(storage.nodeId);
// node:crypto is synchronous, unlike the browser half.
expectType<string>(calculateHash({ a: 1 }));
expectError(calculateHash(() => 1));
expectType<Promise<SigningKeyPair>>(generateSigningKeys());
expectType<Promise<SigningKeyPair>>(loadSigningKeys('keys', { fsi: createMemoryFsi() }));
expectType<string>(sign('message', 'private'));
expectType<boolean>(verify('message', 'signature', 'id'));
declare const pair: SigningKeyPair;
expectType<string>(pair.id);
expectAssignable<KeyPair>(pair);
