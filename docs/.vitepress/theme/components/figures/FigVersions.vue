<script setup lang="ts">
// A version is a cut through the retained log: the record's entries up to an event id (or a stamp, or a
// vector) folded back with applyOp. A tag names the whole database at a position and keeps a record's file
// copy-on-write, so it survives retention; a cut that needs entries retention dropped is HISTORY_GONE.
// Depicts: src/versions/history.js (the cut, the exact start above droppedTs, the fold, `gone`),
// src/versions/api.js (get(id, { at }), the tag's copy read instead of the log), src/versions/tags.js (a
// record's file copied into the newest tag before its first change).
import SyncFigure from './SyncFigure.vue';

const steps = [
  'Every write to a record is an entry in this node’s log. The record file holds the present; the past is the log, folded back.',
  'Read the record at the event id of e2: get(id, { at }) folds its entries up to e2 with the applyOp that built them. A stamp or a vector cuts the same way.',
  'tag(‘v1’) names the whole database at e3. Nothing is copied when it is taken: a record that never changes again is its own copy.',
  'You write on. Before the record’s first change after the tag, its file is copied into the tag, and at(‘v1’) reads that copy, not the log.',
  'Retention drops e1 and e2. A version is exact only from a whole-record write newer than what was dropped: at e5 the fold starts at the set() of e4.',
  'At e3 no such write is inside the cut, so get(id, { at }) rejects with HISTORY_GONE, reason compacted. The tag still reads its copy.',
];

const ENTRIES = [
  { name: 'e1', op: 'insert', change: 'Draft · false' },
  { name: 'e2', op: 'update', change: 'title Review' },
  { name: 'e3', op: 'update', change: 'done true' },
  { name: 'e4', op: 'set', change: 'Ship · false' },
  { name: 'e5', op: 'update', change: 'done true' },
];
const cellX = (i: number) => 110 + i * 100;
const logged = (i: number, step: number) => (i < 3 || step >= 3) && !(i < 2 && step >= 4);
// After which entry the cut falls, and which entries the fold runs over.
const cutAfter = (step: number) => (step === 4 ? 4 : step === 5 ? 2 : 1);
const cutShown = (step: number) => step === 1 || step >= 4;
const foldFrom = (step: number) => (step === 4 ? 3 : 0);
const foldShown = (step: number) => step === 1 || step === 4;

const present = (step: number) => (step >= 3 ? { title: 'Ship', done: 'true' } : { title: 'Review', done: 'true' });
const atVersion = (step: number) => {
  if (step === 4) return { title: 'Ship', done: 'true', note: 'folded from e4' };
  return { title: 'Review', done: 'false', note: 'folded from e1' };
};
const resultShown = (step: number) => step === 1 || step >= 4;
</script>

<template>
  <SyncFigure
    caption="A version is the record's entries folded up to a cut; a tag keeps copies; a cut past retention is gone"
    :steps="steps"
    :key-step="4"
  >
    <template #default="{ step, grad }">
      <circle class="f-node" cx="52" cy="68" r="28" :fill="grad" />
      <text class="f-node-text" x="52" y="68">laptop</text>
      <text class="f-muted" x="110" y="24">the record’s entries in the laptop’s log</text>

      <!-- the entries -->
      <g v-for="(e, i) in ENTRIES" :key="e.name" :class="{ 'f-hidden': !logged(i, step) }">
        <rect class="f-cell" :x="cellX(i)" y="52" width="92" height="46" rx="6" />
        <text class="f-text f-mono" :x="cellX(i) + 10" y="71">{{ e.name }} {{ e.op }}</text>
        <text class="f-muted" :x="cellX(i) + 10" y="89">{{ e.change }}</text>
      </g>
      <text :class="['f-muted', { 'f-hidden': step < 4 }]" x="206" y="79" text-anchor="middle">dropped by retention</text>

      <!-- the cut -->
      <g :class="{ 'f-hidden': !cutShown(step) }" :style="{ transform: `translate(${cellX(cutAfter(step)) + 96}px, 0px)` }">
        <line class="f-link f-stroke-a" x1="0" y1="46" x2="0" y2="104" />
        <rect class="f-peer-a" x="-18" y="29" width="36" height="18" rx="9" />
        <text class="f-packet-text" x="0" y="38">cut</text>
      </g>

      <!-- what the fold runs over -->
      <g :class="{ 'f-hidden': !foldShown(step) }">
        <line
          class="f-link f-stroke-a"
          :x1="cellX(foldFrom(step)) + 4"
          y1="108"
          :x2="cellX(foldFrom(step) + 1) + 88"
          y2="108"
        />
        <text class="f-muted" :x="cellX(foldFrom(step)) + 96" y="124" text-anchor="middle">folded with applyOp</text>
      </g>

      <!-- the tag -->
      <g :class="{ 'f-hidden': step < 2 }">
        <rect class="f-peer-b" x="326" y="106" width="60" height="18" rx="9" />
        <text class="f-packet-text" x="356" y="115">tag v1</text>
      </g>

      <!-- the record file -->
      <text class="f-muted" x="110" y="156">the record file</text>
      <rect class="f-card" x="110" y="164" width="180" height="84" rx="10" />
      <text class="f-muted" x="124" y="190">title</text>
      <text :class="['f-text', { 'f-changed': step === 3 }]" x="164" y="190">{{ present(step).title }}</text>
      <text class="f-muted" x="124" y="214">done</text>
      <text class="f-text f-mono" x="164" y="214">{{ present(step).done }}</text>

      <!-- the version read -->
      <g :class="{ 'f-hidden': !resultShown(step) }">
        <text class="f-muted" x="310" y="156">get(id, { at })</text>
        <rect class="f-card" x="310" y="164" width="180" height="84" rx="10" />
        <g :class="{ 'f-hidden': step === 5 }">
          <text class="f-muted" x="324" y="190">title</text>
          <text class="f-text" x="364" y="190">{{ atVersion(step).title }}</text>
          <text class="f-muted" x="324" y="214">done</text>
          <text class="f-text f-mono" x="364" y="214">{{ atVersion(step).done }}</text>
          <text class="f-muted" x="324" y="236">{{ atVersion(step).note }}</text>
        </g>
        <g :class="{ 'f-hidden': step !== 5 }">
          <text class="f-changed f-text f-mono" x="400" y="202" text-anchor="middle">HISTORY_GONE</text>
          <text class="f-muted" x="400" y="222" text-anchor="middle">reason: compacted</text>
        </g>
      </g>

      <!-- the tag's copies -->
      <g :class="{ 'f-hidden': step < 2 }">
        <text class="f-muted" x="510" y="156">the tag v1, at e3</text>
        <rect class="f-card" x="510" y="164" width="180" height="84" rx="10" />
        <text :class="['f-muted', { 'f-hidden': step >= 3 }]" x="600" y="210" text-anchor="middle">no copies yet</text>
      </g>
      <g
        :class="{ 'f-hidden': step < 3 }"
        :style="{ transform: `translate(${step >= 3 ? 522 : 122}px, 174px)` }"
      >
        <rect class="f-cell" x="0" y="0" width="156" height="62" rx="8" />
        <text class="f-muted" x="10" y="18">title</text>
        <text class="f-text" x="50" y="18">Review</text>
        <text class="f-muted" x="10" y="36">done</text>
        <text class="f-text f-mono" x="50" y="36">true</text>
        <text class="f-muted" x="10" y="54">the file as it was</text>
      </g>
    </template>
  </SyncFigure>
</template>
