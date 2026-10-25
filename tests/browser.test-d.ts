import { expectAssignable, expectType } from 'tsd';
import * as browser from '../browser.js';
import type { CrdtDelta, Storage, StorageOptions, SyncManager } from '../browser.js';

// The split is the files layer; the crypto halves are the subpaths' (signing.browser.d.ts).
expectType<CrdtDelta>(browser.diff({ a: 1 }, { a: 2 }));
expectType<unknown>(browser.merge({ a: 1 }, { a: 2 }));
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
