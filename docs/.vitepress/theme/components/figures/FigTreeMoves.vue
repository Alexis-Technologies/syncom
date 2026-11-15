<script setup lang="ts">
// Two crossing moves in a tree field: the laptop puts guide under reference while the phone, a moment later,
// puts reference under guide. Every node folds all the moves in stamp order; the newer one would hang
// reference under its own child, so the fold skips it, and both nodes read the same tree. The skipped move is
// kept in the field.
// Depicts: src/tree/moves.js (the moves kept per node, the fold in stamp order, the cycle check that makes a
// move moot), src/tree/tree.js (treeMove as an op of the tree kind).
import SyncFigure from './SyncFigure.vue';

const steps = [
  'The laptop and the phone hold an outline with two roots, guide and reference. The tree field keeps every move ever made of its nodes, each stamped.',
  'Apart, the laptop puts guide under reference at stamp 5. A moment later the phone puts reference under guide at stamp 6. Each tree shows its own move.',
  'The moves cross, and both nodes now hold all four. Applied together, the last two would make guide and reference each the other’s parent.',
  'Every node folds the moves in stamp order. At 5 guide goes under reference; at 6 reference would go under its own child, so the fold skips that move.',
  'Both nodes read the same tree: guide under reference. The skipped move is kept, not deleted, and a later move of either node can make it count again.',
];

const NODE = { laptop: 60, phone: 660 };
const Y = 48;
const TREE = { laptop: 30, phone: 490 };
const ITEMS = ['guide', 'reference'] as const;
type Shape = 'roots' | 'guide-under-reference' | 'reference-under-guide';
// The tree each node reads at a step.
const shape = (node: 'laptop' | 'phone', step: number): Shape => {
  if (step === 0) return 'roots';
  if (node === 'laptop' || step >= 3) return 'guide-under-reference';
  return 'reference-under-guide';
};
// Where a tree node's card sits: the first root, the second root, or the child of the first root.
const place = (x: number, item: 'guide' | 'reference', now: Shape) => {
  const first = { x, y: 118 };
  const second = { x: x + 104, y: 118 };
  const child = { x: x + 30, y: 178 };
  if (now === 'roots') return item === 'guide' ? first : second;
  if (now === 'guide-under-reference') return item === 'reference' ? first : child;
  return item === 'guide' ? first : child;
};
const MOVES = [
  { ts: 1, move: 'guide → root', who: 'f-peer-b' },
  { ts: 2, move: 'reference → root', who: 'f-peer-b' },
  { ts: 5, move: 'guide → reference', who: 'f-peer-a' },
  { ts: 6, move: 'reference → guide', who: 'f-peer-c' },
];
const held = (i: number, step: number) => i < 2 || step >= 2;
const packetAt = (who: 'laptop' | 'phone', step: number) => {
  const from = who === 'laptop' ? 170 : 550;
  const to = who === 'laptop' ? 550 : 170;
  return step >= 2 ? to : from;
};
</script>

<template>
  <SyncFigure
    caption="Two crossing moves of a tree, folded in stamp order: the newer one would make a cycle and is skipped"
    :steps="steps"
    :key-step="3"
  >
    <template #default="{ step, grad }">
      <line class="f-link" :x1="NODE.laptop + 28" :y1="Y" :x2="NODE.phone - 28" :y2="Y" />
      <g v-for="(x, node) in NODE" :key="node">
        <circle class="f-node" :cx="x" :cy="Y" r="28" :fill="grad" />
        <text class="f-node-text" :x="x" :y="Y">{{ node }}</text>
      </g>

      <!-- each node's tree -->
      <g v-for="(x, node) in TREE" :key="`tree-${node}`">
        <text class="f-muted" :x="x" y="104">the tree on the {{ node }}</text>
        <path
          :class="['f-link', { 'f-hidden': shape(node, step) === 'roots' }]"
          :d="`M ${x + 16} 144 V 191 H ${x + 30}`"
        />
        <g
          v-for="item in ITEMS"
          :key="item"
          :style="{ transform: `translate(${place(x, item, shape(node, step)).x}px, ${place(x, item, shape(node, step)).y}px)` }"
        >
          <rect class="f-card" x="0" y="0" width="92" height="26" rx="6" />
          <text class="f-text" x="46" y="17" text-anchor="middle">{{ item }}</text>
        </g>
      </g>

      <!-- the moves every node holds -->
      <text class="f-muted" x="250" y="104">the moves, in stamp order</text>
      <g v-for="(m, i) in MOVES" :key="m.ts" :class="{ 'f-hidden': !held(i, step) }">
        <rect class="f-card" x="250" :y="112 + i * 32" width="220" height="24" rx="6" />
        <rect :class="m.who" x="258" :y="120 + i * 32" width="8" height="8" rx="2" />
        <text class="f-text f-mono" x="274" :y="128 + i * 32">{{ m.ts }}</text>
        <text class="f-text" x="292" :y="128 + i * 32">{{ m.move }}</text>
      </g>
      <text :class="['f-changed', 'f-text', { 'f-hidden': step < 3 }]" x="462" :y="128 + 3 * 32" text-anchor="end">
        skipped
      </text>

      <!-- the two moves on their way -->
      <g
        :style="{ transform: `translate(${packetAt('laptop', step)}px, ${Y - 22}px)` }"
        :class="{ 'f-hidden': step < 1 || step > 2 }"
      >
        <rect class="f-peer-a" x="-64" y="-10" width="128" height="20" rx="10" />
        <text class="f-packet-text" x="0" y="0">guide → reference</text>
      </g>
      <g
        :style="{ transform: `translate(${packetAt('phone', step)}px, ${Y + 22}px)` }"
        :class="{ 'f-hidden': step < 1 || step > 2 }"
      >
        <rect class="f-peer-c" x="-64" y="-10" width="128" height="20" rx="10" />
        <text class="f-packet-text" x="0" y="0">reference → guide</text>
      </g>

      <!-- converged -->
      <g :class="{ 'f-hidden': step !== 4 }">
        <rect class="f-ok" x="250" y="258" width="220" height="26" rx="13" />
        <text class="f-packet-text" x="360" y="271">same tree on every node</text>
      </g>
    </template>
  </SyncFigure>
</template>
