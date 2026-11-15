<script setup lang="ts">
// Two runs typed at the same spot: the laptop and the phone hold "Hello", and apart each types a word after
// the "o". Each new run hangs off the letter on its left as a right child; when the runs cross, both are
// right children of "o", ordered by origin then stamp, and the text is the pre-order walk of the tree, so
// both nodes read one run after the other, never the letters mixed.
// Depicts: src/text/sequence.js (the Fugue rule: a run anchored at the element before it, siblings by origin
// then stamp, the reading a pre-order walk), src/text/splice.js (placeRun, rankAmong: where a run lands among
// its siblings), src/text/join.js (two nodes' blocks joined by the same rule).
import SyncFigure from './SyncFigure.vue';

const steps = [
  'The laptop and the phone hold the same text, “Hello”: one run, each letter the right child of the one before it in the Fugue tree.',
  'Apart, the laptop types “ world” and the phone types “ there” after the “o”. Each new run hangs off “o”, the letter on its left, as its right child.',
  'The runs cross as ops. Each names the letter it hangs off, not an index, so it lands at the same place on the other node.',
  'Now “o” has two right children. Siblings are ordered by origin, then stamp: the laptop’s node id sorts first, so on the phone its own run moves second.',
  'The text is a pre-order walk of the tree: “o”, then the whole first run, then the whole second. Both nodes read “Hello world there”, never the letters mixed.',
];

const NODE = { laptop: 60, phone: 660 };
const Y = 44;
const HELLO = ['H', 'e', 'l', 'l', 'o'];
const WORLD = ['', 'w', 'o', 'r', 'l', 'd'];
const THERE = ['', 't', 'h', 'e', 'r', 'e'];
// Each node's tree: where its "Hello" starts; runs hang 136 to the right of it, row A or row B.
const TREE = { laptop: 40, phone: 400 };
const ROW_A = 212;
const ROW_B = 262;
const CELL = 25;
const oCenter = (node: 'laptop' | 'phone') => TREE[node] + 4 * CELL + 11;

const reads = (node: 'laptop' | 'phone', step: number) => {
  if (step === 0) return 'Hello';
  if (step <= 2) return node === 'laptop' ? 'Hello world' : 'Hello there';
  return 'Hello world there';
};
// The runs each tree holds at a step, and the row each sits in.
const runs = (node: 'laptop' | 'phone', step: number) => {
  const out: { who: 'laptop' | 'phone'; row: number; shown: boolean }[] = [];
  if (node === 'laptop') {
    out.push({ who: 'laptop', row: ROW_A, shown: step >= 1 });
    out.push({ who: 'phone', row: ROW_B, shown: step >= 3 });
  } else {
    out.push({ who: 'laptop', row: ROW_A, shown: step >= 3 });
    out.push({ who: 'phone', row: step >= 3 ? ROW_B : ROW_A, shown: step >= 1 });
  }
  return out;
};
const children = (node: 'laptop' | 'phone', step: number) => (step >= 3 ? 2 : step >= 1 ? 1 : 0);
// Where each run's op is on its way.
const packetAt = (who: 'laptop' | 'phone', step: number) => {
  const from = who === 'laptop' ? 170 : 550;
  const to = who === 'laptop' ? 550 : 170;
  return step >= 2 ? to : from;
};
</script>

<template>
  <SyncFigure
    caption="Two runs typed at the same spot stay whole, in the same order on every node"
    :steps="steps"
    :key-step="4"
    view-box="0 0 720 330"
  >
    <template #default="{ step, grad }">
      <line class="f-link" :x1="NODE.laptop + 28" :y1="Y" :x2="NODE.phone - 28" :y2="Y" />
      <g v-for="(x, node) in NODE" :key="node">
        <circle class="f-node" :cx="x" :cy="Y" r="28" :fill="grad" />
        <text class="f-node-text" :x="x" :y="Y">{{ node }}</text>
      </g>

      <!-- what each node reads -->
      <g v-for="(x, node) in TREE" :key="`reads-${node}`">
        <rect class="f-card" :x="x - 24" y="92" width="288" height="34" rx="9" />
        <text class="f-muted" :x="x - 12" y="113">reads</text>
        <text
          :class="['f-text', 'f-mono', { 'f-changed': step > 0 && reads(node, step) !== reads(node, step - 1) }]"
          :x="x + 30"
          y="113"
        >
          {{ reads(node, step) }}
        </text>
      </g>

      <!-- each node's tree -->
      <g v-for="(x, node) in TREE" :key="`tree-${node}`">
        <text class="f-muted" :x="x - 24" y="152">the tree on the {{ node }}</text>
        <g v-for="(letter, i) in HELLO" :key="i">
          <rect class="f-cell" :x="x + i * CELL" y="162" width="22" height="22" rx="4" />
          <text class="f-text f-mono" :x="x + i * CELL + 11" y="177.5" text-anchor="middle">{{ letter }}</text>
        </g>
        <!-- right children of "o" -->
        <path
          :class="['f-link', { 'f-hidden': children(node, step) < 1 }]"
          :d="`M ${oCenter(node)} 186 V ${ROW_A + 11} H ${x + 134}`"
        />
        <path
          :class="['f-link', { 'f-hidden': children(node, step) < 2 }]"
          :d="`M ${oCenter(node)} ${ROW_A + 11} V ${ROW_B + 11} H ${x + 134}`"
        />
        <g
          v-for="run in runs(node, step)"
          :key="run.who"
          :class="{ 'f-hidden': !run.shown }"
          :style="{ transform: `translate(${x + 136}px, ${run.row}px)` }"
        >
          <text class="f-muted" x="-38" y="15" text-anchor="end">{{ run.who }}</text>
          <g v-for="(letter, i) in run.who === 'laptop' ? WORLD : THERE" :key="i">
            <rect :class="run.who === 'laptop' ? 'f-peer-a' : 'f-peer-c'" :x="i * CELL" y="0" width="22" height="22" rx="4" />
            <text class="f-packet-text" :x="i * CELL + 11" y="11">{{ letter }}</text>
          </g>
        </g>
      </g>

      <!-- the two runs on their way -->
      <g
        :style="{ transform: `translate(${packetAt('laptop', step)}px, ${Y - 22}px)` }"
        :class="{ 'f-hidden': step < 1 || step > 2 }"
      >
        <rect class="f-peer-a" x="-56" y="-10" width="112" height="20" rx="10" />
        <text class="f-packet-text" x="0" y="0">run “ world”</text>
      </g>
      <g
        :style="{ transform: `translate(${packetAt('phone', step)}px, ${Y + 22}px)` }"
        :class="{ 'f-hidden': step < 1 || step > 2 }"
      >
        <rect class="f-peer-c" x="-56" y="-10" width="112" height="20" rx="10" />
        <text class="f-packet-text" x="0" y="0">run “ there”</text>
      </g>

      <!-- converged -->
      <g :class="{ 'f-hidden': step !== 4 }">
        <rect class="f-ok" x="230" y="298" width="260" height="26" rx="13" />
        <text class="f-packet-text" x="360" y="311">one run after the other, everywhere</text>
      </g>
    </template>
  </SyncFigure>
</template>
