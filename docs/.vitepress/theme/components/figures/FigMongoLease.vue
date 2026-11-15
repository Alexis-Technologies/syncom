<script setup lang="ts">
// One writer per database on MongoDB: a lease in the locks collection, renewed on the server's clock every
// third of its length; a renewal that fails is retried ('late') and given up with a third still left, so
// the holder stops while its lease is live; once the lease lapses another instance takes it with the
// generation one up, and the fence (every document carries the generation that wrote it) refuses a write
// from an older generation as LEASE_LOST.
// Depicts: src/mongodb/mongodb.js (take: insertOne, then findOneAndUpdate on $$NOW with gen one up; renew on
// { _id, owner, gen }; the retry every poll ms and the margin of a third; `fence`: a put matches no document
// of a newer gen and fails as LEASE_LOST), src/database.js (#lostLease: LEASE_LOST once, read-only after;
// #leaseState: the lease event).
import SyncFigure from './SyncFigure.vue';

const steps = [
  "api-1 opens the database and takes the lease: the locks document names it, gen 1, expiring 30 s from now on the server’s clock. api-2 gets LOCKED; with lock: 'wait' it waits.",
  'Every third of the lease api-1 renews it: an update matching { owner, gen } sets expires to $$NOW plus 30 s. Every document api-1 writes carries gen 1.',
  "A renewal fails: the network drops. api-1 hears the lease event 'late' and tries again every poll ms, while more than a third of the lease is left.",
  'Still failing with a third left, api-1 gives up while its lease is still live: LEASE_LOST once on its error event, and every write after it is READ_ONLY.',
  'The server’s clock passes expires: the lease lapsed. api-2 takes it with gen one up and replays what api-1 had logged but not stored. Its documents carry gen 2.',
  'The fence: a writer that never heard, say one paused longer than its lease, still writes with gen 1. No document of gen 2 matches its upsert, and it fails as LEASE_LOST.',
];

// The server's clock at each step, in seconds, and where a time sits on the axis.
const TIME = [0, 10, 20, 30, 40, 45];
const xOf = (t: number) => 60 + 12 * t;
const AXIS = 256;
// What happened when, drawn from its step on, above or below the axis.
const MARKS = [
  { t: 0, label: 'takes, gen 1', above: true, at: 0 },
  { t: 10, label: 'renews', above: false, at: 1 },
  { t: 20, label: 'renewal fails', above: true, at: 2 },
  { t: 30, label: 'api-1 gives up', above: false, at: 3 },
  { t: 40, label: 'lapses; api-2 takes', above: true, at: 4 },
  { t: 45, label: 'stale write fenced', above: false, at: 5 },
];
const owner = (step: number) => (step >= 4 ? 'api-2' : 'api-1');
const gen = (step: number) => (step >= 4 ? 2 : 1);
const expires = (step: number) => (step >= 4 ? 70 : step >= 1 ? 40 : 30);
const linkUp = (step: number) => step <= 1 || step === 5;
const STATUS = {
  api1: ['holds the lease', 'renews every 10 s', 'late: retrying', 'LEASE_LOST: read-only', 'read-only', 'a stale writer, gen 1'],
  api2: ['LOCKED: waits', "waits (lock: 'wait')", "waits (lock: 'wait')", "waits (lock: 'wait')", 'holds the lease', 'writes with gen 2'],
};
// The messages to the server, each drawn on its way at its step, hidden at the others.
const MESSAGES = [
  { step: 0, from: 120, to: 165, label: 'take', w: 56, cls: 'f-peer-a' },
  { step: 1, from: 120, to: 165, label: 'renew', w: 56, cls: 'f-peer-a' },
  { step: 2, from: 120, to: 165, label: 'renew: error', w: 88, cls: 'f-peer-a' },
  { step: 4, from: 600, to: 555, label: 'take, gen 2', w: 84, cls: 'f-peer-c' },
  { step: 5, from: 120, to: 165, label: 'put t1, gen 1', w: 96, cls: 'f-peer-a' },
];
</script>

<template>
  <SyncFigure
    caption="A lease on the server's clock keeps one writer per database, and the generation fences out the one that lost it"
    :steps="steps"
    :key-step="4"
    view-box="0 0 720 310"
  >
    <template #default="{ step, grad }">
      <!-- the two instances -->
      <line :class="['f-link', { 'f-link-off': !linkUp(step) }]" x1="100" y1="84" x2="230" y2="84" />
      <line class="f-link" x1="490" y1="84" x2="620" y2="84" />
      <circle class="f-node" cx="70" cy="84" r="30" :fill="grad" />
      <text class="f-node-text" x="70" y="84">api-1</text>
      <circle class="f-node" cx="650" cy="84" r="30" :fill="grad" />
      <text class="f-node-text" x="650" y="84">api-2</text>
      <text
        :class="['f-text', { 'f-changed': step > 0 && STATUS.api1[step] !== STATUS.api1[step - 1] }]"
        x="70"
        y="136"
        text-anchor="middle"
      >
        {{ STATUS.api1[step] }}
      </text>
      <text
        :class="['f-text', { 'f-changed': step > 0 && STATUS.api2[step] !== STATUS.api2[step - 1] }]"
        x="650"
        y="136"
        text-anchor="middle"
      >
        {{ STATUS.api2[step] }}
      </text>
      <text :class="['f-text', 'f-changed', { 'f-hidden': step !== 5 }]" x="70" y="156" text-anchor="middle">
        refused: LEASE_LOST
      </text>

      <!-- MongoDB: the lease and a record -->
      <rect class="f-card" x="230" y="30" width="260" height="176" rx="10" />
      <text class="f-label" x="360" y="52">MongoDB</text>
      <rect class="f-cell" x="246" y="64" width="228" height="88" rx="6" />
      <text class="f-muted f-mono" x="258" y="82">locks · { _id: 'board' }</text>
      <text class="f-muted" x="258" y="104">owner</text>
      <text :class="['f-text', 'f-mono', { 'f-changed': step === 4 }]" x="390" y="104">{{ owner(step) }}</text>
      <text class="f-muted" x="258" y="124">gen</text>
      <text :class="['f-text', 'f-mono', { 'f-changed': step === 4 }]" x="390" y="124">{{ gen(step) }}</text>
      <text class="f-muted" x="258" y="144">expires (server clock)</text>
      <text :class="['f-text', 'f-mono', { 'f-changed': step === 1 || step === 4 }]" x="390" y="144">
        {{ expires(step) }} s
      </text>
      <rect class="f-cell" x="246" y="162" width="228" height="34" rx="6" />
      <text class="f-muted f-mono" x="258" y="183">records · t1</text>
      <text :class="['f-text', 'f-mono', { 'f-changed': step === 4 }]" x="462" y="183" text-anchor="end">
        gen {{ gen(step) }}
      </text>

      <g
        v-for="m in MESSAGES"
        :key="m.label"
        :class="{ 'f-hidden': step !== m.step }"
        :style="{ transform: `translate(${step >= m.step ? m.to : m.from}px, 84px)` }"
      >
        <rect :class="m.cls" :x="-m.w / 2" y="-10" :width="m.w" height="20" rx="10" />
        <text class="f-packet-text" x="0" y="0">{{ m.label }}</text>
      </g>

      <!-- the leases on the server's clock -->
      <rect class="f-peer-a" :x="xOf(0)" y="214" :width="xOf(step >= 1 ? 40 : 30) - xOf(0)" height="16" rx="8" />
      <text class="f-packet-text" :x="(xOf(0) + xOf(step >= 1 ? 40 : 30)) / 2" y="222">api-1’s lease, gen 1</text>
      <g :class="{ 'f-hidden': step < 4 }">
        <rect class="f-peer-c" :x="xOf(40)" y="214" :width="xOf(50) - xOf(40)" height="16" rx="8" />
        <text class="f-packet-text" :x="(xOf(40) + xOf(50)) / 2" y="222">api-2, gen 2</text>
      </g>
      <line class="f-link" :x1="xOf(0)" :y1="AXIS" :x2="xOf(50)" :y2="AXIS" />
      <g v-for="m in MARKS" :key="m.label" :class="{ 'f-hidden': step < m.at }">
        <line class="f-link" :x1="xOf(m.t)" :y1="AXIS - 5" :x2="xOf(m.t)" :y2="AXIS + 5" />
        <text
          :class="['f-muted', { 'f-changed': step === m.at }]"
          :x="xOf(m.t)"
          :y="m.above ? AXIS - 11 : AXIS + 22"
          text-anchor="middle"
        >
          {{ m.label }}
        </text>
      </g>
      <g :style="{ transform: `translate(${xOf(TIME[step])}px, ${AXIS}px)` }">
        <circle class="f-ok" cx="0" cy="0" r="6" />
      </g>
      <text class="f-muted" :x="xOf(0)" y="300">the server’s clock ($$NOW), in seconds since the take</text>
    </template>
  </SyncFigure>
</template>
