<script setup lang="ts">
// A query laid against a compound index: the equality on boardId is the scan's prefix, the range on rank
// bounds the next field, the order is the index's own so the rows come sorted and the window is read and
// no further; explain() reports that plan, and indexAdvisor() turns a query no index served into the index
// it asked for.
// Depicts: src/query/plan.js (the longest prefix of equalities, then a range or the sort, sortedByIndex,
// residual, the estimate), src/catalog.js (`scan`: two seeks into the sorted index, the entries between
// them), src/sorted.js (the sorted (keys, id) index), src/inspect/inspect.js (indexAdvisor: equalities,
// a range field, then the sort).
import SyncFigure from './SyncFigure.vue';

const steps = [
  "You ask for board b1’s tasks ranked 10 or more, in rank order, four at most. Task declares two indexes: ['done'] and the compound ['boardId', 'rank'].",
  "The planner fits each index field by field from the left. ['done'] serves nothing here. ['boardId', 'rank'] takes the equality on boardId as its prefix: b1.",
  'The next field, rank, takes the range. Two binary searches find the scan’s edges in the sorted index: b1 from rank 10 on, two entries, the estimate.',
  'The order is rank, the index’s next field, in one direction, so the rows come out sorted. The cursor reads the window, at most four rows, and stops.',
  'explain() shows this plan without running it. residual: false says the index decided every condition: nothing is left to test on the records it yields.',
  "A query no index serves, owner 'ada' by rank, reads the whole collection. indexAdvisor() notes its plan and suggests ['owner', 'rank']: the equality, then the sort.",
];

// The query's conditions, and the step at which the planner uses each.
const CONDITIONS = [
  { text: "boardId: 'b1'", role: 'equality', at: 1 },
  { text: 'rank: { $gte: 10 }', role: 'range', at: 2 },
  { text: ".order('rank')", role: 'sort', at: 3 },
  { text: '.limit(4)', role: 'window', at: 3 },
];
// A slice of the sorted index: (boardId, rank) in order; rows 3 to 7 are b1, rows 6 and 7 rank 10 or more.
const ENTRIES = ['…', 'b0  12', 'b0  16', 'b1  1', 'b1  5', 'b1  9', 'b1  13', 'b1  17', 'b2  2', 'b2  6', '…'];
const COL = 262;
const rowY = (i: number) => 48 + i * 22;
const read = (i: number, step: number) => step >= 3 && (i === 6 || i === 7);
// The plan's fields as explain() reports them, each from the step the planner decides it.
const PLAN = [
  { key: 'scan', value: "'index'", at: 1 },
  { key: 'index', value: "['boardId', 'rank']", at: 1 },
  { key: 'prefix', value: "['b1']", at: 1 },
  { key: 'range', value: 'rank ≥ 10', at: 2 },
  { key: 'sortedByIndex', value: 'true', at: 3 },
  { key: 'residual', value: 'false', at: 4 },
  { key: 'estimate', value: '2', at: 2 },
];
</script>

<template>
  <SyncFigure
    caption="The planner lays a query against a sorted index: the equality as the prefix, then the range, then the sort"
    :steps="steps"
    :key-step="4"
  >
    <template #default="{ step }">
      <!-- the query -->
      <rect class="f-card" x="20" y="20" width="210" height="128" rx="10" />
      <text class="f-muted" x="34" y="40">db.Task.select(…)</text>
      <g v-for="(c, i) in CONDITIONS" :key="c.text">
        <text :class="['f-text', 'f-mono', { 'f-changed': step === c.at }]" x="34" :y="64 + i * 22">{{ c.text }}</text>
        <text :class="['f-muted', { 'f-hidden': step < c.at }]" x="220" :y="64 + i * 22" text-anchor="end">{{ c.role }}</text>
      </g>
      <text :class="['f-muted', { 'f-hidden': step < 1 }]" x="34" y="168">['done'] cannot serve it</text>

      <!-- the sorted index -->
      <text class="f-muted" :x="COL + 42" y="22" text-anchor="middle">sorted index</text>
      <text class="f-text f-mono" :x="COL + 42" y="38" text-anchor="middle">boardId, rank</text>
      <g v-for="(entry, i) in ENTRIES" :key="i">
        <rect :class="read(i, step) ? 'f-peer-a' : 'f-cell'" :x="COL" :y="rowY(i)" width="84" height="18" rx="4" />
        <text
          :class="read(i, step) ? 'f-packet-text' : ['f-text', 'f-mono']"
          :x="COL + 42"
          :y="read(i, step) ? rowY(i) + 9 : rowY(i) + 13"
          :text-anchor="read(i, step) ? undefined : 'middle'"
        >
          {{ entry }}
        </text>
      </g>
      <!-- the prefix: every entry of b1 -->
      <g :class="{ 'f-hidden': step < 1 }">
        <path class="f-link" :d="`M ${COL - 4} ${rowY(3)} H ${COL - 10} V ${rowY(7) + 18} H ${COL - 4}`" />
        <text class="f-muted" :x="COL - 16" :y="rowY(5) + 13" text-anchor="end">prefix ['b1']</text>
      </g>
      <!-- the range: the scan's two edges -->
      <g :class="{ 'f-hidden': step < 2 }">
        <line class="f-link" :x1="COL" :y1="rowY(6) - 2" :x2="COL + 84" :y2="rowY(6) - 2" />
        <line class="f-link" :x1="COL" :y1="rowY(8) - 2" :x2="COL + 84" :y2="rowY(8) - 2" />
        <path class="f-link" :d="`M ${COL + 88} ${rowY(6)} H ${COL + 94} V ${rowY(7) + 18} H ${COL + 88}`" />
        <text class="f-muted" :x="COL + 100" :y="rowY(7) + 2">rank ≥ 10</text>
      </g>
      <text :class="['f-muted', { 'f-hidden': step < 3 }]" :x="COL + 100" :y="rowY(8) + 18">read in order, then stop</text>

      <!-- the plan -->
      <rect class="f-card" x="432" y="20" width="272" height="196" rx="10" />
      <text :class="['f-text', 'f-mono', { 'f-changed': step === 4 }]" x="446" y="42">explain()</text>
      <g v-for="(field, i) in PLAN" :key="field.key">
        <text class="f-muted" x="446" :y="70 + i * 22">{{ field.key }}</text>
        <text
          :class="['f-text', 'f-mono', { 'f-hidden': step < field.at, 'f-changed': step === field.at }]"
          x="546"
          :y="70 + i * 22"
        >
          {{ field.value }}
        </text>
      </g>

      <!-- a query no index serves -->
      <g :class="{ 'f-hidden': step < 5 }">
        <rect class="f-card" x="20" y="196" width="210" height="94" rx="10" />
        <text class="f-text f-mono" x="34" y="216">indexAdvisor(db)</text>
        <text class="f-muted f-mono" x="34" y="238">{ owner: 'ada' } by rank</text>
        <text class="f-muted" x="34" y="256">scanned the whole collection</text>
        <text class="f-muted" x="34" y="278">suggests</text>
        <text class="f-text f-mono f-changed" x="86" y="278">['owner', 'rank']</text>
      </g>
    </template>
  </SyncFigure>
</template>
