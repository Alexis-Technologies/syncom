// The browser half of the package, reached through the `browser` export
// condition (see package.json#exports and #browser).
//
// Everything that is platform-agnostic — CRDT, contracts, chain, storage and
// their types — is re-exported from ./index.js unchanged. What differs is the
// crypto and OPFS layer: node:crypto is synchronous, the Web Crypto API is
// not, so `calculateHash`, `encrypt` and `decrypt` return promises here and
// are declared below rather than re-exported.

import type { JSONSafe as JSONSafeValue } from './index.js';

export type {
  JSONSafe,
  KeyPair,
  CrdtDelta,
  CrdtHistoryRecord,
  Block,
  ChainDataEntry,
  BlockchainConstructor,
  ContractContext,
  ContractBlock,
  ErrorBlock,
  ContractExecuteArgs,
  ContractProcedure,
  SchemaEntity,
  SchemaEntities,
  Schema,
  StorageOptions,
  Collections,
  Reference,
  SyncomRecord,
  SyncomCollection,
  StorageDataOptions,
  StorageEntry,
  Node,
  NodeData,
  SyncManagerConstructor,
  SyncOptions,
  SyncomTelemetryOptions,
  SyncomTelemetryApi,
  SyncomTracer,
  SyncomSpan,
  SyncomMeter,
  SyncomCounter,
  SyncomHistogram,
  SyncLink,
  StorageConstructor,
  ClockStamp,
  VersionVector,
  SyncOpType,
  SyncOp,
  EntryMeta,
  Entry,
  ApplyResult,
  LogEntry,
  OpLogOptions,
  OpLogConstructor,
  Logger,
  SnapshotPage,
  ApplyRemoteResult,
} from './index.js';

export {
  generateKeys,
  loadKeys,
  read,
  write,
  exists,
  remove,
  list,
  applyOp,
  mergeEntry,
  isAlive,
  OpLog,
  diff,
  merge,
  apply,
  Blockchain,
  DataReader,
  SmartContract,
  SyncManager,
  isSyncLink,
  Storage,
  open,
} from './index.js';

// Web Crypto: async where node:crypto is sync.
export function calculateHash(data: JSONSafeValue): Promise<string>;
export function encrypt(data: unknown, publicKey: string): Promise<string>;
export function decrypt(data: string, privateKey: string): Promise<unknown>;
