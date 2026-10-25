// Encryption as blocks (@alexify/syncom/encryption): the `encryption` plugin
// is what `{ encrypted: true }` needs — a record sealed for this node's RSA
// pair (`keys/public.pem`, `keys/private.pem`), written outside the op log,
// never replicated; without it an encrypted write is `PLUGIN_MISSING`.
// `atRest(fsi, …)` wraps a backend so that every file the storage writes
// through it is AES-256-GCM encrypted under one key — given as 32 bytes, or
// derived from a password and a salt the caller keeps (PBKDF2-SHA-256) —
// and decrypted on the way back; a file that is not the key's is
// `DECRYPT_FAILED`. Under the browser condition `encrypt` and `decrypt`
// return promises (encryption.browser.d.ts).

import type { Plugin, Fsi, KeyPair } from '../../index.js';

export type { Plugin, Fsi, KeyPair };

/** The plugin behind `{ encrypted: true }`: records sealed for this node's RSA pair. */
export declare const encryption: Plugin;

export interface AtRestOptions {
  /** 32 bytes, or a Web Crypto AES-GCM key; the alternative to a password. */
  key?: Uint8Array | CryptoKey;
  /** With `salt`: the key is derived by PBKDF2-SHA-256, `iterations` times (600 000 by default). */
  password?: string;
  /** 8 characters or more, kept by the caller — the derivation needs the same one every open. */
  salt?: string;
  iterations?: number;
}

/**
 * A backend whose every file is encrypted at rest under one key — give it
 * to `open({ fsi })`. `exists`, `remove`, `list` (and `sync`) pass through.
 */
export declare function atRest(fsi: Fsi, options: AtRestOptions): Fsi;

export declare function generateKeys(): Promise<KeyPair>;
export declare function encrypt(data: unknown, publicKey: string): string;
export declare function decrypt(data: string, privateKey: string): unknown;
/** `public.pem` and `private.pem` under `basePath`: read, or made and written. */
export declare function loadKeys(basePath: string, options?: { fsi?: Fsi }): Promise<KeyPair>;
