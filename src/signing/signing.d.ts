// Signed ops as a plugin (@alexify/syncom/signing): `open({ plugins: [signing] })`
// makes the node's identity its Ed25519 public key (`keys/sign-public.pem`,
// made at the first open; the raw key, base64url, is the node id), signs
// every op the node makes before it is appended, and verifies a peer's op
// against its origin before it is admitted — `sync.signatures` 'verify' (the
// default) checks what carries a signature, 'require' refuses what carries
// none. Without the plugin the node id is what `open({ getId })` mints (a
// UUID by default), nothing is signed and nothing is checked; 'require'
// without it is `PLUGIN_MISSING`. The key functions the plugin stands on are
// exported for the application's own use (a message signed by the node, a
// pair made ahead of time). Under the browser condition `calculateHash`,
// `sign` and `verify` return promises (signing.browser.d.ts).

import type { Plugin, Fsi, JSONSafe, KeyPair } from '../../index.js';

export type { Plugin, Fsi, JSONSafe, KeyPair };

/** The Ed25519 pair that signs a node's ops; `id` is the raw public key, base64url — the node id. */
export interface SigningKeyPair extends KeyPair {
  readonly id: string;
}

/** The plugin: the node id is its signing key, its ops are signed, a peer's are verified. */
export declare const signing: Plugin;

/** SHA-256 of `data`'s JSON, lowercase hex. */
export declare function calculateHash(data: JSONSafe): string;
export declare function generateSigningKeys(): Promise<SigningKeyPair>;
/** `sign-public.pem` and `sign-private.pem` under `basePath`: read, or made and written. */
export declare function loadSigningKeys(basePath: string, options?: { fsi?: Fsi }): Promise<SigningKeyPair>;
/** Signs `message` (UTF-8) with a PEM Ed25519 private key: 64 bytes, base64url. */
export declare function sign(message: string, privateKey: string): string;
/**
 * Whether `signature` is `publicKey`'s — a node id, the raw key base64url —
 * over `message`; `false`, never a throw, for a malformed key or signature.
 */
export declare function verify(message: string, signature: string, publicKey: string): boolean;
