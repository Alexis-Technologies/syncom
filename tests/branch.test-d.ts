import { expectError, expectType } from 'tsd';
import type { Database } from '../index.js';
import { branch, merge, branchInfo, drop, type BranchInfo, type MergeResult } from '../src/branch/branch.js';

declare const parent: Database;
expectType<Promise<Database>>(branch(parent, { path: '/tmp/b', from: { tag: 'v1' }, schema: { entities: {} } }));
expectType<Promise<Database>>(branch(parent, { path: '/tmp/c', from: { at: 'epoch.12' } }));
expectType<Promise<Database>>(branch(parent, { path: '/tmp/d', from: { at: { vector: { A: 3 } } } }));
expectType<Promise<MergeResult>>(merge(parent, { into: parent }));
expectType<Promise<BranchInfo | null>>(branchInfo(parent));
expectType<Promise<void>>(drop(parent));
expectError(branch(parent, {}));
expectError(merge(parent));
