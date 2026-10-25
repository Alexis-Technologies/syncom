// The `@alexify/syncom/contracts` subpath: a procedure stored in the chain by
// hash and run against a read-only view of storage. Kept off the package root
// on purpose — `SmartContract.load` reconstructs code with `new Function`, so
// a process that never imports this subpath never executes a block's code
// (see SECURITY.md).

import type { Blockchain, Storage } from '../../index.js';

export interface ContractContext {
  storage: Storage;
  chain: Blockchain;
}

export interface ContractBlock {
  type: 'smart contract';
  name: string;
  source: string;
}

export interface ErrorBlock {
  contract: string;
  args: unknown;
  error: string;
  timestamp: number;
}

export type ContractExecuteArgs = { id: string } & Record<string, unknown>;

export type ContractProcedure = (reader: DataReader, args: ContractExecuteArgs) => unknown | Promise<unknown>;

/** The only storage access a contract has. */
export class DataReader {
  constructor(storage: Storage);
  get(id: string): Promise<unknown>;
}

export class SmartContract {
  constructor(name: string, proc: ContractProcedure, context: ContractContext);
  readonly name: string;

  /** Runs the procedure, saves its result under `args.id`; a failure is recorded as a block and re-thrown. */
  execute(args: ContractExecuteArgs): Promise<unknown>;

  /** Serialises the procedure's source into a block; resolves to its hash. */
  static save(name: string, chain: Blockchain, proc: ContractProcedure): Promise<string>;
  /** Reconstructs a stored procedure — code from the chain runs in this process. */
  static load(hash: string, context: ContractContext): Promise<SmartContract>;
}
