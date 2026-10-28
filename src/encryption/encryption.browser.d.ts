// The browser half of @alexify/syncom/encryption (the `browser` export
// condition): the same plugin and wrapper over Web Crypto, which is async
// where node:crypto is not — `encrypt` and `decrypt` return promises here.

export type { Plugin, Fsi, KeyPair, AtRestOptions } from './encryption.js';
export { encryption, atRest, generateKeys, loadKeys } from './encryption.js';

export declare function encrypt(data: unknown, publicKey: string): Promise<string>;
export declare function decrypt(data: string, privateKey: string): Promise<unknown>;
