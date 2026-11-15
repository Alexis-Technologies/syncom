<script setup lang="ts">
// Offline, then converged: the laptop votes while offline, the phone renames the task meanwhile, the
// laptop reconnects, pushes what the server lacks and follows its feed, and every node ends with both
// writes merged — a counter that added the vote, a register that took the rename.
// Depicts: src/commit.js (a local write is an op in the log at once), src/sync/manager.js (the dial,
// the push of what the host lacks, the feed), src/sync/hosting.js (hello, push, changes),
// src/ops.js (a register keeps the newer stamp, a counter sums per origin).
import SyncFigure from './SyncFigure.vue';

const steps = [
  'Three nodes hold the same task. The laptop and the phone both dial the server.',
  'The laptop goes offline. You add a vote anyway: it lands on the laptop at once and waits in its log as an op.',
  'Meanwhile the phone renames the task. Its op reaches the server, which cannot pass it to the laptop yet.',
  'The laptop reconnects. It greets the server and pushes the op the server is missing.',
  'Each side gets what it lacks: the server relays the vote to the phone, and its feed brings the rename to the laptop.',
  'Every node applied both ops. The title took the rename, the counter added the vote. Same task everywhere, no conflict to resolve.',
];

const X = { laptop: 110, server: 360, phone: 610 };
const Y = 78;

// What each node's card reads at a step.
const title = (node: 'laptop' | 'server' | 'phone', step: number) => {
  if (node === 'phone') return step >= 2 ? 'Write the guide' : 'Write the docs';
  if (node === 'server') return step >= 2 ? 'Write the guide' : 'Write the docs';
  return step >= 4 ? 'Write the guide' : 'Write the docs';
};
const votes = (node: 'laptop' | 'server' | 'phone', step: number) => {
  if (node === 'laptop') return step >= 1 ? 3 : 2;
  if (node === 'server') return step >= 3 ? 3 : 2;
  return step >= 4 ? 3 : 2;
};
// The ops each node's log holds beyond the two it started with: 'a' the laptop's vote, 'c' the phone's rename.
const log = (node: 'laptop' | 'server' | 'phone', step: number) => {
  const ops: string[] = [];
  if (node === 'laptop') {
    if (step >= 1) ops.push('a');
    if (step >= 4) ops.push('c');
  } else if (node === 'server') {
    if (step >= 2) ops.push('c');
    if (step >= 3) ops.push('a');
  } else {
    if (step >= 2) ops.push('c');
    if (step >= 4) ops.push('a');
  }
  return ops;
};
// Where each op is on its way, and whether it shows.
const voteAt = (step: number) => (step <= 2 ? X.laptop : step === 3 ? X.server : X.phone);
const renameAt = (step: number) => (step <= 1 ? X.phone : step <= 3 ? X.server : X.laptop);
const laptopOnline = (step: number) => step === 0 || step >= 3;
const changed = (now: string | number, before: string | number) => now !== before;
</script>

<template>
  <SyncFigure
    caption="Two writes made apart, one of them offline, converge on every node"
    :steps="steps"
    :key-step="5"
    view-box="0 -10 720 300"
  >
    <template #default="{ step, grad }">
      <!-- links -->
      <line :class="['f-link', { 'f-link-off': !laptopOnline(step) }]" :x1="X.laptop + 30" :y1="Y" :x2="X.server - 30" :y2="Y" />
      <line class="f-link" :x1="X.server + 30" :y1="Y" :x2="X.phone - 30" :y2="Y" />
      <text :class="['f-muted', { 'f-hidden': laptopOnline(step) }]" :x="(X.laptop + X.server) / 2" :y="Y - 14" text-anchor="middle">
        offline
      </text>

      <!-- nodes, cards and logs -->
      <g v-for="(x, node) in X" :key="node">
        <circle class="f-node" :cx="x" :cy="Y" r="30" :fill="grad" />
        <text class="f-node-text" :x="x" :y="Y">{{ node }}</text>

        <rect class="f-card" :x="x - 92" :y="124" width="184" height="78" rx="10" />
        <text class="f-muted" :x="x - 78" y="146">title</text>
        <text
          :class="['f-text', { 'f-changed': step > 0 && changed(title(node, step), title(node, step - 1)) }]"
          :x="x - 40"
          y="146"
        >
          {{ title(node, step) }}
        </text>
        <text class="f-muted" :x="x - 78" y="168">votes</text>
        <text
          :class="['f-text', 'f-mono', { 'f-changed': step > 0 && changed(votes(node, step), votes(node, step - 1)) }]"
          :x="x - 40"
          y="168"
        >
          {{ votes(node, step) }}
        </text>
        <text class="f-muted" :x="x - 78" y="190">tags</text>
        <text class="f-text f-mono" :x="x - 40" y="190">docs</text>

        <text class="f-muted" :x="x - 92" y="228">log</text>
        <rect class="f-cell" :x="x - 64" y="217" width="18" height="16" rx="3" />
        <rect class="f-cell" :x="x - 42" y="217" width="18" height="16" rx="3" />
        <rect
          v-for="(op, i) in log(node, step)"
          :key="op"
          :class="op === 'a' ? 'f-peer-a' : 'f-peer-c'"
          :x="x - 20 + i * 22"
          y="217"
          width="18"
          height="16"
          rx="3"
        />
      </g>

      <!-- the two ops on their way -->
      <g :style="{ transform: `translate(${voteAt(step)}px, ${Y - 2}px)` }" :class="{ 'f-hidden': step === 0 || step === 5 }">
        <rect class="f-peer-a" x="-30" y="-46" width="60" height="20" rx="10" />
        <text class="f-packet-text" x="0" y="-36">votes +1</text>
      </g>
      <g :style="{ transform: `translate(${renameAt(step)}px, ${Y - 2}px)` }" :class="{ 'f-hidden': step <= 1 || step === 5 }">
        <rect class="f-peer-c" x="-30" y="-70" width="60" height="20" rx="10" />
        <text class="f-packet-text" x="0" y="-60">title</text>
      </g>

      <!-- converged -->
      <g :class="{ 'f-hidden': step !== 5 }">
        <rect class="f-ok" x="250" y="258" width="220" height="26" rx="13" />
        <text class="f-packet-text" x="360" y="271">same state on every node</text>
      </g>
    </template>
  </SyncFigure>
</template>
