import { expectAssignable, expectError, expectType } from 'tsd';
import * as syncom from '../index.js';
import type {
  Block,
  Blockchain,
  CrdtDelta,
  EntityDefinition,
  Fsi,
  KeyPair,
  Node,
  SigningKeyPair,
  Reference,
  Schema,
  Storage,
  StorageOptions,
  SyncManager,
  SyncomCollection,
  SyncomError,
  SyncomErrorCode,
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

// backends
expectAssignable<Fsi>(syncom.createMemoryFsi());
expectType<number>(syncom.createMemoryFsi().size);
expectType<Record<string, string>>(syncom.createMemoryFsi().dump());
expectType<boolean>(syncom.isFsi({}));
expectAssignable<StorageOptions>({ fsi: syncom.createMemoryFsi(), durable: true });
expectAssignable<Fsi>({
  read: async () => '',
  write: async () => {},
  exists: async () => true,
  remove: async () => {},
  list: async () => [],
});
expectError(syncom.open({ fsi: {} }));
expectError(syncom.open({ durable: 'yes' }));
expectAssignable<StorageOptions>({ lock: 'wait' });
expectAssignable<StorageOptions>({ lock: false });
expectError(syncom.open({ lock: 'maybe' }));
expectError(syncom.open({ lock: true }));
expectAssignable<StorageOptions>({ cache: { max: 100 }, integrity: 'lazy', catalog: { flushEvery: 10 } });
expectError(syncom.open({ integrity: 'trust' }));
expectError(syncom.open({ cache: { max: 'many' } }));
expectType<Fsi>(storage.fsi);
expectType<Promise<KeyPair>>(syncom.loadKeys('keys', { fsi: syncom.createMemoryFsi() }));
expectType<Promise<SigningKeyPair>>(syncom.generateSigningKeys());
expectType<Promise<SigningKeyPair>>(syncom.loadSigningKeys('keys', { fsi: syncom.createMemoryFsi() }));
expectType<string>(syncom.sign('message', 'private'));
expectType<boolean>(syncom.verify('message', 'signature', 'id'));
declare const signing: SigningKeyPair;
expectType<string>(signing.id);
expectAssignable<KeyPair>(signing);
expectType<Promise<Blockchain>>(new syncom.Blockchain('base', { fsi: syncom.createMemoryFsi() }));
expectType<Promise<syncom.OpLog>>(new syncom.OpLog('base', { fsi: syncom.createMemoryFsi() }));

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

// storage
declare const storage: Storage;
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
// Entity definitions: a validator of any of the three shapes, the id key, the indexes.
expectAssignable<StorageOptions>({
  schema: {
    version: 2,
    entities: {
      Project: { schema: {}, idField: 'projectId', index: ['orgId'], unique: ['slug', ['orgId', 'name']] },
      Fn: { schema: (data: unknown) => data !== null, idField: false },
      Thin: { schema: { fields: {} }, validate: false, fields: { title: 'string' } },
    },
  },
  validator: { compile: () => (data) => data },
});
expectAssignable<EntityDefinition>({ schema: {}, validate: false });
expectAssignable<EntityDefinition>({});
expectAssignable<StorageOptions>({ schema: { version: 2, snapshot: { any: 'json' } } });
expectAssignable<StorageOptions>({
  schema: {
    version: 3,
    migrations: {
      2: { up: (data) => ({ ...data, two: true }) },
      3: { Post: { up: async (data, ctx) => ({ ...data, entity: ctx.entity, from: ctx.from }) } },
    },
    ahead: 'hold',
    lens: 'migrations',
  },
});
expectError(syncom.open({ schema: { ahead: 'ignore' } }));
expectError(syncom.open({ schema: { lens: 'none' } }));
expectError(syncom.open({ schema: { version: 2, migrations: { 2: { up: 'rename' } } } }));
expectType<Promise<{ migrated: number; counters: number; sets: number; lists: number; texts: number; trees: number }>>(
  storage.migrate({ entities: ['Post'], batch: 10 }),
);
expectType<{ replayed: number; lost: number } | null>(storage.schemaInfo!.held);
storage.on('schema', (event) => {
  if (event.kind === 'ahead') {
    expectType<boolean>(event.held);
    expectType<syncom.SyncOp>(event.op);
  }
});
expectType<syncom.LogEntry[]>(log.held());
expectType<number | undefined>(log.held()[0].held);
expectType<number>(log.droppedHeld);
expectType<Promise<syncom.LogEntry[]>>(log.append([], { skipped: null, held: new Map() }));
expectType<syncom.SchemaStatus | null>(storage.schemaInfo);
expectType<syncom.SchemaInfo | null>(storage.schemaInfo!.previous);
storage.on('schema', (event) => {
  if (event.kind === 'drift') {
    expectType<syncom.PeerRef>(event.peer);
    expectType<string>(event.local);
  }
});
expectError(syncom.open({ schema: { version: '2' } }));
expectError(syncom.open({ schema: { lenses: {} } }));
expectError(syncom.open({ schema: { entities: { P: { idField: 1 } } } }));
expectError(syncom.open({ schema: { entities: { P: { validate: true } } } }));
expectError(syncom.open({ schema: { entities: { P: { index: 'orgId' } } } }));
expectError(syncom.open({ schema: { entities: { P: { uniqe: ['slug'] } } } }));
expectError(syncom.open({ validator: {} }));
expectType<Promise<unknown>>(storage.check('Project', { title: 'a' }));
const validationError = new syncom.ValidationError('Project', [
  { path: ['title'], message: 'is required', code: 'required' },
]);
expectType<'VALIDATION_FAILED'>(validationError.code);
expectType<string | null>(validationError.entity);
expectType<syncom.ValidationIssue[]>(validationError.issues);
expectAssignable<Error>(validationError);
expectAssignable<StorageOptions>({ actor: 'u1' });
expectAssignable<StorageOptions>({ actor: async () => 'u1' });
expectError(syncom.open({ actor: 42 }));
expectType<Promise<void>>(storage.update('id', { a: 1 }, { actor: 'u2' }));
expectType<Promise<void>>(storage.inc('id', 'hits', 1, { actor: 'u2' }));
expectType<Promise<void>>(storage.add('id', 'tags', ['a', 1, { b: 2 }], { actor: 'u2' }));
expectType<Promise<void>>(storage.remove('id', 'tags', ['a'] as const));
expectError(storage.add('id', 'tags', 'a'));
expectError(storage.add('id', 7, ['a']));
expectError(storage.remove('id', 'tags'));
expectType<Promise<void>>(storage.splice('id', 'body', 0, 0, 'hi', { actor: 'u2' }));
expectType<Promise<void>>(storage.splice('id', 'items', 1, 2));
expectType<Promise<void>>(storage.push('id', 'items', [1, { a: 2 }]));
expectError(storage.splice('id', 'body', 'x', 0, 'hi'));
expectError(storage.push('id', 'body', 5));
expectAssignable<syncom.SyncOp>({
  origin: 'a',
  seq: 3,
  ts: 3,
  type: 'splice',
  id: 'r',
  key: 'body',
  value: { at: '^', content: 'hi' },
});
expectAssignable<syncom.SplicePayload>({ cut: [['1:a', 0, 2]], content: '' });
expectType<Promise<void>>(storage.setAt('id', 'items', 0, { done: true }));
expectType<Promise<number>>(storage.updateText('id', 'body', 'hello', { actor: 'u2' }));
expectError(storage.updateText('id', 'body', 5));
expectType<Promise<number>>(record.updateText('body', 'x'));
expectType<Promise<string | null>>(storage.mark('id', 'body', 0, 5, 'bold', true, { expand: 'after' }));
expectType<Promise<string | null>>(storage.mark('id', 'body', 0, 5, 'comment', { by: 'ada' }, { many: true }));
expectType<Promise<void>>(storage.unmark('id', 'body', 0, 5, 'bold'));
expectType<Promise<void>>(storage.unmarkById('id', 'body', '1:a'));
expectError(storage.unmark('id', 'body', '1:a'));
expectType<Promise<syncom.TextSpan[] | null>>(storage.spans('id', 'body'));
expectError(storage.mark('id', 'body', 0, 5, 'bold', true, { expand: 'sideways' }));
expectType<Promise<string | null>>(record.mark('body', 0, 1, 'em', true));
expectType<Promise<syncom.TextSpan[] | null>>(record.spans('body'));
expectAssignable<syncom.SyncOp>({
  origin: 'a',
  seq: 5,
  ts: 5,
  type: 'mark',
  id: 'r',
  key: 'body',
  value: { start: '^', end: '$', key: 'bold', value: true },
});
expectAssignable<syncom.MarkPayload>({ off: '1:a' });
expectType<Promise<string | null>>(storage.cursor('id', 'body', 3, { side: 'after' }));
expectType<Promise<number | null>>(storage.index('id', 'body', '<1:0:a'));
expectError(storage.cursor('id', 'body', 3, { side: 'left' }));
expectType<Promise<string | null>>(record.cursor('body', 0));
expectType<Promise<number | null>>(record.index('body', '^'));
expectType<Promise<void>>(storage.move('id', 'items', 0, 2, { actor: 'u2' }));
expectError(storage.setAt('id', 'items', 'x', 1));
expectError(storage.move('id', 'items', 0));
expectAssignable<syncom.SyncOp>({
  origin: 'a',
  seq: 4,
  ts: 4,
  type: 'assign',
  id: 'r',
  key: 'items',
  value: { elem: '1:0:a', value: 1 },
});
expectAssignable<syncom.MovePayload>({ elem: '1:0:a', cut: ['1:a', 0, 1], at: '^', value: 1 });
expectType<syncom.SequenceBlock>(entry.meta.seqs.body);
expectType<Promise<void>>(storage.treeMove('id', 'outline', 'n1'));
expectType<Promise<void>>(storage.treeMove('id', 'outline', 'n2', 'n1', { after: 'n3', actor: 'u2' }));
expectType<Promise<void>>(storage.treeRemove('id', 'outline', 'n2'));
expectError(storage.treeMove('id', 'outline', 5));
expectError(storage.treeMove('id', 'outline', 'n2', 'n1', { after: 3 }));
expectType<Promise<void>>(record.treeMove('outline', 'n1', null, { before: 'n2' }));
expectType<Promise<void>>(record.treeRemove('outline', 'n1'));
expectAssignable<syncom.SyncOp>({
  origin: 'a',
  seq: 6,
  ts: 6,
  type: 'tree',
  id: 'r',
  key: 'outline',
  value: { node: 'n1', parent: null, fi: 'V' },
});
expectAssignable<syncom.TreePayload>({ node: 'n1', parent: '$trash', fi: 'V' });
expectType<syncom.TreeBlock>(entry.meta.trees.outline);
expectAssignable<syncom.TreeNode[]>([{ id: 'n1', children: [] }]);
expectAssignable<syncom.FieldKind>('tree');
expectAssignable<syncom.SyncomErrorCode>('CYCLE');
expectType<Promise<void>>(storage.delete('id', { actor: 'u2' }));
expectType<Promise<void>>(storage.purge('id', { actor: 'u2' }));
expectType<Promise<number>>(log.scrub('id'));
expectType<true | undefined>(log.held()[0].scrubbed);
expectAssignable<syncom.SyncOp>({ origin: 'a', seq: 1, ts: 1, type: 'purge', id: 'r' });
expectType<syncom.ClockStamp | null | undefined>(entry.meta.purged);
expectAssignable<syncom.SyncOp>({ origin: 'a', seq: 1, ts: 1, type: 'add', id: 'r', key: 't', value: ['x', 1] });
expectAssignable<syncom.SyncOp>({
  origin: 'a',
  seq: 2,
  ts: 2,
  type: 'remove',
  id: 'r',
  key: 't',
  value: [['x', { a: 1 }]],
});
expectType<{ [elementKey: string]: { [origin: string]: readonly [number, number] } }>(entry.meta.sets.tags);
expectAssignable<syncom.FieldKind>('set');
expectAssignable<syncom.FieldKind>('list');
expectAssignable<syncom.FieldKind>('text');
expectAssignable<syncom.RefusalReason>('bound');
expectAssignable<syncom.RefusalReason>('malformed');
expectAssignable<syncom.Refusal>({ field: 'body', reason: 'bound', detail: 'pending', count: 1, max: 4096 });
expectAssignable<syncom.Refusal>({ field: null, reason: 'malformed' });
expectError<syncom.FieldKind>('map');
expectAssignable<syncom.SetRemoval>(['x', { a: 1 }]);
expectAssignable<EntityDefinition>({ search: ['title', 'body'] });
expectError(syncom.open({ schema: { entities: { P: { search: 'title' } } } }));
expectError(syncom.open({ search: 'yes' }));
declare const textIndex: syncom.TextIndex;
expectType<void>(textIndex.put('id', 'text'));
expectType<ReadonlyArray<{ id: string; score: number }>>(textIndex.query('text'));
expectAssignable<StorageOptions>({ search: () => textIndex });
expectAssignable<syncom.MangoQuery>({ $text: 'quick fox', orgId: 'o1' });
expectError<syncom.MangoQuery>({ $text: 1 });
expectType<Promise<boolean>>(storage.swap('id', { a: 2 }, { a: 1 }, { actor: 'u2' }));
expectType<Promise<string>>(storage.insert({ a: 1 }, { actor: 'u2', encrypted: false }));
expectType<Promise<void>>(record.save({ actor: 'u2' }));
expectType<Promise<void>>(record.add('tags', ['x']));
expectType<Promise<void>>(record.remove('tags', ['x'], { actor: 'u2' }));
expectError(record.add('tags', 'x'));
expectType<Promise<void>>(record.splice('body', 0, 1, 'x'));
expectType<Promise<void>>(record.push('items', [1]));
expectType<Promise<void>>(record.setAt('items', 0, 'x'));
expectType<Promise<void>>(record.move('items', 0, 1));
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
expectType<Promise<syncom.ApplyRemoteResult>>(storage.applyRemote([], { via: { url: 'ws://x', node: 'n' } }));
expectType<Promise<syncom.SnapshotPage>>(storage.snapshot({ cursor: null, limit: 10 }));
storage.on('change', (op, via) => {
  expectType<syncom.SyncOp>(op);
  expectType<syncom.PeerRef | null>(via);
  expectType<string | undefined>(op.actor);
});
declare const entry: syncom.Entry;
const applied = syncom.applyOp(null, { origin: 'a', seq: 1, ts: 1, type: 'set', id: 'r', data: { x: 1 }, v: 2 });
expectType<number | undefined>(applied.entry.meta.v);
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
expectAssignable<SyncomError>(hookError);
expectAssignable<SyncomError>(validationError);

// errors: operational ones carry a code from the union
const coded = new syncom.SyncomError('NOT_FOUND', 'Record x not found', { cause: new Error('y'), id: 'x' });
expectType<SyncomErrorCode>(coded.code);
expectAssignable<Error>(coded);
expectAssignable<SyncomErrorCode>('LOCKED');
expectAssignable<SyncomErrorCode>('IDENTITY_MISMATCH');
expectAssignable<SyncomErrorCode>('BAD_SIGNATURE');
expectAssignable<SyncomErrorCode>('UNSIGNED');
expectAssignable<StorageOptions>({ sync: { signatures: 'require' } });
expectAssignable<StorageOptions>({ sync: { signatures: false } });
expectError(syncom.open({ sync: { signatures: 'yes' } }));
expectType<'verify' | 'require' | false>(storage.signatures);
expectAssignable<syncom.SyncOp>({
  origin: 'a',
  seq: 1,
  ts: 1,
  type: 'delete',
  id: 'r',
  sig: 's',
  digest: 'd',
  nonce: 'n',
});
expectError(new syncom.SyncomError('NOT_A_CODE', 'x'));
expectAssignable<Error>(hookError);
expectAssignable<StorageOptions>({
  hooks: {
    beforeWrite: async (ctx) => {
      expectType<string>(ctx.id);
      expectType<Record<string, unknown> | null>(ctx.current);
      expectType<boolean>(ctx.encrypted);
      expectType<number | null>(ctx.v);
      expectType<string | null>(ctx.actor);
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

// events
storage.once('apply', (batch) => {
  expectType<number>(batch.skipped);
  expectType<syncom.SyncOp[]>(batch.ops);
});
storage.on('error', (error) => {
  expectType<syncom.SyncOp>(error.op);
  expectType<syncom.ValidationIssue[] | undefined>(error.issues);
  expectType<syncom.RefusalReason | undefined>(error.rejected?.[0]?.reason);
  expectType<number | undefined>(error.count);
  if (error.code === 'BAD_SIGNATURE' || error.code === 'UNSIGNED') expectType<syncom.SyncOp>(error.op);
});
storage.applyRemote([]).then((result) => {
  expectType<number>(result.unsigned);
  expectType<number>(result.forged);
});
syncom.open({ schema: { entities: { Post: {} } } }).then((typed) => {
  expectType<Promise<void>>(typed.Post.set('id', { title: 'a' }));
  expectType<Promise<void>>(typed.Post.set('id', { title: 'a' }, { encrypted: false }));
  const cursor = typed.Post.select({ orgId: 'o', createdAt: { $gte: 1 }, $or: [{ a: 1 }, { b: { $exists: false } }] });
  expectType<syncom.Cursor>(cursor);
  expectType<Promise<syncom.QueryRow[]>>(cursor.order('name').desc('createdAt').limit(20).offset(0).fetch());
  expectType<Promise<number>>(cursor.count());
  expectType<Promise<syncom.QueryRow | null>>(cursor.one());
  expectType<() => void>(
    cursor
      .filter((row) => row.id !== 'x')
      .projection(['name'])
      .watch((rows) => rows.length),
  );
  expectType<Promise<number>>(typed.Post.count());
  expectError(cursor.order(1));
  expectError(typed.Post.select('orgId'));
});
storage.on('conflict', (event) => {
  expectType<'unique'>(event.kind);
  expectType<string[]>(event.fields);
  expectType<string>(event.other);
});
expectType<string | undefined>(validationError.issues[0].conflict);
storage.on('close', () => {});
expectType<number>(storage.listenerCount('change'));
expectError(storage.on('nope', () => {}));
sync.on('peer', ({ url, connected, node }) => {
  expectType<string>(url);
  expectType<boolean>(connected);
  expectType<string | undefined>(node);
});
sync.on('sync', (event) => expectType<number | undefined>(event.skipped));
sync.on('node', ({ action }) => expectType<'add' | 'remove' | 'enable' | 'disable'>(action));
sync.on('hello', ({ node, scopes }) => {
  expectType<string>(node);
  expectType<string[]>(scopes);
});
sync.on('error', (error) => expectType<string>(error.url));
expectError(sync.on('nope', () => {}));
expectType<boolean>(sync.started);
expectType<Promise<void>>(sync.enableNode('ws://a', false));
expectType<Promise<Array<{ url: string; pushed: number }>>>(sync.sync());
expectType<number>(sync.peers()[0].pending);
expectType<string | null>(sync.listNodes()[0].cursor);
expectType<syncom.SchemaInfo | null>(sync.listNodes()[0].remote!.schema);
sync.on('hello', ({ schema }) => expectType<syncom.SchemaInfo | null>(schema));
sync.on('peer', ({ schema }) => expectType<syncom.SchemaInfo | null | undefined>(schema));
expectType<syncom.SyncUnit>(sync.unit({ authorize: (_context, hello) => hello.schema?.version === 2 }));
expectType<syncom.SyncUnit>(sync.unit({ access: 'public', authorize: async () => true }));
expectType<string>(sync.unit().hello.access);
expectType<syncom.SyncUnit>(
  sync.unit({
    limits: { opsPerPush: 500, bytesPerPush: 1 << 20, opsPerSecond: 200 },
    meta: { rateLimit: { limit: 5 } },
  }),
);
expectType<Record<string, unknown> | undefined>(sync.unit().push.meta);
expectError(sync.unit({ meta: 'x' }));
expectError(sync.unit({ limits: { opsPerMinute: 1 } }));
expectError(syncom.open({ sync: { sharedLog: {} } }));
expectType<boolean>(syncom.isSharedLog({}));
expectAssignable<syncom.SharedLog>({
  append: async () => '1.1',
  read: () => ({ ready: Promise.resolve(), [Symbol.asyncIterator]: async function* () {} }),
  parseId: (text) => (typeof text === 'string' ? text : null),
});

// ids, skew, scopes and codes
expectAssignable<StorageOptions>({ sync: { maxSkew: 60_000 } });
expectAssignable<StorageOptions>({ sync: { maxSkew: Infinity } });
expectError(syncom.open({ sync: { maxSkew: '1h' } }));
expectAssignable<StorageOptions>({ sync: { pendingMax: 8192 } });
expectError(syncom.open({ sync: { pendingMax: 'many' } }));
storage.applyRemote([], { adoptFrom: 'host' }).then((result) => {
  expectType<number>(result.malformed);
  expectType<number>(result.gaps);
});
storage.applyRemote([], { bound: ['Doc'] }).then((result) => {
  expectType<number>(result.outOfScope);
});
expectError(storage.applyRemote([], { bound: 'Doc' }));
storage.sync.on('refused', (event) => {
  expectType<'scope' | 'forged' | 'unsigned'>(event.reason);
  expectType<number>(event.count);
  expectType<string>(event.node);
});
storage.sync.on('sync', (event) => {
  expectType<number | undefined>(event.malformed);
});
storage.on('error', (error) => {
  expectType<'OP_REFUSED' | 'OP_INVALID' | 'OP_UNREADABLE' | 'SKEW' | 'BAD_SIGNATURE' | 'UNSIGNED'>(error.code);
  expectAssignable<SyncomError>(error);
  expectType<string>(error.op.origin);
});
expectAssignable<Fsi>({
  read: async () => '',
  write: async (_dir: string, _file: string, _content: string, _options?: { mode?: number }) => {},
  exists: async () => true,
  remove: async () => {},
  list: async () => [],
});

// E2: the applied watermark, stuck peers, page failures
expectType<void>(log.applied(3));
expectType<void>(log.applied(2, 4));
expectType<Promise<syncom.OpLog>>(new syncom.OpLog('base', { sealApplied: true }));
expectType<boolean>(storage.sync.peers()[0].stuck);
storage.sync.on('error', (error) => {
  expectType<string | null | undefined>(error.cursor);
  expectType<number | undefined>(error.attempt);
});
expectError(storage.swap('id', 'text', { a: 1 }));

// E3: behind peers, the outbox bound
expectType<boolean>(storage.sync.peers()[0].behind);
expectAssignable<StorageOptions>({ sync: { maxOutbox: 500 } });
expectError(syncom.open({ sync: { maxOutbox: 'lots' } }));

// E4a: no chain, seqOf
expectAssignable<StorageOptions>({ chain: false });
expectError(syncom.open({ chain: 'no' }));
expectType<number>(log.seqOf('origin@scope'));

// E5b: introspection
expectType<syncom.StorageStats>(storage.stats());
expectType<Promise<{ ops: number; alive: boolean }>>(storage.repair('r1'));
expectAssignable<SyncomErrorCode>('UNRECOVERABLE');
expectType<{ entries: syncom.LogEntry[]; last: number | null } | null>(log.read('e.1', { scopes: ['a'], limit: 5 }));
expectType<syncom.LogEntry[] | null>(log.since('e.1'));
expectType<syncom.LogEntry[]>(log.entriesOf('r1'));
expectType<void>(log.retain((entry) => entry.op.type === 'write'));
expectType<void>(log.retain(null));
expectError(log.retain(true));
expectType<number>(storage.stats().cache.pinned);
expectType<{ tail: string } | null>(storage.stats().chain);
expectType<{ count: number; corrupt: boolean }>(storage.stats().tags);
expectType<number>(storage.stats().deferred);
expectAssignable<StorageOptions>({ defer: 50 });
expectError(syncom.open({ defer: '50ms' }));
expectType<Promise<number>>(storage.compact('id'));
expectType<Promise<syncom.HistoryResult>>(storage.history('id', { limit: 10, before: 'epoch:1' }));
expectType<syncom.HostedPeer[]>(storage.sync.hosted());
expectType<string | null>(storage.sync.hosted()[0].cursor);
expectType<number | null | string>(storage.sync.peers()[0].lastError!.code);
storage.on('log', (event) => {
  expectType<'roll'>(event.kind);
  expectType<number>(event.floor);
});
storage.on('change', (op, via) => {
  expectType<syncom.PeerRef | null>(via);
});
expectType<number>(log.segments);
expectType<number>(log.retainedOps);
expectType<Promise<syncom.OpLog>>(new syncom.OpLog('base', { onRoll: (roll) => void roll.floor }));

// E6: what existed at runtime but not in the types
expectType<syncom.Logger>(storage.logger);
expectType<number>(log.latestTs);
expectType<number>(log.droppedTs);
expectType<Promise<unknown>>(storage.get('id', { at: 'epoch.5' }));
expectType<Promise<unknown>>(storage.get('id', { at: Date.now() }));
expectType<Promise<unknown>>(storage.get('id', { at: new Date() }));
expectType<Promise<unknown>>(storage.get('id', { at: { vector: storage.vector } }));
expectType<Promise<unknown>>(storage.get('id', { at: { tag: 'v1' } }));
expectError(storage.get('id', { at: true }));
expectType<Promise<syncom.HistoryResult>>(storage.history('id', { limit: 10 }));
declare const posts: SyncomCollection;
expectType<Promise<unknown | null>>(posts.get('id', { at: 'epoch.5' }));
expectType<Promise<unknown | null>>(posts.get('id', { at: { tag: 'v1' } }));
expectAssignable<syncom.ReadContext>({ id: 'x', at: 'epoch.1' });
expectAssignable<syncom.ReadContext>({ id: 'x', history: true });
expectAssignable<syncom.SyncomErrorCode>('HISTORY_GONE');
expectAssignable<syncom.SyncomErrorCode>('INVALID_VERSION');
expectAssignable<syncom.SyncomErrorCode>('TAG_EXISTS');
expectAssignable<syncom.SyncomErrorCode>('TAG_NOT_FOUND');
declare const version: syncom.HistoryVersion;
expectType<string[]>(version.fields);
expectType<true | undefined>(version.scrubbed);
expectType<Promise<syncom.Tag>>(storage.tag('v1'));
expectType<Promise<void>>(storage.untag('v1'));
expectType<syncom.Tag[]>(storage.tags());
expectType<syncom.TagView>(storage.at('v1'));
expectType<Promise<unknown>>(storage.at('v1').get('id'));
expectType<boolean>(storage.at('v1').has('id'));
expectType<string>(storage.at('v1').eventId);
expectType<string[]>(storage.at('v1').list());
expectType<syncom.TagCollection>(storage.at('v1').collection('Post'));
expectType<syncom.Cursor>(
  storage
    .at('v1')
    .collection('Post')
    .select({ n: { $gte: 2 } }),
);
expectType<Promise<number>>(storage.at('v1').collection('Post').count());
expectType<Promise<unknown | null>>(storage.at('v1').collection('Post').get('id'));
expectType<Promise<syncom.SnapshotPage>>(storage.at('v1').snapshot({ limit: 100 }));
expectError(storage.tag(5));
expectType<Promise<syncom.Patch[]>>(storage.diff('id', { tag: 'v1' }));
expectType<Promise<syncom.Patch[]>>(storage.diff('id', 'epoch.1', { vector: storage.vector }));
expectType<Promise<number>>(storage.applyPatches('id', [{ action: 'put', field: 'n', value: 1 }], { source: 'undo' }));
expectType<Promise<number>>(storage.restore('id', { tag: 'v1' }, { actor: 'u2' }));
expectAssignable<syncom.Patch>({ action: 'remove', field: 'tags', removals: [['x', { a: 1 }]] });
expectAssignable<syncom.Patch>({ action: 'remove', field: 'tags', elements: ['x'], own: true });
expectAssignable<syncom.Patch>({ action: 'splice', field: 'body', index: 0, count: 2, content: 'hi' });
expectAssignable<syncom.Patch>({ action: 'treeMove', field: 'outline', node: 'n', parent: null, after: 'm' });
expectError(storage.applyPatches('id', [{ action: 'nope' }]));
storage.on('commit', (event) => {
  expectType<syncom.SyncOp>(event.op);
  expectType<number>(event.seq);
  expectType<Record<string, unknown> | null>(event.before);
  expectType<{ [field: string]: syncom.FieldKind }>(event.kinds);
});
expectType<() => void>(log.pin((entry) => entry.seq > 1));
expectError(log.pin(null));
expectType<number>(storage.stats().log.droppedTs);
expectType<typeof syncom.SyncomCollection>(syncom.Storage.Collection);
expectType<number>(storage.listenerCount('change'));
expectType<(keyof syncom.StorageEvents)[]>(storage.eventNames());
expectType<Promise<syncom.SyncOp>>(storage.toPromise('change'));
expectType<Promise<string>>(storage.sync.toPromise('error').then((error) => error.url));
storage.clear('change');
storage.sync.clear();

// E7a: lock knobs, the listener cap, exclusive create
expectAssignable<StorageOptions>({ lock: { mode: 'wait', timeout: 5000, poll: 50, staleAfter: 60_000 } });
expectError(syncom.open({ lock: { mode: 'maybe' } }));
expectAssignable<StorageOptions>({ maxListeners: 20 });
expectError(syncom.open({ maxListeners: 'many' }));
expectAssignable<Fsi>({
  read: async () => '',
  write: async () => {},
  exists: async () => true,
  remove: async () => {},
  list: async () => [],
  create: async (_dir: string, _file: string, _content: string) => {},
});
