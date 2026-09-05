import { expectAssignable, expectError, expectType } from 'tsd';
import * as syncom from '../index.js';
import type {
  Block,
  Blockchain,
  CrdtDelta,
  KeyPair,
  Node,
  Reference,
  Schema,
  Storage,
  StorageOptions,
  SyncManager,
  SyncomCollection,
  SyncomRecord,
  SyncomTelemetryOptions,
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
expectType<Promise<string[]>>(syncom.list('dir'));

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
// A schema turns entity names into typed collections on the storage object.
syncom.open({ path: 'data', schema: { entities: { Post: {}, Author: {} } } }).then((typed) => {
  expectType<SyncomCollection>(typed.Post);
  expectType<SyncomCollection>(typed.Author);
  expectError(typed.Nope);
  expectType<Promise<string>>(typed.insert({ a: 1 }));
});
expectAssignable<StorageOptions>({ path: 'data', schema: {} as Schema });
expectAssignable<StorageOptions>({ getId: () => 'id' });
expectAssignable<StorageOptions>({ getId: async () => 'id' });
expectType<string>(syncom.Storage.generateId());
expectError(syncom.open({ path: 1 }));
expectError(syncom.open({ getId: 'nope' }));
expectType<Promise<string>>(storage.insert({ a: 1 }));
expectType<Promise<string>>(storage.insert({ a: 1 }, { encrypted: true }));
expectType<Promise<void>>(storage.set('id', { a: 1 }, { encrypted: false }));
expectAssignable<StorageOptions>({ encrypted: true });
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
record.off('update');
expectType<unknown>(record.title);
declare const reference: Reference;
expectType<Promise<SyncomRecord>>(reference.record());
expectType<unknown>(syncom.apply({}, [{ type: 'delete', id: 'r1' }]));
expectType<unknown>(syncom.apply({}, [{ type: 'delete', key: 'a' }]));

// sync
expectType<SyncManager>(storage.sync);
declare const sync: SyncManager;
expectType<Node[]>(sync.listNodes());
expectType<Promise<void>>(sync.addNode({ url: 'ws://a', token: 't', scopes: ['*'] }));
expectType<Promise<void>>(sync.addNode({ url: 'ws://a' }));
expectError(sync.addNode({ url: 'ws://a', type: 'uplink' }));
expectError(sync.addNode({ token: 't' }));
expectType<Promise<void>>(sync.start());
expectType<Promise<void>>(sync.stop());
expectType<Promise<SyncManager>>(new syncom.SyncManager(storage));

// replication model
expectType<string>(storage.nodeId);
expectType<syncom.VersionVector>(storage.vector);
expectType<Promise<void>>(storage.inc('id', 'hits'));
expectType<Promise<void>>(storage.inc('id', 'hits', 2));
expectType<Promise<string[]>>(storage.list());
expectType<Promise<void>>(storage.close());
expectType<Promise<syncom.ApplyRemoteResult>>(storage.applyRemote([], { via: 'link' }));
expectType<Promise<syncom.SnapshotPage>>(storage.snapshot({ cursor: null, limit: 10 }));
storage.on('change', (op, via) => {
  expectType<syncom.SyncOp>(op);
  expectType<unknown>(via);
});
declare const entry: syncom.Entry;
const applied = syncom.applyOp(null, { origin: 'a', seq: 1, ts: 1, type: 'set', id: 'r', data: { x: 1 } });
expectType<syncom.Entry>(applied.entry);
expectType<boolean>(applied.changed);
expectType<syncom.Entry | null>(syncom.mergeEntry(entry, null));
expectType<boolean>(syncom.isAlive(entry));
expectError(syncom.applyOp(null, { origin: 'a', seq: 1, ts: 1, type: 'nope', id: 'r' }));
expectType<Promise<syncom.OpLog>>(new syncom.OpLog('base', { rollAfter: 8, retention: { ops: 100 } }));
declare const log: syncom.OpLog;
expectType<syncom.LogEntry[] | null>(log.since(undefined, { scopes: ['*'], limit: 10 }));
expectType<Promise<syncom.LogEntry[]>>(log.append([]));
expectAssignable<StorageOptions>({ logger: false, sync: { scope: () => 'docs', retention: { ops: 10 } } });
expectError(syncom.open({ sync: { scope: 'docs' } }));

// telemetry — structural, so a real SDK fits without importing @opentelemetry/api.
expectAssignable<StorageOptions>({ telemetry: { api: {} } });
expectAssignable<StorageOptions>({ telemetry: { tracer: { startSpan: () => ({ end() {} }) } } });
expectAssignable<StorageOptions>({
  telemetry: {
    meter: { createCounter: () => ({ add() {} }), createHistogram: () => ({ record() {} }) },
    includeIdentity: false,
  },
});
expectAssignable<SyncomTelemetryOptions>({
  api: { trace: { getTracer: () => ({ startActiveSpan: (_n, _o, fn) => fn({ end() {} }) }) } },
});
expectError(syncom.open({ telemetry: 'yes' }));
expectError(syncom.open({ telemetry: { tracer: 'a tracer' } }));
expectType<Promise<syncom.OpLog>>(new syncom.OpLog('p', { telemetry: { api: {} } }));
declare const telemetryStorage: Storage;
expectType<unknown>(telemetryStorage.telemetry);

// hooks
const hookError = new syncom.HookError('beforeWrite', new Error('x'));
expectType<'HOOK_FAILED'>(hookError.code);
expectType<string>(hookError.hook);
expectType<unknown>(hookError.cause);
expectAssignable<Error>(hookError);
expectAssignable<StorageOptions>({
  hooks: {
    beforeWrite: async (ctx) => {
      expectType<string>(ctx.id);
      expectType<Record<string, unknown> | null>(ctx.current);
      expectType<boolean>(ctx.encrypted);
      return { ...ctx.data };
    },
    afterWrite: (ctx, op) => {
      expectType<syncom.SyncOp | null>(op);
      expectType<SyncomRecord | null>(ctx.source);
    },
    beforeRead: ({ id }) => {
      expectType<string>(id);
    },
    afterRead: (_ctx, data) => (data === null ? null : { ...(data as object), redacted: true }),
    beforeApply: ({ op, peer }) => {
      expectType<syncom.SyncOp>(op);
      expectType<syncom.PeerRef | null>(peer);
      return false;
    },
    afterApply: (batch) => {
      expectType<number>(batch.applied);
      expectType<syncom.SyncOp[]>(batch.ops);
    },
  },
});
expectError(syncom.open({ hooks: { nope: () => {} } }));
expectError(syncom.open({ hooks: { beforeWrite: 'x' } }));
expectError(syncom.open({ hooks: { beforeWrite: () => 'not an object' } }));
expectType<Promise<syncom.ApplyRemoteResult>>(storage.applyRemote([], { peer: { url: null, node: 'n' } }));
storage.applyRemote([]).then((result) => expectType<number>(result.skipped));
expectAssignable<StorageOptions>({
  sync: {
    connect: async () => ({}) as syncom.SyncLink,
    autoStart: false,
    pageSize: 100,
    hooks: {
      beforeConnect: (node) => {
        expectType<Node>(node);
        return false;
      },
      beforeBootstrap: ({ url, node }) => {
        expectType<string>(url);
        expectType<string>(node);
      },
    },
  },
});
expectError(syncom.open({ sync: { hooks: { nope: () => {} } } }));
expectError(syncom.open({ sync: { hooks: { beforeBootstrap: 'nope' } } }));
