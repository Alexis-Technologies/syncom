<script setup lang="ts">
// Awaited keystrokes on IndexedDB: each push is an op appended to the log as a group of its own — one
// readwrite transaction over the log store — while the record waits in memory, in its slot of the defer
// window, and lands once when the window closes: one write set, one readwrite transaction over the stores it
// touches.
// Depicts: src/idb/engine.js (log.append: one transaction over `log` per group; write: one transaction per
// write set), src/defer.js (DeferredWindow: a slot per record, the newest entry kept, the timer armed at the
// first write, the slots landed together), src/commit.js (the append, then the deferred landing).
import SyncFigure from './SyncFigure.vue';

const steps = [
  'You type “plan” into the notes of t1, awaiting each push(). t1 is in IndexedDB already, and no defer window is open.',
  '“p”: its op is appended to the log, one readwrite transaction over the log store, and your await returns. t1 waits in memory, where reads see it, and the 16 ms window opens.',
  '“l” and “a”: each awaited write is a log group of its own, so a log transaction each. t1’s slot in the window takes the newest entry; nothing reaches the records store.',
  '“n”: a fourth log transaction. A read of t1 answers “plan” at once, from memory.',
  'The window closes: t1 lands once, as one write set, one readwrite transaction over the stores it touches. The log is told those four positions landed.',
  'Four awaited keystrokes cost four log transactions and one record transaction. With defer: 0 they would cost eight, a write set per write.',
];

const LETTERS = ['p', 'l', 'a', 'n'];
// The step each keystroke is made at.
const TYPED_AT = [1, 2, 2, 3];
const typed = (step: number) => {
  let text = '';
  for (let i = 0; i < LETTERS.length; i++) if (step >= TYPED_AT[i]) text += LETTERS[i];
  return text;
};
const landed = (step: number) => step >= 4;
const logCount = (step: number) => typed(step).length;
const writeSets = (step: number) => (landed(step) ? 1 : 0);
// The window on a line of time: it opens at the first write and closes 16 ms later.
const xOf = (ms: number) => 250 + 12 * ms;
const KEY_MS = [0, 4, 8, 12];
// The log transactions on their way, at the step they are made.
const LOG_TXNS = [
  { step: 1, x: 355, label: "op 'p'" },
  { step: 2, x: 320, label: "op 'l'" },
  { step: 2, x: 390, label: "op 'a'" },
  { step: 3, x: 355, label: "op 'n'" },
];
</script>

<template>
  <SyncFigure
    caption="Awaited keystrokes cost a log transaction each, and their record lands once per defer window"
    :steps="steps"
    :key-step="4"
  >
    <template #default="{ step }">
      <text class="f-text f-mono" x="20" y="22">for (const ch of 'plan') await db.push(id, 'notes', ch);</text>

      <!-- the tab -->
      <rect class="f-card" x="20" y="40" width="200" height="150" rx="10" />
      <text class="f-muted" x="34" y="62">the notes of t1</text>
      <rect class="f-cell" x="34" y="70" width="172" height="30" rx="6" />
      <text class="f-text f-mono" x="46" y="90">{{ typed(step) }}</text>
      <g :class="{ 'f-hidden': step < 1 }">
        <text class="f-muted" x="34" y="132">a read of t1 sees</text>
        <text :class="['f-text', 'f-mono', { 'f-changed': step >= 1 && step <= 3 }]" x="132" y="132">'{{ typed(step) }}'</text>
      </g>
      <text :class="['f-muted', { 'f-hidden': step < 1 || landed(step) }]" x="34" y="164">t1 waits in memory,</text>
      <text :class="['f-muted', { 'f-hidden': step < 1 || landed(step) }]" x="34" y="178">in its slot of the window</text>

      <!-- the two lanes into IndexedDB -->
      <line class="f-link" x1="220" y1="78" x2="490" y2="78" />
      <line class="f-link" x1="220" y1="128" x2="490" y2="128" />
      <g
        v-for="t in LOG_TXNS"
        :key="t.label"
        :class="{ 'f-hidden': step !== t.step }"
        :style="{ transform: `translate(${step >= t.step ? t.x : t.x - 40}px, 78px)` }"
      >
        <rect class="f-peer-a" x="-28" y="-10" width="56" height="20" rx="10" />
        <text class="f-packet-text" x="0" y="0">{{ t.label }}</text>
      </g>
      <g :class="{ 'f-hidden': step !== 4 }" :style="{ transform: `translate(${step >= 4 ? 355 : 315}px, 128px)` }">
        <rect class="f-peer-a" x="-52" y="-10" width="104" height="20" rx="10" />
        <text class="f-packet-text" x="0" y="0">write set: t1</text>
      </g>

      <!-- the defer window -->
      <text class="f-muted" :x="xOf(0)" y="182">{{ step < 1 ? 'the defer window: none open' : 'the defer window' }}</text>
      <rect :class="[landed(step) ? 'f-ok' : 'f-cell', { 'f-hidden': step < 1 }]" :x="xOf(0)" y="192" :width="xOf(16) - xOf(0)" height="14" rx="7" />
      <g v-for="(letter, i) in LETTERS" :key="i" :class="{ 'f-hidden': step < TYPED_AT[i] }">
        <rect class="f-peer-a" :x="xOf(KEY_MS[i]) - 8" y="191" width="16" height="16" rx="4" />
        <text class="f-packet-text" :x="xOf(KEY_MS[i])" y="199">{{ letter }}</text>
      </g>
      <text :class="['f-muted', { 'f-hidden': step < 1 }]" :x="xOf(0)" y="226">first write</text>
      <text :class="['f-muted', { 'f-hidden': step < 1, 'f-changed': step === 4 }]" :x="xOf(16)" y="226" text-anchor="end">
        16 ms later: lands
      </text>

      <!-- IndexedDB -->
      <rect class="f-card" x="490" y="40" width="210" height="216" rx="10" />
      <text class="f-label" x="595" y="60">IndexedDB</text>
      <text class="f-muted" x="504" y="83">log</text>
      <g v-for="(letter, i) in LETTERS" :key="i" :class="{ 'f-hidden': step < TYPED_AT[i] }">
        <rect class="f-peer-a" :x="536 + i * 24" y="70" width="18" height="18" rx="3" />
        <text class="f-packet-text" :x="545 + i * 24" y="79">{{ letter }}</text>
      </g>
      <text class="f-muted" x="504" y="133">records</text>
      <rect :class="landed(step) ? 'f-card f-stroke-a' : 'f-cell'" x="552" y="115" width="138" height="26" rx="5" />
      <text :class="['f-text', 'f-mono', { 'f-changed': step === 4 }]" x="562" y="133">
        t1 · notes '{{ landed(step) ? 'plan' : '' }}'
      </text>
      <text class="f-muted" x="504" y="170">kv · pieces · copies</text>
      <text class="f-muted" x="504" y="204">readwrite transactions</text>
      <text :class="['f-text', { 'f-changed': step >= 1 && step <= 3 }]" x="504" y="226">over the log store: {{ logCount(step) }}</text>
      <text :class="['f-text', { 'f-changed': step === 4 }]" x="504" y="246">write sets: {{ writeSets(step) }}</text>

      <!-- the cost -->
      <g :class="{ 'f-hidden': step !== 5 }">
        <rect class="f-ok" x="230" y="268" width="260" height="22" rx="11" />
        <text class="f-packet-text" x="360" y="279">4 log transactions + 1 write set</text>
      </g>
    </template>
  </SyncFigure>
</template>
