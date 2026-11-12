// The `@alexify/syncom/wrpc` subpath: a WrpcClient adapted to the SyncLink
// contract. wrpc itself is injected by the caller and never imported here.

import type { SyncLink } from '../../index.js';
import type { SharedCall } from '../shared/shared.js';

export type { SyncLink } from '../../index.js';
export { isSyncLink } from '../../index.js';

/** The part of a WrpcClient the adapter relies on — checked structurally. */
export interface WrpcClientLike {
  call(method: string, args?: unknown, options?: unknown): Promise<unknown>;
  use(introspection: Record<string, Record<string, unknown>>): unknown;
  on(event: string, listener: (...args: unknown[]) => void): void;
  off(event: string, listener: (...args: unknown[]) => void): void;
  close(): void;
  getStream?(id: string): AsyncIterable<Uint8Array>;
  readonly api?: Record<string, unknown>;
}

export interface WrpcLinkOptions {
  /** The router unit the host mounted `storage.sync.unit()` under. Default `'syncom'`. */
  unit?: string;
}

export interface WrpcLink extends SyncLink {
  stream(id: string): AsyncIterable<Uint8Array>;
  readonly client: WrpcClientLike;
}

export function createWrpcLink(client: WrpcClientLike, options?: WrpcLinkOptions): WrpcLink;

/** The channel a follower of `@alexify/syncom/shared` carries its writes over: a wrpc client to the leader's router unit (`syncom-db`). */
export interface SharedChannel {
  /** A forwarded call as the wire carries it (`{ id, args, retry }`): the leader answers a retry from what it kept. */
  call(method: string, call: SharedCall): Promise<unknown>;
  close(): unknown;
  readonly client: { call(method: string, args: unknown): Promise<unknown>; close(): unknown };
}
export function createSharedChannel(
  client: { call(method: string, args: unknown): Promise<unknown>; close(): unknown },
  options?: { unit?: string },
): SharedChannel;

/** What `client.use()` is fed so `client.api.syncom.changes` exists without a `load()`. */
export const SYNC_INTROSPECTION: {
  readonly syncom: {
    readonly hello: {};
    readonly push: {};
    readonly snapshot: {};
    readonly changes: { readonly kind: 'subscription' };
    readonly prove: {};
    readonly query: {};
    readonly count: {};
  };
};
