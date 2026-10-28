// The hash-linked chain as a plugin (@alexify/syncom/chain): with
// `open({ plugins: [chain] })` every applied batch — a local write, a peer's
// page, a replay — appends a block naming the hash of each record's data
// after it, a record file is checked against its block on a cold read
// (`integrity: 'verify'`), and `validate()` walks the chain. Without the
// plugin no block is written and `validate()` rejects with `NO_CHAIN`;
// `open({ chain: false })` keeps the plugin registered and the chain off.
// `Blockchain` is the chain on its own, for an audit tool or the contracts
// subpath.

import type { Plugin, Fsi } from '../../index.js';

export type { Plugin, Fsi };

export interface Block<T = unknown> {
  prev: string;
  timestamp: number;
  data: T;
}

export interface ChainDataEntry {
  id: string;
  hash: string;
}

export interface Blockchain {
  readonly path: string;
  tailHash: string;

  writeChain(): Promise<void>;
  addBlock(data: unknown): Promise<string>;
  writeBlock(block: Block): Promise<string>;
  readBlock(hash: string): Promise<Block>;
  validate(options?: { last?: number; from?: string }): Promise<boolean>;
}

export interface BlockchainConstructor {
  readonly prototype: Blockchain;
  new (basePath: string, options?: { fsi?: Fsi }): Promise<Blockchain>;
}

export declare const Blockchain: BlockchainConstructor;

/** The plugin: a block per applied batch, a check on a cold read, `validate()`. */
export declare const chain: Plugin;
