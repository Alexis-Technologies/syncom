<script setup lang="ts">
// Clients on two hubs: hub 2 dials hub 1 like any client, so an op travels hop by hop — pushed to a
// hub, fed from it, pushed on — and the copy that comes back over the other direction of a link is
// dropped by the vector as a duplicate. Then the alternative: hubs with no link between them, each
// appending what it accepts to one broker topic and applying from it what it lacks, so a client's
// cursor is a topic position and the client resumes on any hub.
// Depicts: src/sync/manager.js (#fanOut, #scheduleFlush, #receive), src/sync/hosting.js (changes,
// sharedChanges), src/apply.js (admit: duplicates), src/sync/shared.js (SharedHub: relay, consumer).
import SyncFigure from './SyncFigure.vue';

const steps = [
  'The laptop dials hub 1, the phone dials hub 2, and hub 2 dials hub 1 like any other client. Each hub keeps a full replica in its own database and log.',
  "You write on the laptop. laptop:7 reaches hub 1 by a push, and hub 1's change event wakes every feed it hosts.",
  "Hub 2 follows hub 1's feed, so it gets laptop:7 there, and its own feed passes the op on to the phone: ops travel hop by hop.",
  "The phone's write goes the other way: pushed to hub 2, pushed on to hub 1, which hub 2 dials, and fed from hub 1 to the laptop.",
  "Hub 1's feed also hands phone:4 back to hub 2. Hub 2's vector already holds it, so it is dropped as a duplicate: an op never loops.",
  "Or drop the hub-to-hub link and share one log: each hub appends the ops it accepts to a broker's topic, and applies from it what it lacks.",
  "Every hub then serves its feeds from the topic, so a client's cursor is a topic position, the same on every hub: the phone moves to hub 1 and resumes there.",
];

const N = {
  laptop: { x: 120, y: 220, label: 'laptop', r: 28 },
  hub1: { x: 220, y: 90, label: 'hub 1', r: 30 },
  hub2: { x: 500, y: 90, label: 'hub 2', r: 30 },
  phone: { x: 600, y: 220, label: 'phone', r: 28 },
};
type Name = keyof typeof N;

// Each node's log: two older ops, then laptop:7 and phone:4 from the step they land.
const LANDS: Record<Name, { a: number; c: number }> = {
  laptop: { a: 1, c: 3 },
  hub1: { a: 1, c: 3 },
  hub2: { a: 2, c: 3 },
  phone: { a: 2, c: 3 },
};
const logY = (name: Name) => (name === 'hub1' || name === 'hub2' ? 30 : 262);

type At = { x: number; y: number; hidden: boolean };
const at = (x: number, y: number, hidden = false): At => ({ x, y, hidden });
const node = (name: Name, hidden = true, dy = 0): At => at(N[name].x, N[name].y + dy, hidden);
const A = { label: 'laptop:7', cls: 'f-peer-a', w: 62 };
const C = { label: 'phone:4', cls: 'f-peer-c', w: 56 };
const PACKETS = [
  { ...A, path: (s: number) => (s === 0 ? node('laptop') : s === 1 ? at(170, 155) : node('hub1')) },
  { ...A, path: (s: number) => (s <= 1 ? node('hub1', true, -22) : s === 2 ? at(360, 68) : node('hub2', true, -22)) },
  { ...A, path: (s: number) => (s <= 1 ? node('hub2') : s === 2 ? at(550, 155) : node('phone')) },
  { ...C, path: (s: number) => (s <= 2 ? node('phone') : s === 3 ? at(550, 155) : node('hub2')) },
  { ...C, path: (s: number) => (s <= 2 ? node('hub2', true, 22) : s === 3 ? at(360, 112) : node('hub1', true, 22)) },
  { ...C, path: (s: number) => (s <= 2 ? node('hub1') : s === 3 ? at(170, 155) : node('laptop')) },
  { ...C, path: (s: number) => (s <= 3 ? node('hub1', true, -22) : s === 4 ? at(360, 68) : node('hub2', true, -22)) },
  { ...A, path: (s: number) => (s <= 4 ? node('hub1') : s === 5 ? at(270, 143) : at(330, 222, true)) },
  { ...C, path: (s: number) => (s <= 4 ? node('hub2') : s === 5 ? at(450, 143) : at(390, 222, true)) },
];
</script>

<template>
  <SyncFigure caption="Two hubs: ops relayed hop by hop, or one shared log behind every hub" :steps="steps" :key-step="4">
    <template #default="{ step, grad }">
      <!-- links -->
      <line class="f-link" :x1="N.laptop.x" :y1="N.laptop.y" :x2="N.hub1.x" :y2="N.hub1.y" />
      <line :class="['f-link', { 'f-hidden': step >= 5 }]" :x1="N.hub1.x" :y1="N.hub1.y" :x2="N.hub2.x" :y2="N.hub2.y" />
      <line :class="['f-link', { 'f-hidden': step === 6 }]" :x1="N.hub2.x" :y1="N.hub2.y" :x2="N.phone.x" :y2="N.phone.y" />
      <line :class="['f-link', { 'f-hidden': step !== 6 }]" :x1="N.phone.x" :y1="N.phone.y" :x2="N.hub1.x" :y2="N.hub1.y" />
      <g :class="{ 'f-hidden': step < 5 }">
        <line class="f-link" :x1="N.hub1.x" :y1="N.hub1.y" x2="320" y2="196" />
        <line class="f-link" :x1="N.hub2.x" :y1="N.hub2.y" x2="400" y2="196" />
        <rect class="f-card" x="290" y="196" width="140" height="56" rx="10" />
        <text class="f-muted" x="360" y="216" text-anchor="middle">broker topic</text>
        <rect class="f-peer-a" x="334" y="226" width="22" height="16" rx="3" />
        <rect class="f-peer-c" x="364" y="226" width="22" height="16" rx="3" />
      </g>

      <!-- nodes and their logs -->
      <g v-for="(n, name) in N" :key="name">
        <circle class="f-node" :cx="n.x" :cy="n.y" :r="n.r" :fill="grad" />
        <text class="f-node-text" :x="n.x" :y="n.y">{{ n.label }}</text>
        <rect class="f-cell" :x="n.x - 46" :y="logY(name)" width="20" height="16" rx="3" />
        <rect class="f-cell" :x="n.x - 22" :y="logY(name)" width="20" height="16" rx="3" />
        <rect :class="['f-peer-a', { 'f-hidden': step < LANDS[name].a }]" :x="n.x + 2" :y="logY(name)" width="20" height="16" rx="3" />
        <rect :class="['f-peer-c', { 'f-hidden': step < LANDS[name].c }]" :x="n.x + 26" :y="logY(name)" width="20" height="16" rx="3" />
      </g>

      <!-- ops on their way -->
      <g
        v-for="(packet, i) in PACKETS"
        :key="i"
        :style="{ transform: `translate(${packet.path(step).x}px, ${packet.path(step).y}px)` }"
        :class="{ 'f-hidden': packet.path(step).hidden }"
      >
        <rect :class="packet.cls" :x="-packet.w / 2" y="-10" :width="packet.w" height="20" rx="10" />
        <text class="f-packet-text" x="0" y="0">{{ packet.label }}</text>
      </g>

      <!-- the echo, dropped -->
      <g :class="{ 'f-hidden': step !== 4 }">
        <line class="f-link" x1="398" y1="62" x2="410" y2="74" />
        <line class="f-link" x1="410" y1="62" x2="398" y2="74" />
        <text class="f-muted" x="430" y="140" text-anchor="middle">duplicate: dropped</text>
      </g>
      <text :class="['f-muted', { 'f-hidden': step !== 6 }]" :x="N.phone.x" y="294" text-anchor="middle">
        cursor: a topic position
      </text>
    </template>
  </SyncFigure>
</template>
