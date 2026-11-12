import { expectAssignable, expectError, expectType } from 'tsd';
import { tree } from '../src/tree/tree.js';
import type { Plugin, TreeMethods, TreeBlock } from '../src/tree/tree.js';
import { createDatabase } from '../index.js';

expectType<Plugin<TreeMethods>>(tree);
const storage = await createDatabase({ plugins: [tree] });
expectType<Promise<void>>(storage.treeMove('id', 'outline', 'n1'));
expectError(storage.splice('id', 'body', 0, 0, 'hi'));
expectAssignable<TreeBlock>({ k: 'tree', ts: 0, moves: {} });
