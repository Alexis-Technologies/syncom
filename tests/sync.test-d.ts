import { expectError, expectType } from 'tsd';
import { sync as syncPlugin, SyncManager, isSyncLink } from '../src/sync/sync.js';
import type { Plugin, SyncApi, SyncUnit, HostedPeer, Node, SchemaInfo } from '../src/sync/sync.js';
import { open } from '../index.js';

expectType<Plugin<SyncApi>>(syncPlugin);
expectType<boolean>(isSyncLink({}));
const storage = await open({ plugins: [syncPlugin] });
expectType<SyncManager>(storage.sync);
// The core alone has no sync property in its type.
expectError((await open()).sync);

// sync
const sync = storage.sync;
expectType<Node[]>(sync.listNodes());
expectType<Promise<void>>(sync.addNode({ url: 'ws://a', token: 't', scopes: ['*'] }));
expectType<Promise<void>>(sync.addNode({ url: 'ws://a' }));
expectError(sync.addNode({ url: 'ws://a', type: 'uplink' }));
expectError(sync.addNode({ token: 't' }));
expectType<Promise<void>>(sync.start());
expectType<Promise<void>>(sync.stop());
expectType<Promise<SyncManager>>(new SyncManager(storage));

expectType<boolean>(sync.started);
expectType<Promise<void>>(sync.enableNode('ws://a', false));
expectType<Promise<Array<{ url: string; pushed: number }>>>(sync.sync());
expectType<number>(sync.peers()[0].pending);
expectType<string | null>(sync.listNodes()[0].cursor);
expectType<SchemaInfo | null>(sync.listNodes()[0].remote!.schema);
sync.on('hello', ({ schema }) => expectType<SchemaInfo | null>(schema));
sync.on('peer', ({ schema }) => expectType<SchemaInfo | null | undefined>(schema));
expectType<SyncUnit>(sync.unit({ authorize: (_context, hello) => hello.schema?.version === 2 }));
expectType<SyncUnit>(sync.unit({ access: 'public', authorize: async () => true }));
expectType<string>(sync.unit().hello.access);
expectType<SyncUnit>(
  sync.unit({
    limits: { opsPerPush: 500, bytesPerPush: 1 << 20, opsPerSecond: 200 },
    meta: { rateLimit: { limit: 5 } },
  }),
);

storage.sync.on('refused', (event) => {
  expectType<'scope' | 'forged' | 'unsigned'>(event.reason);
  expectType<number>(event.count);
  expectType<string>(event.node);
});
storage.sync.on('sync', (event) => {
  expectType<number | undefined>(event.malformed);
});

expectType<boolean>(storage.sync.peers()[0].stuck);
storage.sync.on('error', (error) => {
  expectType<string | null | undefined>(error.cursor);
  expectType<number | undefined>(error.attempt);
});

expectType<boolean>(storage.sync.peers()[0].behind);

expectType<HostedPeer[]>(storage.sync.hosted());
expectType<string | null>(storage.sync.hosted()[0].cursor);
expectType<number | null | string>(storage.sync.peers()[0].lastError!.code);

expectType<Promise<string>>(storage.sync.toPromise('error').then((error) => error.url));

storage.sync.clear();

declare const typedSync: SyncManager;
expectType<number>(typedSync.pendingOps());

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
expectType<Record<string, unknown> | undefined>(sync.unit().push.meta);
expectError(sync.unit({ meta: 'x' }));
expectError(sync.unit({ limits: { opsPerMinute: 1 } }));
typedSync.on('sync', (event) => expectType<number | undefined>(event.outOfScope));
