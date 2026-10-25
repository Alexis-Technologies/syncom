import { expectType } from 'tsd';
import {
  signing,
  calculateHash,
  generateSigningKeys,
  loadSigningKeys,
  sign,
  verify,
} from '../src/signing/signing.browser.js';
import type { Plugin, SigningKeyPair } from '../src/signing/signing.browser.js';

expectType<Plugin>(signing);
// Web Crypto is async where node:crypto is not.
expectType<Promise<string>>(calculateHash({ a: 1 }));
expectType<Promise<string>>(sign('message', 'priv'));
expectType<Promise<boolean>>(verify('message', 'signature', 'id'));
// The pairs keep the node signatures.
expectType<Promise<SigningKeyPair>>(generateSigningKeys());
expectType<Promise<SigningKeyPair>>(loadSigningKeys('keys'));
