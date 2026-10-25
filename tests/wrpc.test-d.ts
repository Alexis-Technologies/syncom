import { expectAssignable, expectError, expectType } from 'tsd';
import { createWrpcLink, isSyncLink, SYNC_INTROSPECTION } from '../src/wrpc/wrpc.js';
import type { SyncLink, WrpcClientLike, WrpcLink } from '../src/wrpc/wrpc.js';

declare const client: WrpcClientLike;
const link = createWrpcLink(client);
expectType<WrpcLink>(link);
expectAssignable<SyncLink>(link);
expectType<Promise<unknown>>(link.call('syncom/hello', { node: 'a' }));
expectType<AsyncIterable<Uint8Array>>(link.stream('id'));
expectType<WrpcClientLike>(link.client);
expectType<'subscription'>(SYNC_INTROSPECTION.syncom.changes.kind);
createWrpcLink(client, { unit: 'replication' });
expectError(createWrpcLink(client, { unit: 1 }));
expectError(createWrpcLink({}));

declare const value: unknown;
if (isSyncLink(value)) expectType<SyncLink>(value);
