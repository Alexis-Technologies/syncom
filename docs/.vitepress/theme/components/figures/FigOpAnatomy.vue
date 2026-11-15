<script setup lang="ts">
// What an op carries and how ops line up: the fields of one op (its name, its stamp, the change, the
// link to the op before it), the ops of each node as a stream of its own numbered without a hole,
// each node's log holding its own stream and what it received, the version vector as the highest
// seq held per stream, and two vectors compared to name exactly the ops each side lacks.
// Depicts: src/commit.js (prepareOp, link), src/header.js (the header, the fingerprint),
// src/vector.js (opKey, vectorHas, compareVectors), src/log.js (the vector, the streams),
// src/sync/outbound.js (the ops a receiver lacks, by its vector).
import SyncFigure from './SyncFigure.vue';

const steps = [
  'You update a task on the laptop and get one op: origin and seq name it, ts stamps it, type, id and data carry the change, and prev ties it to the op before it.',
  "The laptop's ops form its stream, laptop:1, 2, 3, numbered without a hole; this op is laptop:3. The phone's ops form a stream of their own.",
  'Each log holds its own stream and what it received: the laptop has phone:1, the phone has laptop:1 and 2. Inside a log, each stream keeps its order.',
  'A version vector is the highest seq a node holds of each stream: laptop 3, phone 1 on the laptop; laptop 2, phone 2 on the phone.',
  'Compared key by key, the two vectors name exactly what is missing: the phone lacks laptop:3 and the laptop lacks phone:2. Nothing else has to cross.',
  'Each side receives just those ops. Both logs now hold every op, and both vectors read laptop 3, phone 2.',
];

type Field = { name: string; value: string; y: number; group: 'name' | 'time' | 'change' | 'chain' };
const FIELDS: Field[] = [
  { name: 'origin', value: 'laptop', y: 66, group: 'name' },
  { name: 'seq', value: '3', y: 86, group: 'name' },
  { name: 'ts', value: '1793087684846', y: 118, group: 'time' },
  { name: 'type', value: 'set', y: 150, group: 'change' },
  { name: 'id', value: 't1', y: 170, group: 'change' },
  { name: 'data', value: '{ done: true }', y: 190, group: 'change' },
  { name: 'prev', value: 'SmNV…', y: 222, group: 'chain' },
];
const lit = (step: number, group: Field['group']) =>
  (step === 0 && group !== 'name') || (step === 1 && group === 'name');

const ROW = { laptop: 90, phone: 226 };
const cellX = (i: number) => 336 + i * 30;

// Each log's cells: the stream ('a' laptop, 'c' phone), the seq, and from which step it is there.
type Cell = { stream: 'a' | 'c'; seq: number; from: number };
const LOGS: Record<'laptop' | 'phone', Cell[]> = {
  laptop: [
    { stream: 'a', seq: 1, from: 1 },
    { stream: 'a', seq: 2, from: 1 },
    { stream: 'a', seq: 3, from: 1 },
    { stream: 'c', seq: 1, from: 2 },
    { stream: 'c', seq: 2, from: 5 },
  ],
  phone: [
    { stream: 'c', seq: 1, from: 1 },
    { stream: 'c', seq: 2, from: 1 },
    { stream: 'a', seq: 1, from: 2 },
    { stream: 'a', seq: 2, from: 2 },
    { stream: 'a', seq: 3, from: 5 },
  ],
};

const vector = (node: 'laptop' | 'phone', step: number) =>
  node === 'laptop' ? { laptop: 3, phone: step >= 5 ? 2 : 1 } : { laptop: step >= 5 ? 3 : 2, phone: 2 };

// The two ops that cross: next to their source at step 4, into the other log at step 5.
const lacked = (which: 'laptop' | 'phone', step: number) => {
  if (which === 'laptop') return step >= 5 ? { x: cellX(4) + 13, y: ROW.phone } : { x: 380, y: 130 };
  return step >= 5 ? { x: cellX(4) + 13, y: ROW.laptop } : { x: 460, y: 176 };
};
</script>

<template>
  <SyncFigure caption="An op, the streams it forms, and the vectors that say what each node lacks" :steps="steps" :key-step="4">
    <template #default="{ step, grad }">
      <!-- one op -->
      <rect class="f-card" x="10" y="14" width="220" height="272" rx="10" />
      <text class="f-label" x="120" y="38">the op update() makes</text>
      <g v-for="field in FIELDS" :key="field.name">
        <text class="f-muted" x="26" :y="field.y">{{ field.name }}</text>
        <text :class="['f-text', 'f-mono', { 'f-changed': lit(step, field.group) }]" x="82" :y="field.y">
          {{ field.value }}
        </text>
      </g>
      <rect class="f-cell" x="22" y="98" width="196" height="1" />
      <rect class="f-cell" x="22" y="130" width="196" height="1" />
      <rect class="f-cell" x="22" y="202" width="196" height="1" />
      <text class="f-muted" x="26" y="246">digest, nonce, sig: when signed</text>
      <text class="f-muted" x="26" y="268">v, actor, msg: when there is one</text>

      <!-- the streams' colours -->
      <rect class="f-peer-a" x="470" y="16" width="12" height="12" rx="3" />
      <text class="f-muted" x="488" y="26">laptop's stream</text>
      <rect class="f-peer-c" x="590" y="16" width="12" height="12" rx="3" />
      <text class="f-muted" x="608" y="26">phone's stream</text>

      <!-- two nodes, their logs and vectors -->
      <g v-for="(y, node) in ROW" :key="node">
        <circle class="f-node" cx="290" :cy="y" r="28" :fill="grad" />
        <text class="f-node-text" x="290" :y="y">{{ node }}</text>
        <text class="f-muted" x="336" :y="y - 22">{{ node }}'s log</text>
        <g v-for="(cell, i) in LOGS[node]" :key="i" :class="{ 'f-hidden': step < cell.from }">
          <rect
            :class="cell.stream === 'a' ? 'f-peer-a' : 'f-peer-c'"
            :x="cellX(i)"
            :y="y - 11"
            width="26"
            height="22"
            rx="4"
          />
          <text class="f-packet-text" :x="cellX(i) + 13" :y="y">{{ cell.seq }}</text>
        </g>

        <g :class="{ 'f-hidden': step < 3 }">
          <text class="f-muted" x="510" :y="y - 34">vector</text>
          <rect class="f-card" x="510" :y="y - 28" width="100" height="56" rx="8" />
          <text class="f-muted" x="522" :y="y - 6">laptop</text>
          <text
            :class="['f-text', 'f-mono', { 'f-changed': step === 5 && node === 'phone' }]"
            x="585"
            :y="y - 6"
          >
            {{ vector(node, step).laptop }}
          </text>
          <text class="f-muted" x="522" :y="y + 16">phone</text>
          <text
            :class="['f-text', 'f-mono', { 'f-changed': step === 5 && node === 'laptop' }]"
            x="585"
            :y="y + 16"
          >
            {{ vector(node, step).phone }}
          </text>
        </g>
        <text :class="['f-text', { 'f-hidden': step !== 4 }]" x="620" :y="y + 4">
          {{ node === 'laptop' ? 'needs phone:2' : 'needs laptop:3' }}
        </text>
      </g>

      <!-- what each lacks, on its way -->
      <g
        :style="{ transform: `translate(${lacked('laptop', step).x}px, ${lacked('laptop', step).y}px)` }"
        :class="{ 'f-hidden': step !== 4 }"
      >
        <rect class="f-peer-a" x="-32" y="-10" width="64" height="20" rx="10" />
        <text class="f-packet-text" x="0" y="0">laptop:3</text>
      </g>
      <g
        :style="{ transform: `translate(${lacked('phone', step).x}px, ${lacked('phone', step).y}px)` }"
        :class="{ 'f-hidden': step !== 4 }"
      >
        <rect class="f-peer-c" x="-32" y="-10" width="64" height="20" rx="10" />
        <text class="f-packet-text" x="0" y="0">phone:2</text>
      </g>

      <g :class="{ 'f-hidden': step !== 5 }">
        <rect class="f-ok" x="520" y="146" width="180" height="24" rx="12" />
        <text class="f-packet-text" x="610" y="158">both: laptop 3, phone 2</text>
      </g>
    </template>
  </SyncFigure>
</template>
