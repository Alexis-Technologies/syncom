<script setup lang="ts">
// Tombstone cleanup: a delete leaves a tombstone so the deletion reaches every node and a late op stamped
// below it stays moot. cleanup() folds this node's tombstone only once every enabled registered node
// acknowledged the delete and minimumDeletedTime passed, and the fold keeps the whole tombstone in the
// tombstones kv namespace, so it still wins over a late op.
// Depicts: src/cleanup/cleanup.js (the sweep: the horizon from the row's stamp, the ack check against
// node.acked, foldMany), src/entries.js (foldMany: the tombstone whole into the tombstones kv namespace, the
// file removed in one write set; a read falls back to it), src/ops.js (an op stamped below the delete is moot).
import SyncFigure from './SyncFigure.vue';

const steps = [
  'You delete task t1 on the laptop. Its file becomes a tombstone that keeps the delete’s stamp, and the delete is an op in the log. The phone is offline with an older edit.',
  'cleanup(db).run() skips it for now: the server, the node the laptop syncs with, has not acknowledged the delete, and minimumDeletedTime, 31 days, has not passed.',
  'The delete reaches the server, and the server’s answer acknowledges it. A tombstone a peer made folds on age alone; one of this node’s own also waits for the acks.',
  '31 days later a sweep folds it: the file goes, and the collection, the data and the stamps move whole into the tombstones kv namespace. The catalog row stays.',
  'The phone comes back with its edit of t1, stamped before the delete. The server relays it; on the laptop the folded tombstone still wins, and the edit changes nothing.',
  'The phone gets the delete too: t1 is gone on every node. run({ drop: true }) would forget the folded tombstone as well, and a late op would then make a new record.',
];

const X = { laptop: 110, server: 360, phone: 610 };
const Y = 80;
type Node = 'laptop' | 'server' | 'phone';
const deleted = (node: Node, step: number) => node === 'laptop' || (node === 'server' && step >= 2) || step >= 5;
const deletedNow = (node: Node, step: number) =>
  (node === 'laptop' && step === 0) || (node === 'server' && step === 2) || (node === 'phone' && step === 5);
const keptAs = (node: Node, step: number) => (node === 'laptop' && step >= 3 ? 'tombstones kv' : 'data/t1.json');
const phoneOnline = (step: number) => step >= 4;
const sweep = (step: number) => (step === 1 ? 'run() → skipped 1' : step === 3 ? 'run() → folded 1' : '');
const MESSAGES = [
  { step: 2, from: X.laptop, to: X.server, label: 'delete t1', cls: 'f-peer-a', w: 80 },
  { step: 4, from: X.phone, to: X.laptop + 70, label: 'older edit of t1', cls: 'f-peer-c', w: 120 },
  { step: 5, from: X.server, to: X.phone, label: 'delete t1', cls: 'f-peer-a', w: 80 },
];
</script>

<template>
  <SyncFigure caption="A tombstone is folded only after every node acknowledged the delete, and it still wins after" :steps="steps" :key-step="4">
    <template #default="{ step, grad }">
      <line class="f-link" :x1="X.laptop + 30" :y1="Y" :x2="X.server - 30" :y2="Y" />
      <line :class="['f-link', { 'f-link-off': !phoneOnline(step) }]" :x1="X.server + 30" :y1="Y" :x2="X.phone - 30" :y2="Y" />
      <text :class="['f-muted', { 'f-hidden': phoneOnline(step) }]" :x="(X.server + X.phone) / 2" :y="Y + 18" text-anchor="middle">offline</text>
      <text :class="['f-muted', { 'f-hidden': step !== 3 }]" :x="(X.laptop + X.server) / 2" :y="Y + 18" text-anchor="middle">31 days later</text>

      <g v-for="(x, node) in X" :key="node">
        <circle class="f-node" :cx="x" :cy="Y" r="30" :fill="grad" />
        <text class="f-node-text" :x="x" :y="Y">{{ node }}</text>
        <rect class="f-card" :x="x - 92" y="124" width="184" height="80" rx="10" />
        <text class="f-text f-mono" :x="x - 78" y="147">t1</text>
        <text :class="['f-text', { 'f-changed': deletedNow(node, step) }]" :x="x - 50" y="147">
          {{ deleted(node, step) ? 'tombstone' : node === 'phone' ? 'Ship Friday' : 'Ship it' }}
        </text>
        <text class="f-muted" :x="x - 78" y="169">kept as</text>
        <text :class="['f-text', 'f-mono', { 'f-changed': node === 'laptop' && step === 3 }]" :x="x - 30" y="169">
          {{ keptAs(node, step) }}
        </text>
      </g>
      <!-- what the laptop knows of the acks, and what the phone holds back -->
      <text class="f-muted" :x="X.laptop - 78" y="191">acked</text>
      <text :class="['f-text', { 'f-changed': step === 2 }]" :x="X.laptop - 30" y="191">{{ step >= 2 ? 'by the server' : 'not yet' }}</text>
      <g :class="{ 'f-hidden': phoneOnline(step) }">
        <text class="f-muted" :x="X.phone - 78" y="191">unsent</text>
        <text class="f-text" :x="X.phone - 30" y="191">the title edit</text>
      </g>

      <text :class="['f-text', 'f-mono', { 'f-hidden': sweep(step) === '' }]" :x="X.laptop - 92" y="230">
        {{ sweep(step) || 'run() → folded 1' }}
      </text>

      <!-- ops on their way -->
      <g
        v-for="m in MESSAGES"
        :key="m.step"
        :class="{ 'f-hidden': step !== m.step }"
        :style="{ transform: `translate(${step >= m.step ? m.to : m.from}px, ${Y - 48}px)` }"
      >
        <rect :class="m.cls" :x="-m.w / 2" y="-10" :width="m.w" height="20" rx="10" />
        <text class="f-packet-text" x="0" y="0">{{ m.label }}</text>
      </g>

      <g :class="{ 'f-hidden': step !== 5 }">
        <rect class="f-ok" x="250" y="254" width="220" height="26" rx="13" />
        <text class="f-packet-text" x="360" y="267">deleted on every node</text>
      </g>
    </template>
  </SyncFigure>
</template>
