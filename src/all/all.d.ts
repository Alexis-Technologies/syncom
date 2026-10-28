// Everything in one import: the core with every plugin the package ships
// registered — the lists, the texts and the trees; signed ops under the
// node's key, the chain, the sealing of records. The types of the core and
// of those subpaths (`export *`) plus a Storage that has every plugin's
// methods, an `open()` that returns it, and `applyOp`/`mergeEntry` that fold
// under the same registry.

import type {
  Storage as CoreStorage,
  StorageConstructor as CoreStorageConstructor,
  StorageOptions,
  Schema,
  Collections,
  Plugin,
  PluginMethods,
  TextMethods,
  TreeMethods,
  Entry,
  SyncOp,
  ApplyResult,
  FoldLimits,
} from '../../index.js';
import type { SyncApi } from '../sync/sync.js';

export * from '../../index.js';
export * from '../signing/signing.js';
export * from '../chain/chain.js';
export * from '../encryption/encryption.js';
export * from '../memory/memory.js';
export * from '../layered/layered.js';
export * from '../sync/sync.js';
export * from '../schema/schema.js';
export * from '../telemetry/telemetry.js';
export * from '../query/query.js';
export * from '../versions/versions.js';

/** The storage with every shipped plugin registered: the core's API and the text and tree methods. */
export interface Storage extends CoreStorage, TextMethods, TreeMethods, SyncApi {}

export interface StorageConstructor extends Omit<CoreStorageConstructor, 'prototype' | 'new'> {
  readonly prototype: Storage;
  new <S extends Schema = Schema, const P extends readonly Plugin<any>[] = []>(
    options?: StorageOptions<S> & { plugins?: P },
  ): Promise<Storage & Collections<S> & PluginMethods<P>>;
}
export declare const Storage: StorageConstructor;

/** Opens a storage with every shipped plugin registered, ahead of the caller's. */
export declare function open<S extends Schema = Schema, const P extends readonly Plugin<any>[] = []>(
  options?: StorageOptions<S> & { plugins?: P },
): Promise<Storage & Collections<S> & PluginMethods<P>>;

/** The fold of one op under the shipped plugins' registry (`limits.plugins` overrides it). */
export declare function applyOp(entry: Entry | null, op: SyncOp, limits?: FoldLimits | null): ApplyResult;
/** The join of two entries under the shipped plugins' registry. */
export declare function mergeEntry(a: Entry | null, b: Entry | null, limits?: FoldLimits | null): Entry | null;

export declare const text: Plugin<TextMethods>;
export declare const tree: Plugin<TreeMethods>;
export declare const sync: Plugin<SyncApi>;
export declare const schema: Plugin;
export declare const telemetry: Plugin;
export declare const query: Plugin;
export declare const versions: Plugin;
/** The plugins the package ships, in registration order. */
export declare const PLUGINS: readonly [
  Plugin<TextMethods>,
  Plugin<TreeMethods>,
  Plugin,
  Plugin,
  Plugin,
  Plugin<SyncApi>,
  Plugin,
  Plugin,
  Plugin,
  Plugin,
];
