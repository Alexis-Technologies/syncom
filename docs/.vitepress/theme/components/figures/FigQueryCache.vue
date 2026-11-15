<script setup lang="ts">
// Two watch() calls of one query share one live run: a write is read once and placed once for both, a
// fetch() of the same query takes the run's rows and reads nothing, and when the listeners stop the rows stay
// as an idle result, valid until the collection's generation moves — a write to another collection leaves it
// valid, a write to its own makes it stale and the next fetch() runs again.
// Depicts: src/query/cache.js (keyOf, the one live run per key, rows(key, generation), keep, release: the last
// rows kept idle), src/query/cursor.js (fetch through the cache, watch through cache.live, the run's rows and
// generation), src/query/live.js (the changed record read once, matched and placed).
import SyncFigure from './SyncFigure.vue';

const steps = [
  'The header and the list watch the open tasks of board b1. The same query with its keys in another order is one key, so the two watch() calls share one live run.',
  'You add “Ship it”. The run reads that one record, matches it, places it, and hands the same rows to both listeners. The query does not run again.',
  'A click calls fetch() for the same query. The run’s rows are the result as of Task’s generation 8, so it gets copies of them and reads nothing.',
  'Both listeners stop. The run ends, and its last rows stay in the cache as an idle result, read at generation 8.',
  'You insert a Tag. Only Tag’s generation moves, so another fetch() of the task query is still answered from the cache.',
  'You rename a task: Task’s generation moves to 9. The kept result is stale, so the next fetch() runs the query and keeps what it reads.',
];

const watching = (step: number) => step <= 2;
const taskGen = (step: number) => (step >= 5 ? 9 : step >= 1 ? 8 : 7);
const tagGen = (step: number) => (step >= 4 ? 4 : 3);
const fetched = (step: number) => ['', '', '2 rows, none read', '', '2 rows, from the cache', 'runs the query again'][step];
const entryState = (step: number) =>
  step <= 2 ? 'the live run’s rows' : step <= 4 ? 'idle · 2 rows · read at gen 8' : 'stale, read again at gen 9';
</script>

<template>
  <SyncFigure
    caption="Every watch() of one query shares one live run, and its rows answer fetch() until the collection changes"
    :steps="steps"
    :key-step="2"
  >
    <template #default="{ step, grad }">
      <!-- the two watchers -->
      <rect class="f-card" x="20" y="20" width="180" height="56" rx="10" />
      <text class="f-muted" x="34" y="40">header · watch()</text>
      <text :class="['f-muted', { 'f-hidden': watching(step) }]" x="190" y="40" text-anchor="end">stopped</text>
      <text :class="['f-text', { 'f-changed': step === 1 }]" x="34" y="62">open tasks: {{ step >= 1 ? 2 : 1 }}</text>

      <rect class="f-card" x="20" y="92" width="180" height="78" rx="10" />
      <text class="f-muted" x="34" y="112">list · watch()</text>
      <text :class="['f-muted', { 'f-hidden': watching(step) }]" x="190" y="112" text-anchor="end">stopped</text>
      <text class="f-text" x="34" y="134">Write the docs</text>
      <text :class="['f-text', { 'f-hidden': step < 1, 'f-changed': step === 1 }]" x="34" y="156">Ship it</text>

      <!-- a fetch -->
      <g :class="{ 'f-hidden': step < 2 }">
        <rect class="f-card" x="20" y="186" width="180" height="56" rx="10" />
        <text class="f-muted" x="34" y="206">a click · fetch()</text>
        <text :class="['f-text', { 'f-changed': fetched(step) !== '' }]" x="34" y="228">{{ fetched(step) }}</text>
        <line class="f-link" x1="200" y1="214" x2="230" y2="214" />
      </g>

      <!-- the one live run -->
      <line :class="['f-link', { 'f-link-off': !watching(step) }]" x1="200" y1="48" x2="274" y2="84" />
      <line :class="['f-link', { 'f-link-off': !watching(step) }]" x1="200" y1="131" x2="274" y2="108" />
      <line :class="['f-link', { 'f-link-off': !watching(step) }]" x1="328" y1="96" x2="500" y2="96" />
      <line :class="['f-link', { 'f-link-off': !watching(step) }]" x1="300" y1="124" x2="300" y2="218" />
      <text class="f-muted" x="300" y="52" text-anchor="middle">one key: Task, b1, open</text>
      <g :class="{ 'f-hidden': !watching(step) }">
        <circle class="f-node" cx="300" cy="96" r="28" :fill="grad" />
        <text class="f-node-text" x="300" y="96">run</text>
        <text class="f-muted" x="336" y="120">one Live, shared</text>
      </g>
      <g :class="{ 'f-hidden': watching(step) }">
        <circle class="f-link f-link-off" cx="300" cy="96" r="28" />
        <text class="f-muted" x="300" y="100" text-anchor="middle">ended</text>
      </g>

      <!-- the record the run reads, once -->
      <g :class="{ 'f-hidden': step !== 1 }" transform="translate(414 96)">
        <rect class="f-peer-a" x="-46" y="-10" width="92" height="20" rx="10" />
        <text class="f-packet-text" x="0" y="0">t3, read once</text>
      </g>

      <!-- the cache -->
      <rect class="f-card" x="230" y="186" width="240" height="100" rx="10" />
      <text class="f-muted" x="244" y="206">the query cache</text>
      <rect class="f-cell" x="244" y="218" width="212" height="56" rx="6" />
      <text class="f-text f-mono" x="256" y="240">Task · b1 · open</text>
      <text :class="['f-muted', { 'f-changed': step === 3 || step === 5 }]" x="256" y="262">{{ entryState(step) }}</text>

      <!-- the collections -->
      <rect class="f-card" x="500" y="20" width="200" height="124" rx="10" />
      <text class="f-muted" x="514" y="40">Task</text>
      <text :class="['f-text', 'f-mono', { 'f-changed': step === 1 || step === 5 }]" x="690" y="40" text-anchor="end">
        gen {{ taskGen(step) }}
      </text>
      <text class="f-muted f-mono" x="514" y="68">t1</text>
      <text :class="['f-text', { 'f-changed': step === 5 }]" x="538" y="68">{{ step >= 5 ? 'Write the guide' : 'Write the docs' }}</text>
      <text class="f-muted f-mono" x="514" y="92">t2</text>
      <text class="f-text" x="538" y="92">Set up the repo</text>
      <text class="f-muted" x="690" y="92" text-anchor="end">done</text>
      <g :class="{ 'f-hidden': step < 1 }">
        <text class="f-muted f-mono" x="514" y="116">t3</text>
        <text class="f-text" x="538" y="116">Ship it</text>
      </g>

      <rect class="f-card" x="500" y="160" width="200" height="56" rx="10" />
      <text class="f-muted" x="514" y="180">Tag</text>
      <text :class="['f-text', 'f-mono', { 'f-changed': step === 4 }]" x="690" y="180" text-anchor="end">gen {{ tagGen(step) }}</text>
      <text :class="['f-text', { 'f-hidden': step < 4 }]" x="538" y="204">docs</text>
    </template>
  </SyncFigure>
</template>
