import { expectAssignable, expectError, expectType } from 'tsd';
import * as syncom from '../index.js';
import type {
  Block,
  Blockchain,
  CrdtDelta,
  KeyPair,
  Node,
  Schema,
  Storage,
  StorageOptions,
  SyncManager,
  SyncomCollection,
  SyncomRecord,
} from '../index.js';

// crypto — node:crypto is synchronous, unlike the browser half.
expectType<string>(syncom.calculateHash({ a: 1 }));
expectType<Promise<KeyPair>>(syncom.generateKeys());
expectType<string>(syncom.encrypt({ a: 1 }, 'pub'));
expectType<unknown>(syncom.decrypt('cipher', 'priv'));
expectType<Promise<KeyPair>>(syncom.loadKeys('keys'));
expectError(syncom.calculateHash(() => 1));

// fsi
expectType<Promise<string>>(syncom.read('dir', 'file.json'));
expectType<Promise<void>>(syncom.write('dir', 'file.json', '{}'));
expectType<Promise<boolean>>(syncom.exists('dir', 'file.json'));
expectType<Promise<void>>(syncom.remove('dir', 'file.json'));

// crdt
expectType<CrdtDelta>(syncom.diff({ a: 1 }, { a: 2 }));
expectType<unknown>(syncom.merge({ a: 1 }, { a: 2 }));
expectType<unknown>(syncom.apply({}, [{ type: 'inc', key: 'hits', value: 1 }]));
expectError(syncom.apply({}, [{ type: 'nope' }]));

// chain — the constructor returns a promise, the class is async-initialised.
expectType<Promise<Blockchain>>(new syncom.Blockchain('base'));
declare const chain: Blockchain;
expectType<Promise<string>>(chain.addBlock({ id: 'r1', hash: 'h' }));
expectType<Promise<Block>>(chain.readBlock('hash'));
expectType<Promise<boolean>>(chain.validate({ last: 10 }));
expectType<Promise<boolean>>(chain.validate());

// contracts
declare const storage: Storage;
const reader = new syncom.DataReader(storage);
expectType<Promise<unknown>>(reader.get('id'));
expectType<Promise<string>>(syncom.SmartContract.save('name', chain, async () => 1));
expectType<Promise<syncom.SmartContract>>(syncom.SmartContract.load('hash', { storage, chain }));

// storage
expectType<Promise<Storage>>(syncom.open());
expectType<Promise<Storage>>(syncom.open({ path: 'data' }));
expectAssignable<StorageOptions>({ path: 'data', schema: {} as Schema });
expectAssignable<StorageOptions>({ getId: () => 'id' });
expectAssignable<StorageOptions>({ getId: async () => 'id' });
expectType<string>(syncom.Storage.generateId());
expectError(syncom.open({ path: 1 }));
expectError(syncom.open({ getId: 'nope' }));
expectType<Promise<string>>(storage.insert({ a: 1 }));
expectType<Promise<unknown>>(storage.get('id'));
expectType<Promise<boolean>>(storage.has('id'));
expectType<Promise<boolean>>(storage.swap('id', { a: 2 }, { a: 1 }));
expectType<Promise<SyncomRecord>>(storage.record('id'));
expectType<boolean>(storage.hasRecord('id'));

// The record/collection pair reached through the Storage namespace.
expectAssignable<typeof SyncomCollection>(syncom.Storage.Collection);
declare const record: SyncomRecord;
expectType<string>(record.id);
expectType<Promise<unknown>>(record.data());
expectType<Record<string, unknown>>(record.delta());
record.on('update', (data, delta) => {
  expectType<unknown>(data);
  expectType<unknown>(delta);
});

// sync
expectType<SyncManager>(storage.sync);
declare const sync: SyncManager;
expectType<Node[]>(sync.listNodes());
expectType<Promise<void>>(sync.addNode({ url: 'ws://a', type: 'uplink' }));
expectError(sync.addNode({ url: 'ws://a', type: 'sideways' }));
