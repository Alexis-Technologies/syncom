<script setup lang="ts">
// How a stamp is made and compared: a node stamps with max(Date.now(), last + 1), so its stamps never
// repeat or run back; it observes every peer stamp it applies, so a write after a read is stamped
// above what it read even on a slow clock; two writes are ordered by the pair [ts, origin], the node id
// breaking a tie; and a stamp beyond maxSkew ahead of the receiver is refused (SKEW), never observed.
// Depicts: src/vector.js (Clock, compareClock), src/commit.js (prepareOp: observe, then now),
// src/apply.js (admit: skewed; applyOne: clock.observe), src/options.js (maxSkew, 24 h by default).
import SyncFigure from './SyncFigure.vue';

const steps = [
  "The laptop's wall clock reads 5000 ms. You write: the stamp is max(Date.now(), last + 1) = 5000, and the op carries the pair [5000, laptop].",
  'You write again within the same millisecond. Date.now() still reads 5000, so the stamp is last + 1 = 5001: a node never repeats a stamp or goes back.',
  "The phone's clock is 800 ms behind. It applies [5001, laptop] and observes the stamp: its last jumps to 5001, though its wall clock reads 4200.",
  'You edit the title on the phone. Its stamp is max(4200, 5001 + 1) = 5002, above the write it read, so its title wins on every node.',
  "Later both nodes write the title before either hears of the other, and both stamps come out 5003: the laptop's from its wall clock, the phone's from last + 1.",
  "The pair decides: [5003, phone] beats [5003, laptop], because on equal ts the node id breaks the tie. Every node compares the same pairs and keeps the phone's title.",
  "The laptop's clock jumps a day ahead. Its next op is stamped more than maxSkew (24 h) past the phone's time: the phone refuses it with SKEW and never observes it.",
];

type Clock = { now: string; last: string; stamp: string };
const CLOCKS: Record<'laptop' | 'phone', Clock[]> = {
  laptop: [
    { now: '5000', last: '5000', stamp: '5000' },
    { now: '5000', last: '5001', stamp: '5001' },
    { now: '5000', last: '5001', stamp: '5001' },
    { now: '5000', last: '5001', stamp: '5001' },
    { now: '5003', last: '5003', stamp: '5003' },
    { now: '5003', last: '5003', stamp: '5003' },
    { now: '5004+25h', last: '5004+25h', stamp: '5004+25h' },
  ],
  phone: [
    { now: '4200', last: '4100', stamp: '4100' },
    { now: '4200', last: '4100', stamp: '4100' },
    { now: '4200', last: '5001', stamp: '4100' },
    { now: '4200', last: '5002', stamp: '5002' },
    { now: '4201', last: '5003', stamp: '5003' },
    { now: '4201', last: '5003', stamp: '5003' },
    { now: '4202', last: '5003', stamp: '5003' },
  ],
};
const ROWS: { key: keyof Clock; label: string; y: number }[] = [
  { key: 'now', label: 'Date.now()', y: 148 },
  { key: 'last', label: 'last', y: 170 },
  { key: 'stamp', label: 'its stamp', y: 192 },
];
const X = { laptop: 110, phone: 610 };
const changed = (node: 'laptop' | 'phone', key: keyof Clock, step: number) =>
  step > 0 && CLOCKS[node][step][key] !== CLOCKS[node][step - 1][key];
const writes = (node: 'laptop' | 'phone', step: number) =>
  node === 'laptop' ? [0, 1, 4, 6].includes(step) : [3, 4].includes(step);

const VERDICT = [
  ['max(5000, 4990 + 1) = 5000', 'the wall clock is ahead of last'],
  ['max(5000, 5000 + 1) = 5001', 'the same millisecond: last + 1'],
  ['observe(5001): last = 5001', "a peer's stamp lifts the phone's clock"],
  ['max(4200, 5001 + 1) = 5002', "above what it read: the phone's title wins"],
  ['[5003, laptop] vs [5003, phone]', 'two writes that did not see each other'],
  ['[5003, phone] > [5003, laptop]', 'equal ts: the higher node id wins, on both'],
  ['+25 h > now + maxSkew (24 h)', 'refused as SKEW, never observed'],
];

// The ops on their way: where each is at a step, and whether it shows.
type At = { x: number; y: number; hidden: boolean };
const at = (x: number, y: number, hidden = false): At => ({ x, y, hidden });
const OPS: { label: string; cls: string; w: number; path: (step: number) => At }[] = [
  {
    label: '[5001, laptop]',
    cls: 'f-peer-a',
    w: 102,
    path: (s) => (s === 0 ? at(200, 80, true) : s === 1 ? at(200, 80) : s === 2 ? at(520, 80) : at(600, 80, true)),
  },
  {
    label: '[5002, phone]',
    cls: 'f-peer-c',
    w: 96,
    path: (s) => (s <= 2 ? at(520, 80, true) : s === 3 ? at(520, 80) : at(120, 80, true)),
  },
  {
    label: '[5003, laptop]',
    cls: 'f-peer-a',
    w: 102,
    path: (s) => (s <= 3 ? at(200, 64, true) : s === 4 ? at(200, 64) : at(520, 64, s === 6)),
  },
  {
    label: '[5003, phone]',
    cls: 'f-peer-c',
    w: 96,
    path: (s) => (s <= 3 ? at(520, 96, true) : s === 4 ? at(520, 96) : at(200, 96, s === 6)),
  },
  {
    label: '[+25 h, laptop]',
    cls: 'f-peer-a',
    w: 110,
    path: (s) => (s <= 5 ? at(200, 80, true) : at(460, 80)),
  },
];
</script>

<template>
  <SyncFigure
    caption="Stamps: max(Date.now(), last + 1), observed from every peer, ordered by [ts, origin]"
    :steps="steps"
    :key-step="5"
    view-box="0 0 720 222"
  >
    <template #default="{ step, grad }">
      <rect class="f-card" x="230" y="12" width="260" height="28" rx="8" />
      <text class="f-text f-mono" x="360" y="31" text-anchor="middle">stamp = max(Date.now(), last + 1)</text>

      <line class="f-link" x1="140" y1="80" x2="580" y2="80" />

      <g v-for="(x, node) in X" :key="node">
        <text :class="['f-muted', { 'f-hidden': !writes(node, step) }]" :x="x" y="34" text-anchor="middle">
          you write
        </text>
        <circle class="f-node" :cx="x" cy="80" r="30" :fill="grad" />
        <text class="f-node-text" :x="x" y="80">{{ node }}</text>
        <rect class="f-card" :x="x - 95" y="124" width="190" height="84" rx="10" />
        <g v-for="row in ROWS" :key="row.key">
          <text class="f-muted" :x="x - 80" :y="row.y">{{ row.label }}</text>
          <text
            :class="['f-text', 'f-mono', { 'f-changed': changed(node, row.key, step) }]"
            :x="x + 10"
            :y="row.y"
          >
            {{ CLOCKS[node][step][row.key] }}
          </text>
        </g>
      </g>

      <!-- what the step computes -->
      <text class="f-text f-mono" x="360" y="160" text-anchor="middle">{{ VERDICT[step][0] }}</text>
      <text class="f-muted" x="360" y="184" text-anchor="middle">{{ VERDICT[step][1] }}</text>

      <!-- the ops on their way -->
      <g
        v-for="op in OPS"
        :key="op.label"
        :style="{ transform: `translate(${op.path(step).x}px, ${op.path(step).y}px)` }"
        :class="{ 'f-hidden': op.path(step).hidden }"
      >
        <rect :class="op.cls" :x="-op.w / 2" y="-10" :width="op.w" height="20" rx="10" />
        <text class="f-packet-text" x="0" y="0">{{ op.label }}</text>
      </g>

      <!-- refused -->
      <g :class="{ 'f-hidden': step !== 6 }">
        <line class="f-link" x1="532" y1="72" x2="548" y2="88" />
        <line class="f-link" x1="548" y1="72" x2="532" y2="88" />
      </g>
    </template>
  </SyncFigure>
</template>
