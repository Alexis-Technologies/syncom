import { expectError, expectType } from 'tsd';
import { sync as syncPlugin, SyncManager, isSyncLink } from '../src/sync/sync.js';
import type { SyncUnitOptions } from '../src/sync/sync.js';
import type { Plugin, SyncApi, SyncUnit, HostedPeer, Node, SchemaInfo, SharedStats } from '../src/sync/sync.js';
import { createDatabase } from '../index.js';

expectType<Plugin<SyncApi>>(syncPlugin);
expectType<boolean>(isSyncLink({}));
const storage = await createDatabase({ plugins: [syncPlugin] });
expectType<SyncManager>(storage.sync);
expectType<SyncUnitOptions['authorizeWrite'] | null>(storage.sync.authorizeWrite);
// What a REWOUND host may move of this node's own streams: on proof, or on its word.
expectType<SyncManager>((await createDatabase({ plugins: [syncPlugin], sync: { rewind: 'adopt' } })).sync);
expectError(createDatabase({ plugins: [syncPlugin], sync: { rewind: 'trust' } }));
// The core alone has no sync property in its type.
expectError((await createDatabase()).sync);

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
expectType<boolean>(sync.peers()[0].caughtUp);
expectType<'both' | 'pull' | 'push'>(sync.peers()[0].direction);
expectType<Promise<void>>(sync.addNode({ url: 'ws://a', direction: 'pull' }));
expectError(sync.addNode({ url: 'ws://a', direction: 'sideways' }));
expectType<Promise<void>>(sync.awaitInSync());
expectType<Promise<void>>(sync.awaitInitialReplication({ signal: new AbortController().signal }));
expectType<Promise<void>>(sync.awaitDocumentPushed('id'));
expectType<SyncUnit>(sync.unit({ allow: { push: false } }));
expectType<SyncUnit>(sync.unit({ query: { regex: 'safe' }, limits: { rowsPerQuery: Infinity } }));
expectType<SyncUnit>(sync.unit({ query: true }));
expectType<SyncUnit>(sync.unit({ allow: { blob: 'any' } }));
expectError(sync.unit({ allow: { blob: 'maybe' } }));
expectType<Promise<Uint8Array>>(sync.fetchBlob('a'.repeat(64), { id: 'r1', name: 'photo.bin' }));
expectError(sync.unit({ query: { regex: 'maybe' } }));
expectError(sync.unit({ allow: { hello: false } }));
// The shared log as this hub stands to it, or null without one.
expectType<SharedStats | null>(sync.shared());
const shared = sync.shared()!;
expectType<string>(shared.topic);
expectType<string | false>(shared.inbox);
expectType<string | null>(shared.appended);
expectType<number>(shared.covered);
expectType<number>(shared.holes);
expectType<{ topic: boolean; inbox: boolean }>(shared.retrying);
expectType<string | null>(shared.cursor.topic);
expectType<string | null>(shared.appended);
expectType<boolean>(shared.behind);
expectType<boolean>(shared.stuck.inbox);
expectType<number>(shared.relayed);
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
  expectType<
    | 'scope'
    | 'rule'
    | 'forged'
    | 'unsigned'
    | 'equivocation'
    | 'HELLO'
    | 'PRESENCE_RATE'
    | 'PRESENCE_MALFORMED'
    | 'PRESENCE_SCOPE'
    | 'PRESENCE_FORGED'
    | 'PRESENCE_UNSIGNED'
    | 'PRESENCE_UNPROVEN'
  >(event.reason);
  expectType<number>(event.count);
  expectType<string | null>(event.node);
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
typedSync.on('sync', (event) => expectType<number | undefined>(event.equivocations));
