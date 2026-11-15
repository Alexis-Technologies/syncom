<script setup lang="ts">
// A node the host cannot resume — its cursor below the host's log floor, or of another epoch — joins a
// snapshot instead: the feed answers `bootstrap`, the node reads snapshot pages (live records and
// tombstones, each with its merge metadata), joins each page as merge ops of its own `@~` stream,
// adopts the vector of the first page as an advance op, and subscribes from that page's event id;
// what landed while it paged replays and folds in.
// Depicts: src/log.js (read: null below the floor or for another epoch), src/sync/hosting.js
// (changes: `bootstrap`, snapshot), src/sync/manager.js (#bootstrap, #join), src/bootstrap.js
// (snapshotPage, mergeBatch, adopt), src/vector.js (opKey: the `@~` stream).
import SyncFigure from './SyncFigure.vue';

const steps = [
  "The phone was offline for weeks. Its cursor points at 120 in the server's log, but the server has compacted everything below 400, its floor.",
  'The phone subscribes from 120. The feed cannot resume it without a gap, so it answers bootstrap instead of a page. A cursor of another epoch gets the same answer.',
  "The phone reads the server's snapshot in pages: every record in its scopes, live ones and tombstones alike, each with the metadata that lets it merge.",
  "Each page joins the phone's records as merge ops of its own phone@~ stream: t3 becomes a tombstone, t4 arrives. That stream never travels back to the server.",
  "After the last page the phone adopts the vector the first page carried, logged as an advance op, and sets its cursor to that page's event id, 412.",
  'It subscribes from 412. What landed while it paged, like 413, replays and folds in, as a no-op where a page carried it already, and the live feed goes on.',
];

// The retained part of the server's log: positions, then the one written while the phone paged.
const SLOTS = [
  { label: '.400', x: 300 },
  { label: '.401', x: 346 },
  { label: '.402', x: 392 },
  { label: '.410', x: 484 },
  { label: '.411', x: 530 },
  { label: '.412', x: 576 },
];
const cursor = (step: number) => (step >= 4 ? { x: 596, label: 'cursor .412' } : { x: 160, label: 'cursor .120' });

const RECORDS = [
  { id: 't1', x: 120, state: 'live' },
  { id: 't2', x: 222, state: 'live' },
  { id: 't3', x: 324, state: 'tombstone' },
  { id: 't4', x: 426, state: 'live' },
];
// What the phone holds of each record: three weeks old until the merge, t4 not at all.
const phoneState = (id: string, state: string, step: number) => (step >= 3 ? state : '3 weeks old');
const phoneHas = (id: string, step: number) => id !== 't4' || step >= 3;

type At = { y: number; hidden: boolean };
const at = (y: number, hidden = false): At => ({ y, hidden });
const PACKETS: { label: string; cls: string; w: number; path: (step: number) => At }[] = [
  { label: 'bootstrap', cls: 'f-peer-b', w: 72, path: (s) => (s === 0 ? at(100, true) : s === 1 ? at(142) : at(190, true)) },
  { label: 'page 1', cls: 'f-peer-b', w: 56, path: (s) => (s <= 1 ? at(100, true) : s === 2 ? at(128) : at(195, true)) },
  { label: 'page 2', cls: 'f-peer-b', w: 56, path: (s) => (s <= 1 ? at(100, true) : s === 2 ? at(158) : at(195, true)) },
  { label: '.413', cls: 'f-peer-a', w: 50, path: (s) => (s <= 4 ? at(100, true) : at(142)) },
];
const merges = (step: number) => (step >= 4 ? 5 : step >= 3 ? 4 : 0);
</script>

<template>
  <SyncFigure caption="Below the floor: join a snapshot, then follow the feed" :steps="steps" :key-step="3">
    <template #default="{ step, grad }">
      <!-- the server's log: what it compacted, what it keeps -->
      <circle class="f-node" cx="60" cy="60" r="28" :fill="grad" />
      <text class="f-node-text" x="60" y="60">server</text>
      <text class="f-muted" x="120" y="36">server's log</text>
      <text class="f-muted" x="300" y="36">floor .400</text>
      <rect class="f-card f-link-off" x="120" y="46" width="170" height="26" rx="5" />
      <text class="f-muted" x="205" y="63" text-anchor="middle">compacted</text>
      <g v-for="slot in SLOTS" :key="slot.label">
        <rect class="f-peer-b" :x="slot.x" y="46" width="40" height="26" rx="5" />
        <text class="f-packet-text" :x="slot.x + 20" y="59">{{ slot.label }}</text>
      </g>
      <text class="f-muted" x="458" y="63" text-anchor="middle">…</text>
      <g :class="{ 'f-hidden': step < 3 }">
        <rect class="f-peer-a" x="622" y="46" width="40" height="26" rx="5" />
        <text class="f-packet-text" x="642" y="59">.413</text>
      </g>

      <!-- the phone's cursor into it -->
      <g :style="{ transform: `translate(${cursor(step).x}px, 0px)` }">
        <line class="f-link" x1="0" y1="74" x2="0" y2="84" />
        <rect class="f-card" x="-46" y="84" width="92" height="22" rx="11" />
        <text :class="['f-text', 'f-mono', { 'f-changed': step === 4 }]" x="0" y="99" text-anchor="middle">
          {{ cursor(step).label }}
        </text>
      </g>
      <text :class="['f-muted', { 'f-hidden': step > 1 }]" x="214" y="99">below the floor: no resume</text>

      <!-- the server's records -->
      <g v-for="record in RECORDS" :key="record.id">
        <rect class="f-card" :x="record.x" y="122" width="92" height="44" rx="8" />
        <text class="f-text f-mono" :x="record.x + 12" y="140">{{ record.id }}</text>
        <text class="f-muted" :x="record.x + 12" y="158">{{ record.state }}</text>
      </g>
      <text class="f-muted" x="530" y="148">the server's records</text>

      <!-- the link and what crosses it -->
      <line class="f-link" x1="60" y1="90" x2="60" y2="197" />
      <g
        v-for="packet in PACKETS"
        :key="packet.label"
        :style="{ transform: `translate(60px, ${packet.path(step).y}px)` }"
        :class="{ 'f-hidden': packet.path(step).hidden }"
      >
        <rect :class="packet.cls" :x="-packet.w / 2" y="-10" :width="packet.w" height="20" rx="10" />
        <text class="f-packet-text" x="0" y="0">{{ packet.label }}</text>
      </g>

      <!-- the phone: its records, and the stream the merges run in -->
      <circle class="f-node" cx="60" cy="225" r="28" :fill="grad" />
      <text class="f-node-text" x="60" y="225">phone</text>
      <g v-for="record in RECORDS" :key="record.id" :class="{ 'f-hidden': !phoneHas(record.id, step) }">
        <rect class="f-card" :x="record.x" y="200" width="92" height="44" rx="8" />
        <text class="f-text f-mono" :x="record.x + 12" y="218">{{ record.id }}</text>
        <text :class="['f-muted', { 'f-changed': step === 3 }]" :x="record.x + 12" y="236">
          {{ phoneState(record.id, record.state, step) }}
        </text>
      </g>
      <text class="f-muted" x="530" y="226">the phone's records</text>
      <text class="f-muted f-mono" x="120" y="278">phone@~</text>
      <g v-for="n in 5" :key="n" :class="{ 'f-hidden': n > merges(step) }">
        <rect class="f-peer-c" :x="145 + n * 30" y="264" width="26" height="20" rx="4" />
        <text class="f-packet-text" :x="158 + n * 30" y="274">{{ n }}</text>
      </g>
      <text class="f-muted" x="335" y="278">
        {{ step === 3 ? 'merge ×4' : step >= 4 ? "merge ×4, then advance: the host's vector" : '' }}
      </text>
    </template>
  </SyncFigure>
</template>
