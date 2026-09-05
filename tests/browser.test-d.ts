import { expectAssignable, expectType } from 'tsd';
import * as browser from '../browser.js';
import type { Blockchain, CrdtDelta, KeyPair, Storage, StorageOptions, SyncManager } from '../browser.js';

// The whole point of the split: Web Crypto is async where node:crypto is not.
expectType<Promise<string>>(browser.calculateHash({ a: 1 }));
expectType<Promise<string>>(browser.encrypt({ a: 1 }, 'pub'));
expectType<Promise<unknown>>(browser.decrypt('cipher', 'priv'));

// Everything else keeps the node signatures.
expectType<Promise<KeyPair>>(browser.generateKeys());
expectType<Promise<KeyPair>>(browser.loadKeys('keys'));
expectType<CrdtDelta>(browser.diff({ a: 1 }, { a: 2 }));
expectType<unknown>(browser.merge({ a: 1 }, { a: 2 }));
expectType<Promise<Blockchain>>(new browser.Blockchain('base'));
expectType<Promise<Storage>>(browser.open({ path: 'data' }));
expectType<Promise<Storage>>(browser.open({ path: 'data', getId: () => 'id' }));
expectType<Promise<Storage>>(browser.open({ path: 'data', telemetry: { api: {} } }));
// The id generator is not part of the async asymmetry: sync in both halves.
expectType<string>(browser.Storage.generateId());
expectType<Promise<string>>(browser.read('dir', 'file.json'));

declare const storage: Storage;
expectType<SyncManager>(storage.sync);
expectType<Promise<string[]>>(browser.list('dir'));
expectType<Promise<void>>(storage.inc('id', 'hits'));
expectType<boolean>(browser.isAlive(null));

// hooks and events reach the browser half unchanged
expectAssignable<StorageOptions>({
  hooks: { beforeWrite: () => undefined },
  sync: { hooks: { beforeConnect: () => false } },
});
