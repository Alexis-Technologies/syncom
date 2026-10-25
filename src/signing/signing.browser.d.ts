// The browser half of @alexify/syncom/signing (the `browser` export
// condition): the same plugin and key pairs over Web Crypto, which is async
// where node:crypto is not — `calculateHash`, `sign` and `verify` return
// promises here.

import type { JSONSafe } from '../../index.js';

export type { Plugin, Fsi, JSONSafe, KeyPair, SigningKeyPair } from './signing.js';
export { signing, generateSigningKeys, loadSigningKeys } from './signing.js';

export declare function calculateHash(data: JSONSafe): Promise<string>;
export declare function sign(message: string, privateKey: string): Promise<string>;
export declare function verify(message: string, signature: string, publicKey: string): Promise<boolean>;
