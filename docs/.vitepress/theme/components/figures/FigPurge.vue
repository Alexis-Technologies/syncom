<script setup lang="ts">
// A purge, and why it leaves no hole: purge(id) wins at any stamp and erases the record; once it is
// durable every log entry of the record is scrubbed in place — the payload and its nonce go, the
// header (origin, seq, stamp, record, prev, a signed op's digest and signature) stays — so each
// fingerprint, each prev link and each stream stay whole; the purge replicates, the host scrubs its
// own log, and an op that lands on the purged record later is logged as a header alone.
// Depicts: src/ops.js (applyOp: purge, erase), src/database.js (purge), src/log.js (scrub),
// src/header.js (scrubOp, fingerprintOf), src/apply.js (applyOne: a purged record, persist).
import SyncFigure from './SyncFigure.vue';

const steps = [
  "Record t1 holds a PIN that must go. Its history is in the laptop's log: laptop:3 wrote it, phone:2 and laptop:5 changed it, among ops of another record, t2.",
  "You call purge('t1'). The purge op wins at any stamp: t1's data and merge state are erased here, and no write, however late its stamp, brings it back.",
  'Once the purge is durable, every log entry of t1 is scrubbed in place: its payload goes, with the nonce that salted its digest. The entries of t2 stay as they are.',
  'Each header stays: origin, seq, stamp, record, prev, and on a signed op its digest and signature. The fingerprint hashes the header alone, so every chain stays whole.',
  'The purge replicates like any op. The server applies it, erases t1 and scrubs its own log; a peer that resumes later takes the scrubbed ops as the no-ops they are.',
  'A write to t1 the phone made before it heard of the purge arrives later. It lands on a purged record: logged as a header alone, applied nowhere, relayed without payload.',
];

type Entry = { x: number; head: string; cls: string; payload: string | null; t1: boolean; fp: string; from: number };
// The laptop's log: t1's ops among t2's; the purge (no payload) from step 1.
const LAPTOP: Entry[] = [
  { x: 144, head: 'laptop:3 t1', cls: 'f-peer-a', payload: 'pin: 4711', t1: true, fp: 'Qa…', from: 0 },
  { x: 244, head: 'phone:1 t2', cls: 'f-peer-c', payload: 'votes +1', t1: false, fp: '8c…', from: 0 },
  { x: 344, head: 'phone:2 t1', cls: 'f-peer-c', payload: 'pin: 4712', t1: true, fp: 'Lw…', from: 0 },
  { x: 444, head: 'laptop:4 t2', cls: 'f-peer-a', payload: 'done: true', t1: false, fp: '3T…', from: 0 },
  { x: 544, head: 'laptop:5 t1', cls: 'f-peer-a', payload: 'pin: 9999', t1: true, fp: 'Zk…', from: 0 },
  { x: 644, head: 'laptop:6 t1', cls: 'f-peer-a', payload: null, t1: true, fp: 'Ve…', from: 1 },
];
// t1's entries in the server's log; the purge from step 4, the phone's late write from step 5.
const SERVER: Entry[] = [
  { x: 144, head: 'laptop:3 t1', cls: 'f-peer-a', payload: 'pin: 4711', t1: true, fp: '', from: 0 },
  { x: 244, head: 'phone:2 t1', cls: 'f-peer-c', payload: 'pin: 4712', t1: true, fp: '', from: 0 },
  { x: 344, head: 'laptop:5 t1', cls: 'f-peer-a', payload: 'pin: 9999', t1: true, fp: '', from: 0 },
  { x: 444, head: 'laptop:6 t1', cls: 'f-peer-a', payload: null, t1: true, fp: '', from: 4 },
];
const LATE = { x: 544, head: 'phone:3 t1', cls: 'f-peer-c' };
const ROW = { laptop: 48, server: 210 };
// A payload shows until its log is scrubbed: the laptop's at step 2, the server's at step 4.
const scrubbed = (row: 'laptop' | 'server', step: number) => step >= (row === 'laptop' ? 2 : 4);
</script>

<template>
  <SyncFigure caption="Purge: the payload scrubbed from the log, every header and chain left whole" :steps="steps" :key-step="3">
    <template #default="{ step, grad }">
      <!-- prev links of the two streams in the laptop's log -->
      <text class="f-muted" x="566" y="18">prev links</text>
      <path class="f-link f-stroke-a" d="M 144 46 Q 294 -10 444 46" />
      <path class="f-link f-stroke-a" d="M 444 46 Q 494 22 544 46" />
      <path :class="['f-link', 'f-stroke-a', { 'f-hidden': step < 1 }]" d="M 544 46 Q 594 22 644 46" />
      <path class="f-link f-stroke-c" d="M 244 46 Q 294 22 344 46" />

      <!-- the laptop's log -->
      <circle class="f-node" cx="50" cy="70" r="28" :fill="grad" />
      <text class="f-node-text" x="50" y="70">laptop</text>
      <g v-for="entry in LAPTOP" :key="entry.head" :class="{ 'f-hidden': step < entry.from }">
        <rect :class="entry.cls" :x="entry.x - 46" :y="ROW.laptop" width="92" height="22" rx="5" />
        <text class="f-packet-text" :x="entry.x" :y="ROW.laptop + 11">{{ entry.head }}</text>
        <g v-if="entry.t1">
          <rect class="f-card f-link-off" :x="entry.x - 46" :y="ROW.laptop + 24" width="92" height="26" rx="5" />
          <text class="f-muted" :x="entry.x" :y="ROW.laptop + 41" text-anchor="middle">
            {{ entry.payload === null ? 'no payload' : 'scrubbed' }}
          </text>
        </g>
        <g v-if="entry.payload !== null" :class="{ 'f-hidden': entry.t1 && scrubbed('laptop', step) }">
          <rect class="f-card" :x="entry.x - 46" :y="ROW.laptop + 24" width="92" height="26" rx="5" />
          <text class="f-muted f-mono" :x="entry.x" :y="ROW.laptop + 41" text-anchor="middle">{{ entry.payload }}</text>
        </g>
        <text class="f-muted f-mono" :x="entry.x" :y="ROW.laptop + 66" text-anchor="middle">fp {{ entry.fp }}</text>
      </g>
      <text class="f-muted" x="98" y="146">t1 on the laptop:</text>
      <text :class="['f-text', 'f-mono', { 'f-changed': step === 1 }]" x="206" y="146">
        {{ step >= 1 ? 'purged' : 'pin: 9999' }}
      </text>
      <g :class="{ 'f-hidden': step !== 3 }">
        <rect class="f-ok" x="400" y="132" width="300" height="24" rx="12" />
        <text class="f-packet-text" x="550" y="144">headers, fingerprints, prev: unchanged</text>
      </g>

      <!-- the purge on its way -->
      <line class="f-link" x1="50" y1="98" x2="50" y2="202" />
      <g
        :style="{ transform: `translate(50px, ${step <= 3 ? 110 : step === 4 ? 160 : 200}px)` }"
        :class="{ 'f-hidden': step !== 4 }"
      >
        <rect class="f-peer-a" x="-32" y="-10" width="64" height="20" rx="10" />
        <text class="f-packet-text" x="0" y="0">purge t1</text>
      </g>

      <!-- the server's log: t1's entries -->
      <circle class="f-node" cx="50" cy="230" r="28" :fill="grad" />
      <text class="f-node-text" x="50" y="230">server</text>
      <text class="f-muted" x="98" y="198">the server's log: t1's entries</text>
      <g v-for="entry in SERVER" :key="entry.head" :class="{ 'f-hidden': step < entry.from }">
        <rect :class="entry.cls" :x="entry.x - 46" :y="ROW.server" width="92" height="22" rx="5" />
        <text class="f-packet-text" :x="entry.x" :y="ROW.server + 11">{{ entry.head }}</text>
        <rect class="f-card f-link-off" :x="entry.x - 46" :y="ROW.server + 24" width="92" height="26" rx="5" />
        <text class="f-muted" :x="entry.x" :y="ROW.server + 41" text-anchor="middle">
          {{ entry.payload === null ? 'no payload' : 'scrubbed' }}
        </text>
        <g v-if="entry.payload !== null" :class="{ 'f-hidden': scrubbed('server', step) }">
          <rect class="f-card" :x="entry.x - 46" :y="ROW.server + 24" width="92" height="26" rx="5" />
          <text class="f-muted f-mono" :x="entry.x" :y="ROW.server + 41" text-anchor="middle">{{ entry.payload }}</text>
        </g>
      </g>
      <g :style="{ transform: `translate(${step >= 5 ? 0 : 124}px, 0px)` }" :class="{ 'f-hidden': step < 5 }">
        <rect :class="LATE.cls" :x="LATE.x - 46" :y="ROW.server" width="92" height="22" rx="5" />
        <text class="f-packet-text" :x="LATE.x" :y="ROW.server + 11">{{ LATE.head }}</text>
        <rect class="f-card f-link-off" :x="LATE.x - 46" :y="ROW.server + 24" width="92" height="26" rx="5" />
        <text class="f-muted" :x="LATE.x" :y="ROW.server + 41" text-anchor="middle">header only</text>
      </g>
      <circle class="f-node" cx="668" cy="236" r="28" :fill="grad" />
      <text class="f-node-text" x="668" y="236">phone</text>
      <text class="f-muted" x="98" y="284">t1 on the server:</text>
      <text :class="['f-text', 'f-mono', { 'f-changed': step === 4 }]" x="206" y="284">
        {{ step >= 4 ? 'purged' : 'pin: 9999' }}
      </text>
      <text :class="['f-muted', { 'f-hidden': step !== 5 }]" x="300" y="284">
        phone:3 lands on a purged record: applied nowhere
      </text>
    </template>
  </SyncFigure>
</template>
