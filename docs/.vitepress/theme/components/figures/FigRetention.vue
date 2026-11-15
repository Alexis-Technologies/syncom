<script setup lang="ts">
// Retention and acknowledgements: a node that dials keeps its own ops until every enabled registered
// node has acknowledged them (`acked`, set at hello, raised by push answers), even past retention;
// a host drops whole segments past its retention and its floor rises; a client whose cursor is above
// the floor resumes, one below it is told to bootstrap; and a host registered after the node's first
// ops were compacted lacks the start of its stream: UNDELIVERABLE, nothing of it pushed there.
// Depicts: src/sync/manager.js (#ack, #undelivered, #lost), src/log.js (retain, #compact, floor, read),
// src/sync/outbound.js (unreachable), src/sync/hosting.js (changes: `bootstrap`).
import SyncFigure from './SyncFigure.vue';

const steps = [
  "The laptop dials the server and keeps acked: how far the server holds the laptop's own stream, here all of laptop:1 to 4. Retention is 6 ops in this picture.",
  'The laptop goes offline for two weeks and you write laptop:5 to 12. Its log passes retention, but an op the server has not acknowledged is never compacted.',
  "Meanwhile the server's log grows past its retention and drops whole segments from the front. Its floor rises to 41.",
  'The phone was away for a day. Its cursor, 44, is above the floor, so its feed resumes there and replays only what the phone missed.',
  "The laptop reconnects and pushes laptop:5 to 12. The answer raises acked to 12: the ops are delivered, and the laptop's log drops its oldest down to retention.",
  "Its feed cursor, 30, is below the server's floor. The server cannot replay what it dropped, so the feed answers bootstrap and the laptop joins a snapshot instead.",
  "A host registered only now, backup, lacks laptop:1 to 6, which the laptop's log no longer holds: the laptop reports UNDELIVERABLE and pushes it none of that stream.",
];

const cellX = (i: number) => 100 + (i - 1) * 26;
const ownShown = (i: number, step: number) => (i <= 4 || step >= 1) && !(i <= 6 && step >= 4);
const acked = (step: number) => (step >= 4 ? 12 : 4);
const kept = (step: number) =>
  step === 0
    ? ['kept: 4 ops', 'all acknowledged']
    : step <= 3
      ? ['kept: 12 ops', '8 not acknowledged yet']
      : ['kept: 6 ops', 'retention 6: oldest dropped'];

const BLOCKS = [
  { label: '.25–.32', x: 100, dropped: true },
  { label: '.33–.40', x: 186, dropped: true },
  { label: '.41–.48', x: 272, dropped: false },
  { label: '.49–.56', x: 358, dropped: false },
];
const blockShown = (block: (typeof BLOCKS)[number], step: number) => (block.dropped ? step < 2 : step >= 2);
const floor = (step: number) => (step >= 2 ? { x: 272, label: 'floor .41' } : { x: 100, label: 'floor .25' });

type At = { y: number; hidden: boolean };
const at = (y: number, hidden = false): At => ({ y, hidden });
const PACKETS: { label: string; cls: string; w: number; path: (step: number) => At }[] = [
  { label: 'laptop:5–12', cls: 'f-peer-a', w: 86, path: (s) => (s <= 3 ? at(100, true) : s === 4 ? at(132) : at(172, true)) },
  { label: 'bootstrap', cls: 'f-peer-b', w: 72, path: (s) => (s <= 4 ? at(172, true) : s === 5 ? at(132) : at(100, true)) },
];
</script>

<template>
  <SyncFigure
    caption="Own ops kept until acknowledged; a cursor below the floor bootstraps"
    :steps="steps"
    :key-step="5"
    view-box="0 0 720 274"
  >
    <template #default="{ step, grad }">
      <!-- the laptop's own stream -->
      <circle class="f-node" cx="50" cy="62" r="28" :fill="grad" />
      <text class="f-node-text" x="50" y="62">laptop</text>
      <text class="f-muted" x="100" y="38">the laptop's own stream</text>
      <g :class="{ 'f-hidden': step < 4 }">
        <rect v-for="i in 6" :key="i" class="f-card f-link-off" :x="cellX(i)" y="52" width="22" height="20" rx="4" />
      </g>
      <g v-for="i in 12" :key="i" :class="{ 'f-hidden': !ownShown(i, step) }">
        <rect class="f-peer-a" :x="cellX(i)" y="52" width="22" height="20" rx="4" />
        <text class="f-packet-text" :x="cellX(i) + 11" y="62">{{ i }}</text>
      </g>
      <g :style="{ transform: `translate(${cellX(acked(step)) + 11}px, 0px)` }">
        <line class="f-link" x1="0" y1="74" x2="0" y2="82" />
        <rect class="f-card" x="-38" y="82" width="76" height="20" rx="10" />
        <text :class="['f-text', 'f-mono', { 'f-changed': step === 4 }]" x="0" y="96" text-anchor="middle">
          acked {{ acked(step) }}
        </text>
      </g>
      <text :class="['f-text', { 'f-changed': step === 1 || step === 4 }]" x="450" y="58">{{ kept(step)[0] }}</text>
      <text class="f-muted" x="450" y="78">{{ kept(step)[1] }}</text>

      <!-- a host registered too late -->
      <g :class="{ 'f-hidden': step < 6 }">
        <circle class="f-node" cx="660" cy="62" r="28" :fill="grad" />
        <text class="f-node-text" x="660" y="62">backup</text>
        <text class="f-text f-mono" x="660" y="110" text-anchor="middle">UNDELIVERABLE</text>
        <text class="f-muted" x="660" y="128" text-anchor="middle">lacks laptop:1–6</text>
      </g>

      <!-- the link and what crosses it -->
      <line class="f-link" x1="50" y1="90" x2="50" y2="172" />
      <g
        v-for="packet in PACKETS"
        :key="packet.label"
        :style="{ transform: `translate(50px, ${packet.path(step).y}px)` }"
        :class="{ 'f-hidden': packet.path(step).hidden }"
      >
        <rect :class="packet.cls" :x="-packet.w / 2" y="-10" :width="packet.w" height="20" rx="10" />
        <text class="f-packet-text" x="0" y="0">{{ packet.label }}</text>
      </g>

      <!-- the server's log: segments, the floor, two cursors into it -->
      <circle class="f-node" cx="50" cy="200" r="28" :fill="grad" />
      <text class="f-node-text" x="50" y="200">server</text>
      <g :style="{ transform: `translate(${floor(step).x}px, 0px)` }">
        <text :class="['f-muted', { 'f-changed': step === 2 }]" x="0" y="176">{{ floor(step).label }}</text>
      </g>
      <g v-for="block in BLOCKS" :key="block.label">
        <g v-if="block.dropped">
          <rect class="f-card f-link-off" :x="block.x" y="184" width="80" height="26" rx="5" />
          <text class="f-muted" :x="block.x + 40" y="201" text-anchor="middle">dropped</text>
        </g>
        <g :class="{ 'f-hidden': !blockShown(block, step) }">
          <rect class="f-peer-b" :x="block.x" y="184" width="80" height="26" rx="5" />
          <text class="f-packet-text" :x="block.x + 40" y="197">{{ block.label }}</text>
        </g>
      </g>
      <text :class="['f-muted', { 'f-hidden': step < 2 }]" x="460" y="202">segments past retention dropped</text>

      <line class="f-link" x1="165" y1="211" x2="165" y2="222" />
      <rect class="f-card" x="123" y="222" width="84" height="20" rx="10" />
      <text :class="['f-text', 'f-mono', { 'f-changed': step === 5 }]" x="165" y="236" text-anchor="middle">laptop .30</text>
      <text :class="['f-muted', { 'f-hidden': step < 5 }]" x="165" y="262" text-anchor="middle">bootstrap</text>
      <g :class="{ 'f-hidden': step < 3 }">
        <line class="f-link" x1="317" y1="211" x2="317" y2="222" />
        <rect class="f-card" x="277" y="222" width="80" height="20" rx="10" />
        <text :class="['f-text', 'f-mono', { 'f-changed': step === 3 }]" x="317" y="236" text-anchor="middle">phone .44</text>
        <text class="f-muted" x="317" y="262" text-anchor="middle">resumes</text>
      </g>
    </template>
  </SyncFigure>
</template>
