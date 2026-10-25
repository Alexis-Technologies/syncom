import { expectError, expectType } from 'tsd';
import type { Storage } from '../index.js';
import { branch, merge, branchInfo, drop, type BranchInfo, type MergeResult } from '../src/branch/branch.js';

declare const parent: Storage;
expectType<Promise<Storage>>(branch(parent, { path: '/tmp/b', from: { tag: 'v1' }, schema: { entities: {} } }));
expectType<Promise<MergeResult>>(merge(parent, { into: parent }));
expectType<Promise<BranchInfo | null>>(branchInfo(parent));
expectType<Promise<void>>(drop(parent));
expectError(branch(parent, {}));
expectError(merge(parent));
