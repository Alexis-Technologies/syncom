<script setup lang="ts">
// A pipeline: each turn's records of the source collection go to the handler, which writes the derived
// records through one transaction; the checkpoint (the turn's event id) moves only after that transaction
// landed. A crash between the two hands the turn over again from the log, and a handler that throws stops
// the pipeline before its turn: at least once, in order, never skipped.
// Depicts: src/pipeline/pipeline.js (the transaction events followed, one db.transact per batch, the
// checkpoint in the pipeline kv namespace after the landing, the replay from log.since(checkpoint), the halt
// and PIPELINE_FAILED).
import SyncFigure from './SyncFigure.vue';

const steps = [
  'createPipeline(db, { name, source: ‘Task’, handler }) follows the database’s turns. Its checkpoint, kept in the pipeline kv namespace, is the last turn it finished: e4.',
  'You close two tasks in one turn, e5. The handler gets the batch, their ids and changes, and writes the Activity records through tx, in one transaction.',
  'The handler’s transaction lands, and only then does the checkpoint move to e5.',
  'Turn e6: the handler’s transaction lands, but the process stops before the checkpoint is written. It still says e5.',
  'On the next start the pipeline replays the log since e5: e6 is handed over again, ids only, then the checkpoint moves. Derive by id and the rerun changes nothing.',
  'A handler that throws stops the pipeline before its turn: the checkpoint stays, the error event carries PIPELINE_FAILED, and start() hands the turn over again.',
];

const TURNS = [
  { name: 'e4', label: 'e4', from: 0 },
  { name: 'e5', label: 'e5 · 2 tasks', from: 1 },
  { name: 'e6', label: 'e6 · 1 task', from: 3 },
  { name: 'e7', label: 'e7 · 1 task', from: 5 },
];
const turnX = (i: number) => 90 + i * 110;
const checkpoint = (step: number) => (step >= 4 ? 2 : step >= 2 ? 1 : 0);
const SOURCE = [
  { id: 't1', from: 1 },
  { id: 't2', from: 1 },
  { id: 't3', from: 3 },
  { id: 't4', from: 5 },
];
const DERIVED = [
  { id: 'done.t1', from: 2 },
  { id: 'done.t2', from: 2 },
  { id: 'done.t3', from: 3 },
];
const LANE = 108;
const BATCHES = [
  { label: 'batch e5', shown: [1, 2], at: (s: number) => (s <= 0 ? [110, LANE] : s === 1 ? [360, LANE] : [610, LANE]) },
  { label: 'batch e6', shown: [3], at: (s: number) => (s < 3 ? [110, LANE] : [610, LANE]) },
  { label: 'replay e6', shown: [4], at: (s: number) => (s < 4 ? [turnX(2) + 50, 48] : [610, LANE]) },
  { label: 'batch e7', shown: [5], at: (s: number) => (s < 5 ? [110, LANE] : [360, LANE]) },
];
const status = (step: number) =>
  step === 3 ? 'the process stops before the checkpoint is written' : step === 5 ? 'PIPELINE_FAILED' : '';
</script>

<template>
  <SyncFigure caption="A pipeline hands each turn to its handler and moves the checkpoint only after the handler's write landed" :steps="steps" :key-step="3">
    <template #default="{ step }">
      <!-- the log and the checkpoint -->
      <text class="f-muted" x="20" y="52">the log</text>
      <g v-for="(t, i) in TURNS" :key="t.name" :class="{ 'f-hidden': step < t.from }">
        <rect class="f-cell" :x="turnX(i)" y="34" width="100" height="28" rx="6" />
        <text class="f-text f-mono" :x="turnX(i) + 50" y="52" text-anchor="middle">{{ t.label }}</text>
      </g>
      <g :style="{ transform: `translate(${turnX(checkpoint(step)) + 50}px, 77px)` }">
        <rect class="f-peer-b" x="-42" y="-9" width="84" height="18" rx="9" />
        <text class="f-packet-text" x="0" y="0">checkpoint</text>
      </g>

      <!-- the source, the handler, the destination -->
      <rect class="f-card" x="20" y="124" width="180" height="112" rx="10" />
      <text class="f-muted" x="34" y="145">source: Task</text>
      <g v-for="(r, i) in SOURCE" :key="r.id" :class="{ 'f-hidden': step < r.from }">
        <text class="f-text f-mono" x="34" :y="167 + i * 19">{{ r.id }}</text>
        <text class="f-muted" x="62" :y="167 + i * 19">done: true</text>
      </g>

      <rect class="f-card" x="270" y="146" width="180" height="62" rx="10" />
      <text class="f-text f-mono" x="360" y="172" text-anchor="middle">handler(batch, tx)</text>
      <text :class="['f-changed', 'f-text', { 'f-hidden': step !== 5 }]" x="360" y="194" text-anchor="middle">throws</text>

      <rect class="f-card" x="520" y="124" width="180" height="112" rx="10" />
      <text class="f-muted" x="534" y="145">Activity</text>
      <g v-for="(r, i) in DERIVED" :key="r.id" :class="{ 'f-hidden': step < r.from }">
        <text :class="['f-text', 'f-mono', { 'f-changed': step === r.from || (step === 4 && r.id === 'done.t3') }]" x="534" :y="167 + i * 19">
          {{ r.id }}
        </text>
      </g>
      <line class="f-link" x1="204" y1="177" x2="266" y2="177" />
      <line class="f-link" x1="454" y1="177" x2="516" y2="177" />

      <!-- the batches -->
      <g
        v-for="b in BATCHES"
        :key="b.label"
        :class="{ 'f-hidden': !b.shown.includes(step) }"
        :style="{ transform: `translate(${b.at(step)[0]}px, ${b.at(step)[1]}px)` }"
      >
        <rect class="f-peer-a" x="-40" y="-10" width="80" height="20" rx="10" />
        <text class="f-packet-text" x="0" y="0">{{ b.label }}</text>
      </g>

      <text :class="['f-changed', 'f-text', { 'f-hidden': status(step) === '' }]" x="360" y="266" text-anchor="middle">
        {{ status(step) || 'PIPELINE_FAILED' }}
      </text>
    </template>
  </SyncFigure>
</template>
