// The tree kind as a plugin: `open({ plugins: [tree] })` adds treeMove()
// and treeRemove() to the storage (TreeMethods). The op, block and node
// types live in the root's index.d.ts and are re-exported here.

import type { Plugin, TreeMethods, TreeBlock, TreePayload, TreeNode } from '../../index.js';

export type { Plugin, TreeMethods, TreeBlock, TreePayload, TreeNode };

/** The movable tree kind — per node its stamped moves, folded in stamp order — registered per storage. */
export declare const tree: Plugin<TreeMethods>;
