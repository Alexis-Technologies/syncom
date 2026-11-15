<script setup lang="ts">
// Two tabs over one IndexedDB database: the writing tab appends the op to the log store, lands the record as
// one write set and, once that transaction completes, posts the record ids on the engine's BroadcastChannel;
// the following tab, opened read-only, reads those records again, makes their catalog rows again and wakes
// its watchers. It writes nothing.
// Depicts: src/idb/engine.js (a log group one transaction over `log`, a write set one transaction, `post`
// of `{ records: ids }` after it, `changes.subscribe` leaving the instance's own token out),
// src/database.js (#hearChange: the ids read in one getMany, #reread: the cache forgotten, the row indexed
// again, a live Document refreshed; READ_ONLY for a follower's write).
import SyncFigure from './SyncFigure.vue';

const steps = [
  'Two tabs open the board over one IndexedDB database. The first holds the lock and writes; the second opened with readOnly: true and watches the open tasks: 1.',
  'You add a task in the first tab. Its op is appended to the log store, one readwrite transaction, and the write resolves. The follower leaves the log to the writer.',
  'Up to defer ms later the record lands: one readwrite transaction over the stores it touches. Once it completes, the engine posts the record ids on the channel.',
  "The second tab hears { records: ['t2'] }. Each message carries its sender’s token, so a tab never hears its own writes. It reads the records heard in one call.",
  'Each record read again: its cache entry dropped, its catalog row made again, a live Document refreshed. The catalog’s change wakes the watch(): open tasks: 2.',
  'The follower writes nothing: a write there rejects with READ_ONLY. For tabs that all write, use leader election: one tab leads and the others write through it.',
];

const TABS = [
  { x: 20, title: 'tab 1 · writer', note: 'holds the lock', seesAt: 1 },
  { x: 530, title: 'tab 2 · readOnly', note: 'holds no lock', seesAt: 4 },
];
// The messages of the scene, each drawn on its way to where it goes at its step, hidden at the others.
const MESSAGES = [
  { step: 1, from: { x: 210, y: 162 }, to: { x: 230, y: 162 }, label: 'op t2', w: 56 },
  { step: 2, from: { x: 210, y: 203 }, to: { x: 230, y: 203 }, label: 'write set', w: 60 },
  { step: 3, from: { x: 180, y: 34 }, to: { x: 540, y: 34 }, label: 'records: [t2]', w: 104 },
  { step: 4, from: { x: 472, y: 203 }, to: { x: 490, y: 203 }, label: 'getMany', w: 56 },
];
const at = (m: (typeof MESSAGES)[number], step: number) => (step >= m.step ? m.to : m.from);
</script>

<template>
  <SyncFigure
    caption="A read-only tab follows the writing tab: it hears the ids of every write set and reads those records again"
    :steps="steps"
    :key-step="4"
  >
    <template #default="{ step, grad }">
      <!-- the channel between the tabs -->
      <path class="f-link" d="M 105 64 V 34 H 615 V 64" />
      <text class="f-muted" x="360" y="24" text-anchor="middle">BroadcastChannel 'syncom:board'</text>

      <!-- the tabs -->
      <g v-for="tab in TABS" :key="tab.title">
        <rect class="f-card" :x="tab.x" y="64" width="170" height="146" rx="10" />
        <rect class="f-cell" :x="tab.x" y="64" width="170" height="28" rx="10" />
        <text class="f-label" :x="tab.x + 85" y="83">{{ tab.title }}</text>
        <circle class="f-node" :cx="tab.x + 30" cy="124" r="18" :fill="grad" />
        <text class="f-node-text" :x="tab.x + 30" y="124">db</text>
        <text :class="['f-text', { 'f-changed': step === tab.seesAt }]" :x="tab.x + 58" y="128">
          open tasks: {{ step >= tab.seesAt ? 2 : 1 }}
        </text>
        <text class="f-muted f-mono" :x="tab.x + 16" y="166">t1</text>
        <text class="f-text" :x="tab.x + 38" y="166">Write the docs</text>
        <g :class="{ 'f-hidden': step < tab.seesAt }">
          <text class="f-muted f-mono" :x="tab.x + 16" y="190">t2</text>
          <text :class="['f-text', { 'f-changed': step === tab.seesAt }]" :x="tab.x + 38" y="190">Ship it</text>
        </g>
        <text class="f-muted" :x="tab.x + 85" y="232" text-anchor="middle">{{ tab.note }}</text>
      </g>
      <text :class="['f-text', 'f-changed', { 'f-hidden': step !== 5 }]" x="615" y="254" text-anchor="middle">
        a write rejects: READ_ONLY
      </text>

      <!-- IndexedDB -->
      <line class="f-link" x1="190" y1="162" x2="270" y2="162" />
      <line class="f-link" x1="190" y1="203" x2="270" y2="203" />
      <line class="f-link" x1="450" y1="203" x2="530" y2="203" />
      <rect class="f-card" x="270" y="110" width="180" height="170" rx="10" />
      <text class="f-label" x="360" y="132">IndexedDB 'board'</text>
      <text :class="['f-muted', { 'f-changed': step === 1 }]" x="284" y="166">log</text>
      <rect v-for="i in 4" :key="i" class="f-cell" :x="312 + i * 20" y="154" width="16" height="16" rx="3" />
      <rect :class="['f-peer-a', { 'f-hidden': step < 1 }]" x="412" y="154" width="16" height="16" rx="3" />
      <text :class="['f-muted', { 'f-changed': step === 2 }]" x="284" y="207">records</text>
      <rect class="f-cell" x="336" y="192" width="40" height="22" rx="4" />
      <text class="f-text f-mono" x="356" y="207" text-anchor="middle">t1</text>
      <g :class="{ 'f-hidden': step < 2 }">
        <rect :class="step === 2 ? 'f-peer-a' : 'f-cell'" x="382" y="192" width="40" height="22" rx="4" />
        <text :class="step === 2 ? 'f-packet-text' : ['f-text', 'f-mono']" x="402" :y="step === 2 ? 203 : 207" :text-anchor="step === 2 ? undefined : 'middle'">t2</text>
      </g>
      <text class="f-muted" x="284" y="246">kv · pieces · copies · meta</text>

      <!-- the messages -->
      <g
        v-for="m in MESSAGES"
        :key="m.label"
        :class="{ 'f-hidden': step !== m.step }"
        :style="{ transform: `translate(${at(m, step).x}px, ${at(m, step).y}px)` }"
      >
        <rect class="f-peer-a" :x="-m.w / 2" y="-10" :width="m.w" height="20" rx="10" />
        <text class="f-packet-text" x="0" y="0">{{ m.label }}</text>
      </g>
    </template>
  </SyncFigure>
</template>
