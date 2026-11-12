// Encryption as blocks (@alexify/syncom/encryption): the `encryption` plugin
// is what `{ encrypted: true }` needs — a record sealed for this node's RSA
// pair (`keys/public.pem`, `keys/private.pem`), written outside the op log,
// never replicated; without it an encrypted write is `PLUGIN_MISSING`.
// `atRest(fsi | engine, …)` wraps a backend — or an engine — so that every file, or value, the storage writes
// through it is AES-256-GCM encrypted under one key — given as 32 bytes, or
// derived from a password and a salt the caller keeps (PBKDF2-SHA-256) —
// and decrypted on the way back; a file that is not the key's is
// `DECRYPT_FAILED`. Under the browser condition `encrypt` and `decrypt`
// return promises (encryption.browser.d.ts).

import type { Plugin, Fsi, KeyPair, EngineDb, Engine } from '../../index.js';

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
 * to `createDatabase({ fsi })`. `exists`, `remove`, `list` (and `sync`) pass through.
 */
export declare function atRest(fsi: Fsi, options: AtRestOptions): Fsi;
/**
 * An engine whose every value is encrypted at rest under one key — the records, their pieces, the copies, every
 * kv text, every log entry and the log's index, each bound to its place — give it to `createDatabase({ engine })`.
 * `capabilities.indexes` is false (the core's catalog is saved sealed); the files engine is wrapped at its backend.
 */
export declare function atRest(engine: Engine, options: AtRestOptions): Engine;

/**
 * The at-rest key rotated by a copy: the database at `path`, sealed under `from`, copied whole into `into` (`{ path }`
 * on the same engine or backend, `{ engine }`, `{ fsi }`, or a path with either) sealed under `to` — the same node;
 * never in place. Over a backend (the files engine, wrapped at its backend) give `{ fsi, filesEngine }`: the files
 * engine's factory, `filesEngine` of the main entry. The source is then fenced (`moved.json`): `createDatabase` there
 * is `MOVED` until `dropDatabase` takes it. Answers what `copyEngine` answers.
 */
export declare function rotateAtRest(
  engine: Engine,
  options: {
    path: string;
    from: AtRestOptions;
    to: AtRestOptions;
    into: { path?: string; engine?: Engine };
    batch?: number;
  },
): Promise<import('../engines/engines.js').CopyEngineResult>;
export declare function rotateAtRest(
  backend: { fsi: Fsi; filesEngine: (fsi: Fsi) => Engine },
  options: {
    path: string;
    from: AtRestOptions;
    to: AtRestOptions;
    into: { path?: string; fsi?: Fsi };
    batch?: number;
  },
): Promise<import('../engines/engines.js').CopyEngineResult>;
export declare function generateKeys(): Promise<KeyPair>;
export declare function encrypt(data: unknown, publicKey: string): string;
export declare function decrypt(data: string, privateKey: string): unknown;
/** `public.pem` and `private.pem` under `basePath`: read, or made and written. */
export declare function loadKeys(basePath?: string, options?: { fsi?: Fsi; kv?: EngineDb['kv'] }): Promise<KeyPair>;
