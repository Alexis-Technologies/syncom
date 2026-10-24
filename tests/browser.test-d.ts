import { expectAssignable, expectType } from 'tsd';
import * as browser from '../browser.js';
import type {
  Blockchain,
  CrdtDelta,
  KeyPair,
  SigningKeyPair,
  Storage,
  StorageOptions,
  SyncManager,
} from '../browser.js';

// The whole point of the split: Web Crypto is async where node:crypto is not.
expectType<Promise<string>>(browser.calculateHash({ a: 1 }));
expectType<Promise<string>>(browser.encrypt({ a: 1 }, 'pub'));
expectType<Promise<unknown>>(browser.decrypt('cipher', 'priv'));
expectType<Promise<string>>(browser.sign('message', 'priv'));
expectType<Promise<boolean>>(browser.verify('message', 'signature', 'id'));

// Everything else keeps the node signatures.
expectType<Promise<KeyPair>>(browser.generateKeys());
expectType<Promise<KeyPair>>(browser.loadKeys('keys'));
expectType<Promise<SigningKeyPair>>(browser.generateSigningKeys());
expectType<Promise<SigningKeyPair>>(browser.loadSigningKeys('keys'));
expectType<CrdtDelta>(browser.diff({ a: 1 }, { a: 2 }));
expectType<unknown>(browser.merge({ a: 1 }, { a: 2 }));
expectType<Promise<Blockchain>>(new browser.Blockchain('base'));
expectType<Promise<Storage>>(browser.open({ path: 'data' }));
expectType<Promise<Storage>>(browser.open({ path: 'data', getId: () => 'id' }));
expectType<Promise<Storage>>(browser.open({ path: 'data', telemetry: { api: {} } }));
// The id generator is not part of the async asymmetry: sync in both halves.
expectType<string>(browser.Storage.generateId());
expectType<Promise<Storage>>(browser.open({ fsi: browser.createMemoryFsi(), durable: true }));
expectType<boolean>(browser.isFsi(browser.createMemoryFsi()));
expectType<'VALIDATION_FAILED'>(new browser.ValidationError('Post', []).code);
declare const browserStorage: Storage;
expectType<Promise<unknown>>(browserStorage.check('Post', {}));
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
// The types of the CRDT branch reach the browser half too.
expectAssignable<browser.Patch>({ action: 'put', field: 'n', value: 1 });
expectAssignable<browser.Version>({ tag: 'v1' });
expectAssignable<browser.TextSpan>({ text: 'hi', marks: {} });
expectAssignable<browser.CursorSide>('after');
expectAssignable<browser.MarkExpand>('none');
