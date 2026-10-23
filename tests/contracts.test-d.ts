import { expectError, expectType } from 'tsd';
import { DataReader, SmartContract } from '../contracts.js';
import type { Blockchain, Storage } from '../index.js';

declare const storage: Storage;
declare const chain: Blockchain;

const reader = new DataReader(storage);
expectType<Promise<unknown>>(reader.get('id'));
expectType<Promise<string>>(SmartContract.save('name', chain, async () => 1));
expectType<Promise<SmartContract>>(SmartContract.load('hash', { storage, chain }));
const contract = new SmartContract('publish', async (r, args) => ({ id: args.id, seen: await r.get(args.id) }), {
  storage,
  chain,
});
expectType<string>(contract.name);
expectType<Promise<unknown>>(contract.execute({ id: 'r1', extra: true }));
expectError(contract.execute({ extra: true }));
