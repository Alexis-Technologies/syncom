<script setup lang="ts">
// One local write and the hooks around it: inside the queue the record is loaded, beforeWrite runs (it may
// hand back new fields or throw), the op is stamped, applied, validated and appended to the log, and the
// queue moves on; outside it, in log order once the append is durable, the record lands, afterWrite runs,
// and the events fire — the live Document's update, commit, change, transaction — with listeners called at
// once and a throwing one only logged.
// Depicts: src/commit.js (prepare: current, beforeWrite through `replaced`, opOf, validateLocal; issue: the
// append; land, then announce: afterWrite, the refresh, `commit` and `change`, then `transacted`),
// src/hooks.js (runHook makes a throw a HookError; notify contains a listener's throw as a warning),
// src/database.js (the mutation queue and the hook runner it lends).
import SyncFigure from './SyncFigure.vue';

const steps = [
  'You call update() on t1. The write joins the queue, one write at a time, and the queue loads t1 as it is now: what your hooks see as current.',
  'beforeWrite runs with the op’s type, your fields and current. It may return new fields to write; if it throws, nothing is stamped, logged or written.',
  'The op gets its stamp, is applied to t1 and validated, then appended to the log. The queue moves on to the next write from here.',
  'Outside the queue, in log order: once the op is on disk, t1 lands and afterWrite runs. If it throws, the write stands; only your call rejects, with a HookError.',
  'Then the events: the live Document updates, and commit, change and transaction fire. Listeners are called at once, never awaited, and your update() resolves.',
  'A listener that throws is logged as a warning and forgotten. The other listeners still hear the event, and the write is done whatever they do.',
];

const X = [165, 260, 355, 450, 545, 640];
const TOP = 78;
const BOTTOM = 208;
const INSIDE = [
  { label: 'load t1', mono: false },
  { label: 'beforeWrite', mono: true },
  { label: 'stamp', mono: false },
  { label: 'apply', mono: false },
  { label: 'validate', mono: false },
  { label: 'append to log', mono: false },
];
const OUTSIDE = [
  { label: 't1 lands', mono: false },
  { label: 'afterWrite', mono: true },
  { label: 'Document', mono: false },
  { label: 'commit', mono: true },
  { label: 'change', mono: true },
  { label: 'transaction', mono: true },
];

// Which stations the write is at, per band and step.
const activeInside = (i: number, step: number) => (step === 0 && i === 0) || (step === 1 && i === 1) || (step === 2 && i >= 2);
const activeOutside = (i: number, step: number) => (step === 3 && i <= 1) || (step >= 4 && i >= 2);
// Where each op is: t1 the write you made, t2 the next write the queue takes once t1 is appended.
const t1At = (step: number) => {
  if (step <= 1) return { x: X[step], y: TOP - 16 };
  if (step === 2) return { x: X[5], y: TOP - 16 };
  return { x: X[1], y: BOTTOM - 16 };
};
const t2At = (step: number) => ({ x: X[[0, 0, 0, 1, 4, 5][step]], y: TOP - 16 });
</script>

<template>
  <SyncFigure
    caption="A local write runs its hooks inside the queue, then lands and is announced outside it, in log order"
    :steps="steps"
    :key-step="3"
  >
    <template #default="{ step }">
      <text class="f-text f-mono" x="20" y="22">db.Task.update('t1', { title: 'Ship v2' })</text>

      <!-- inside the queue -->
      <rect class="f-card" x="20" y="36" width="680" height="100" rx="10" />
      <text class="f-muted" x="34" y="90">inside</text>
      <text class="f-muted" x="34" y="104">the queue</text>
      <line class="f-link" :x1="X[0]" :y1="TOP + 15" :x2="X[5]" :y2="TOP + 15" />
      <g v-for="(s, i) in INSIDE" :key="s.label">
        <rect
          :class="activeInside(i, step) ? 'f-card f-stroke-a' : 'f-cell'"
          :x="X[i] - 43"
          :y="TOP"
          width="86"
          height="30"
          rx="6"
        />
        <text
          :class="['f-text', { 'f-mono': s.mono, 'f-changed': activeInside(i, step) }]"
          :x="X[i]"
          :y="TOP + 19"
          text-anchor="middle"
        >
          {{ s.label }}
        </text>
      </g>
      <text :class="['f-muted', { 'f-hidden': step !== 1 }]" :x="X[1]" y="126" text-anchor="middle">
        may replace data, or throw
      </text>
      <text :class="['f-muted', { 'f-hidden': step !== 2 }]" x="690" y="126" text-anchor="end">the queue moves on here</text>

      <!-- durable: from the append to the landing -->
      <path class="f-link" :d="`M ${X[5]} ${TOP + 30} V 152 H ${X[0]} V ${BOTTOM}`" />
      <text class="f-muted" x="400" y="146" text-anchor="middle">once the op’s log group is on disk</text>

      <!-- outside the queue -->
      <rect class="f-card" x="20" y="166" width="680" height="104" rx="10" />
      <text class="f-muted" x="34" y="214">outside,</text>
      <text class="f-muted" x="34" y="228">in log order</text>
      <line class="f-link" :x1="X[0]" :y1="BOTTOM + 15" :x2="X[5]" :y2="BOTTOM + 15" />
      <g v-for="(s, i) in OUTSIDE" :key="s.label">
        <rect
          :class="activeOutside(i, step) ? 'f-card f-stroke-a' : 'f-cell'"
          :x="X[i] - 43"
          :y="BOTTOM"
          width="86"
          height="30"
          rx="6"
        />
        <text
          :class="['f-text', { 'f-mono': s.mono, 'f-changed': activeOutside(i, step) }]"
          :x="X[i]"
          :y="BOTTOM + 19"
          text-anchor="middle"
        >
          {{ s.label }}
        </text>
      </g>
      <text :class="['f-muted', { 'f-hidden': step !== 3 }]" :x="X[1]" y="258" text-anchor="middle">
        a throw: HookError, the write stands
      </text>
      <text :class="['f-muted', { 'f-hidden': step !== 4 }]" x="497" y="258" text-anchor="middle">
        listeners called at once, never awaited
      </text>
      <text :class="['f-muted', { 'f-hidden': step !== 5 }]" :x="X[4]" y="258" text-anchor="middle">
        a listener threw: a warning, nothing more
      </text>

      <!-- the two writes -->
      <g :style="{ transform: `translate(${t2At(step).x}px, ${t2At(step).y}px)` }" :class="{ 'f-hidden': step < 2 }">
        <rect class="f-peer-c" x="-28" y="-10" width="56" height="20" rx="10" />
        <text class="f-packet-text" x="0" y="0">op t2</text>
      </g>
      <g :style="{ transform: `translate(${t1At(step).x}px, ${t1At(step).y}px)` }" :class="{ 'f-hidden': step >= 4 }">
        <rect class="f-peer-a" x="-28" y="-10" width="56" height="20" rx="10" />
        <text class="f-packet-text" x="0" y="0">op t1</text>
      </g>

      <!-- the call settles -->
      <g :class="{ 'f-hidden': step < 4 }">
        <rect class="f-ok" x="285" y="277" width="150" height="20" rx="10" />
        <text class="f-packet-text" x="360" y="287">update() resolves</text>
      </g>
    </template>
  </SyncFigure>
</template>
