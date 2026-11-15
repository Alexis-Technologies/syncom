<script setup lang="ts">
// A local write from the call to the events: inside the mutation queue the op is built (the record
// read, the field's kind checked, the op stamped and numbered in this node's stream, applied and
// validated), linked to the op before it, signed and appended, its log position reserved at once so
// the queue moves on; once its group is on disk the record waits in a deferred slot, where reads see
// it, and `change` and `commit` fire; a second write to the record within the window shares the
// slot, and one record file lands both.
// Depicts: src/commit.js (prepare, prepareOp, validateLocal, link, issue, land, announce),
// src/log.js (enqueue, the groups), src/defer.js (DeferredWindow), src/entries.js (hold, write).
import SyncFigure from './SyncFigure.vue';

const steps = [
  "You call update(). The write enters the database's mutation queue, which reads t1 as it is now and checks the field's kind.",
  "Inside the queue the op is built: stamped with ts, numbered laptop:7 (the next seq of this node's stream), applied to t1 and run through the validator.",
  'The op is linked to the one before it (prev), signed if you sign, and appended. Its log position is reserved at once, so the queue moves on while the group is written.',
  'The group is on disk: the write is durable from here. t1 waits in a deferred slot, where reads already see it, and the change and commit events fire.',
  'A second update() to t1 within 16 ms goes the same way as laptop:8. Its op is in the log and announced, and the slot now holds both writes.',
  'The window closes: one record file write lands both ops, and the log marks them applied. A crash before this point replays them from the log.',
];

const COL = { queue: 110, log: 295, slot: 465, file: 630 };
const PACKET_Y = 208;

const call = (step: number) =>
  step >= 4 ? "await db.Task.update('t1', { title: 'Ship' })" : "await db.Task.update('t1', { done: true })";

// The queue's work, and which lines a step lights.
const work = (step: number) => [
  'read t1, check the kind',
  `stamp ts, seq ${step >= 4 ? 'laptop:8' : 'laptop:7'}`,
  'apply, validate',
  'link prev, sign',
  'append: position reserved',
];
const lit = (step: number, line: number) => {
  if (step === 4) return true;
  if (step === 0) return line === 0;
  if (step === 1) return line === 1 || line === 2;
  if (step === 2) return line === 3 || line === 4;
  return false;
};
const queueFree = (step: number) => step === 2 || step === 3 || step === 5;
const logStatus = (step: number) =>
  ['', '', 'group being written', 'group on disk', 'next group on disk', '41, 42 applied'][step];

// Where each op's packet is.
const op7 = (step: number) => {
  if (step <= 1) return { x: COL.queue, hidden: step === 0 };
  if (step === 2) return { x: COL.log, hidden: false };
  if (step === 3) return { x: COL.slot, hidden: false };
  if (step === 4) return { x: COL.slot - 36, hidden: false };
  return { x: COL.file, hidden: true };
};
const op8 = (step: number) => {
  if (step <= 3) return { x: COL.queue, hidden: true };
  if (step === 4) return { x: COL.slot + 36, hidden: false };
  return { x: COL.file, hidden: true };
};
</script>

<template>
  <SyncFigure caption="A local write: queue, log, deferred slot, record file, events" :steps="steps" :key-step="4">
    <template #default="{ step }">
      <!-- the call -->
      <rect class="f-card" x="10" y="8" width="380" height="28" rx="8" />
      <text :class="['f-text', 'f-mono', { 'f-changed': step === 4 }]" x="22" y="27">{{ call(step) }}</text>
      <text class="f-muted" x="405" y="27">defer: record files wait 16 ms by default</text>

      <!-- the four stations -->
      <rect class="f-card" x="15" y="50" width="190" height="178" rx="10" />
      <rect class="f-card" x="215" y="50" width="160" height="178" rx="10" />
      <rect class="f-card" x="385" y="50" width="160" height="178" rx="10" />
      <rect class="f-card" x="555" y="50" width="150" height="178" rx="10" />
      <text class="f-label" :x="COL.queue" y="72">mutation queue</text>
      <text class="f-label" :x="COL.log" y="72">log</text>
      <text class="f-label" :x="COL.slot" y="72">deferred slot</text>
      <text class="f-label" :x="COL.file" y="72">record file</text>

      <!-- the queue's work -->
      <text
        v-for="(line, i) in work(step)"
        :key="i"
        :class="['f-text', { 'f-changed': lit(step, i) }]"
        x="30"
        :y="94 + i * 18"
      >
        {{ line }}
      </text>
      <text class="f-muted" x="30" y="190">{{ queueFree(step) ? 'free for the next write' : 'busy with this write' }}</text>

      <!-- the log: entries, positions, the group -->
      <rect class="f-cell" x="229" y="88" width="18" height="16" rx="3" />
      <rect class="f-cell" x="251" y="88" width="18" height="16" rx="3" />
      <rect class="f-cell" x="273" y="88" width="18" height="16" rx="3" />
      <rect :class="['f-peer-a', { 'f-hidden': step < 2 }]" x="295" y="88" width="18" height="16" rx="3" />
      <rect :class="['f-peer-a', { 'f-hidden': step < 4 }]" x="317" y="88" width="18" height="16" rx="3" />
      <text :class="['f-muted', 'f-mono', { 'f-hidden': step < 2 }]" x="229" y="128">laptop:7 at 41</text>
      <text :class="['f-muted', 'f-mono', { 'f-hidden': step < 4 }]" x="229" y="146">laptop:8 at 42</text>
      <text :class="['f-text', { 'f-changed': step >= 3 }]" x="229" y="172">{{ logStatus(step) }}</text>

      <!-- the deferred slot -->
      <g :class="{ 'f-hidden': step < 3 || step === 5 }">
        <rect class="f-card" x="397" y="84" width="136" height="70" rx="8" />
        <text class="f-text f-mono" x="409" y="104">t1</text>
        <text class="f-muted" x="409" y="124">done</text>
        <text class="f-text f-mono" x="455" y="124">true</text>
        <text class="f-muted" x="409" y="144">title</text>
        <text :class="['f-text', 'f-mono', { 'f-changed': step === 4 }]" x="455" y="144">
          {{ step >= 4 ? 'Ship' : 'Docs' }}
        </text>
      </g>
      <text class="f-muted" x="397" y="174">
        {{ step === 3 ? 'reads see it here' : step === 4 ? 'both writes, one slot' : step === 5 ? 'empty again' : '' }}
      </text>
      <text :class="['f-muted', { 'f-hidden': step !== 3 }]" x="397" y="190">the window: 16 ms</text>

      <!-- the record file -->
      <rect class="f-card" x="567" y="84" width="126" height="70" rx="8" />
      <text class="f-muted f-mono" x="579" y="104">data/t1.json</text>
      <text class="f-muted" x="579" y="124">done</text>
      <text :class="['f-text', 'f-mono', { 'f-changed': step === 5 }]" x="620" y="124">
        {{ step === 5 ? 'true' : 'false' }}
      </text>
      <text class="f-muted" x="579" y="144">title</text>
      <text :class="['f-text', 'f-mono', { 'f-changed': step === 5 }]" x="620" y="144">
        {{ step === 5 ? 'Ship' : 'Docs' }}
      </text>
      <text :class="['f-text', { 'f-changed': step === 5 }]" x="567" y="174">
        {{ step === 5 ? 'one write, both ops' : step >= 3 ? 'still the old file' : '' }}
      </text>

      <!-- the two ops on their way -->
      <g
        :style="{ transform: `translate(${op7(step).x}px, ${PACKET_Y}px)` }"
        :class="{ 'f-hidden': op7(step).hidden }"
      >
        <rect class="f-peer-a" x="-32" y="-10" width="64" height="20" rx="10" />
        <text class="f-packet-text" x="0" y="0">laptop:7</text>
      </g>
      <g
        :style="{ transform: `translate(${op8(step).x}px, ${PACKET_Y}px)` }"
        :class="{ 'f-hidden': op8(step).hidden }"
      >
        <rect class="f-peer-a" x="-32" y="-10" width="64" height="20" rx="10" />
        <text class="f-packet-text" x="0" y="0">laptop:8</text>
      </g>

      <!-- the events -->
      <text class="f-muted" x="15" y="270">events</text>
      <g :class="{ 'f-hidden': step < 3 }">
        <text class="f-muted f-mono" x="70" y="270">laptop:7</text>
        <rect class="f-peer-a" x="130" y="256" width="60" height="20" rx="10" />
        <text class="f-packet-text" x="160" y="266">change</text>
        <rect class="f-peer-a" x="196" y="256" width="60" height="20" rx="10" />
        <text class="f-packet-text" x="226" y="266">commit</text>
      </g>
      <g :class="{ 'f-hidden': step < 4 }">
        <text class="f-muted f-mono" x="290" y="270">laptop:8</text>
        <rect class="f-peer-a" x="350" y="256" width="60" height="20" rx="10" />
        <text class="f-packet-text" x="380" y="266">change</text>
        <rect class="f-peer-a" x="416" y="256" width="60" height="20" rx="10" />
        <text class="f-packet-text" x="446" y="266">commit</text>
      </g>
      <text :class="['f-muted', { 'f-hidden': step < 3 }]" x="500" y="270">fired before the file lands</text>
    </template>
  </SyncFigure>
</template>
