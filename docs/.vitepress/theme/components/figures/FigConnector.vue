<script setup lang="ts">
// A connector between a collection and a backend that is not syncom: a pull of the documents changed since
// the checkpoint lands as this node's own writes and moves the checkpoint; a local edit is pushed as a row
// with the state the backend was assumed to hold; the backend refuses it with its own state, a conflict the
// backend wins unless `resolve` decides.
// Depicts: src/connector/connector.js (pull pages from the checkpoint landed as one transaction, the
// checkpoint `{ pull, pushed }` in the connector kv namespace, rows with `assumed`, a conflict resolved for the
// backend under the `:resolve` source, the pushed frontier).
import SyncFigure from './SyncFigure.vue';

const steps = [
  'replicate(db, { name, collection, pull, push }) keeps the Task collection in step with your backend. The checkpoint lives in the connector kv namespace.',
  'Pull: pull.handler(checkpoint) answers the documents changed since position 41, a page at a time, with the position after them. The backend never sees an op.',
  'The page lands as one transaction of this node’s own writes, so t3 reaches your peers like a local write. Only then does the checkpoint move to 42.',
  'You edit t1. The connector hears the transaction and pushes a row: the record as it reads now, and assumed, the backend’s state as this node last knew it.',
  'Someone changed t1 on the backend meanwhile. It refuses the row and answers t1 as it holds it: a conflict.',
  'The backend wins: t1 is set to its state, unless your resolve function decides otherwise. Nothing is left to push, and pushed moves past those turns.',
];

const LEFT = 20;
const RIGHT = 490;
const local = (step: number) => [
  { id: 't1', title: step >= 5 ? 'Docs for v2' : step >= 3 ? 'Write the guide' : 'Write docs', changed: step === 3 || step === 5 },
  { id: 't2', title: 'Fix login', changed: false, shown: true },
  { id: 't3', title: 'Plan sprint', changed: step === 2, shown: step >= 2 },
];
const remote = (step: number) => [
  { id: 't1', title: step >= 4 ? 'Docs for v2' : 'Write docs', changed: step === 4 },
  { id: 't2', title: 'Fix login', changed: false },
  { id: 't3', title: 'Plan sprint', changed: false },
];
// The messages between the two: each is drawn at its destination on its step, hidden elsewhere.
const MESSAGES = [
  { step: 1, from: 430, to: 290, label: 'page: t3, at 42', cls: 'f-peer-b' },
  { step: 3, from: 290, to: 430, label: 'row t1, assumed', cls: 'f-peer-a' },
  { step: 4, from: 430, to: 290, label: 'conflict: t1', cls: 'f-peer-b' },
];
</script>

<template>
  <SyncFigure
    caption="A connector pulls pages from its checkpoint, pushes local edits, and lets the backend win a conflict"
    :steps="steps"
    :key-step="4"
  >
    <template #default="{ step, grad }">
      <text class="f-text f-mono" x="360" y="34" text-anchor="middle">replicate(db, { name, collection, pull, push })</text>

      <circle class="f-node" cx="56" cy="58" r="28" :fill="grad" />
      <text class="f-node-text" x="56" y="58">laptop</text>
      <text class="f-muted" :x="RIGHT + 210" y="62" text-anchor="end">a CouchDB, a Postgres, a drive…</text>

      <!-- the collection -->
      <rect class="f-card" :x="LEFT" y="100" width="210" height="108" rx="10" />
      <text class="f-muted" :x="LEFT + 14" y="121">the Task collection</text>
      <g v-for="(row, i) in local(step)" :key="row.id" :class="{ 'f-hidden': row.shown === false }">
        <text class="f-muted f-mono" :x="LEFT + 14" :y="146 + i * 24">{{ row.id }}</text>
        <text :class="['f-text', { 'f-changed': row.changed }]" :x="LEFT + 40" :y="146 + i * 24">{{ row.title }}</text>
      </g>

      <!-- the backend -->
      <rect class="f-card" :x="RIGHT" y="100" width="210" height="108" rx="10" />
      <text class="f-muted" :x="RIGHT + 14" y="121">your backend</text>
      <g v-for="(row, i) in remote(step)" :key="row.id">
        <text class="f-muted f-mono" :x="RIGHT + 14" :y="146 + i * 24">{{ row.id }}</text>
        <text :class="['f-text', { 'f-changed': row.changed }]" :x="RIGHT + 40" :y="146 + i * 24">{{ row.title }}</text>
      </g>

      <!-- the connector between -->
      <line class="f-link" x1="234" y1="154" x2="486" y2="154" />
      <g
        v-for="m in MESSAGES"
        :key="m.label"
        :class="{ 'f-hidden': step !== m.step }"
        :style="{ transform: `translate(${step >= m.step ? m.to : m.from}px, 154px)` }"
      >
        <rect :class="m.cls" x="-58" y="-10" width="116" height="20" rx="10" />
        <text class="f-packet-text" x="0" y="0">{{ m.label }}</text>
      </g>

      <!-- the checkpoint -->
      <rect class="f-card" x="285" y="200" width="150" height="72" rx="10" />
      <text class="f-muted" x="299" y="220">checkpoint</text>
      <text class="f-muted" x="299" y="242">pull</text>
      <text :class="['f-text', 'f-mono', { 'f-changed': step === 2 }]" x="352" y="242">{{ step >= 2 ? 42 : 41 }}</text>
      <text class="f-muted" x="299" y="262">pushed</text>
      <text :class="['f-text', 'f-mono', { 'f-changed': step === 5 }]" x="352" y="262">{{ step >= 5 ? '1.15' : '1.12' }}</text>
    </template>
  </SyncFigure>
</template>
