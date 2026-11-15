<script setup lang="ts">
// The per-stream hash chain and the fork it catches: an op's fingerprint is the SHA-256 of its header,
// `prev` (the last field of the header) names the fingerprint of the op before it in its stream, so a
// stream is a chain; a writer that makes two ops under one seq sends one to each hub, each hub takes
// the first it is handed, and the hub handed the other — or the next op of the other branch — refuses
// it as EQUIVOCATION (reason seq, then chain), neither logged nor relayed.
// Depicts: src/header.js (headerOf, fingerprintOf), src/commit.js (link), src/apply.js (admit,
// equivocates), src/log.js (fingerprintOf, the heads).
import SyncFigure from './SyncFigure.vue';

const steps = [
  "An op's fingerprint is the SHA-256 of its header: origin, seq, stamp, type, record and the rest, prev last. mallory:1 names no op before it and hashes to A7.",
  'Each next op names the fingerprint of the one before it as prev, inside its own header: mallory:2 names A7, mallory:3 names C2. The stream is a hash chain.',
  'mallory forks: it pushes mallory:3 (fingerprint 9F) to hub 1, and a second mallory:3 with another stamp, the same prev C2 but fingerprint E4, to hub 2.',
  "Each hub takes the op it was handed, and their vectors agree: mallory 3 on both. By numbers alone, each would take the other's op for a duplicate for good.",
  "Hub 2 follows hub 1's feed, which passes on its mallory:3. Hub 2 holds E4 at that seq, not 9F: it refuses the op as EQUIVOCATION and reports both fingerprints.",
  "mallory's next op on the first branch, mallory:4 with prev 9F, fails at hub 2 the same way: its prev is not the E4 held there. Each hub keeps the branch it took first.",
];

type Card = { x: number; y: number; seq: number; prev: string; fp: string; from: number };
const CARDS: Card[] = [
  { x: 15, y: 40, seq: 1, prev: '—', fp: 'A7…', from: 0 },
  { x: 150, y: 40, seq: 2, prev: 'A7…', fp: 'C2…', from: 1 },
  { x: 285, y: 40, seq: 3, prev: 'C2…', fp: '9F…', from: 1 },
  { x: 285, y: 150, seq: 3, prev: 'C2…', fp: 'E4…', from: 2 },
];
const litPrev = (step: number, i: number) => step === 1 && (i === 1 || i === 2);
const litFp = (step: number, i: number) => (step === 0 && i === 0) || (step === 2 && i === 3);

const header = (step: number) =>
  step === 0
    ? '[1, mallory, 1, 5000, set, t1, …, null] → A7…'
    : step === 1
      ? '[1, mallory, 3, 5002, set, t1, …, C2…] → 9F…'
      : '[1, mallory, 3, 5007, set, t1, …, C2…] → E4…';

const HUB = { x: 480, one: 70, two: 215 };
const cellX = (i: number) => 520 + i * 30;
// The cells each hub's log holds of mallory's stream, and from which step.
const HUB_CELLS = {
  one: [
    { label: '1', from: 2 },
    { label: '2', from: 2 },
    { label: '3', from: 3 },
    { label: '4', from: 5 },
  ],
  two: [
    { label: '1', from: 2 },
    { label: '2', from: 2 },
    { label: '3', from: 3 },
  ],
};

type At = { x: number; y: number; hidden: boolean };
const at = (x: number, y: number, hidden = false): At => ({ x, y, hidden });
const PACKETS: { label: string; w: number; path: (step: number) => At }[] = [
  { label: '3 · 9F…', w: 64, path: (s) => (s <= 1 ? at(425, 71, true) : s === 2 ? at(425, 71) : at(HUB.x, HUB.one, true)) },
  { label: '3 · E4…', w: 64, path: (s) => (s <= 1 ? at(425, 181, true) : s === 2 ? at(425, 181) : at(HUB.x, HUB.two, true)) },
  { label: '3 · 9F…', w: 64, path: (s) => (s <= 3 ? at(HUB.x, HUB.one, true) : s === 4 ? at(HUB.x, 150) : at(HUB.x, 190, true)) },
  { label: '4 · prev 9F…', w: 92, path: (s) => (s <= 4 ? at(HUB.x, HUB.one, true) : at(HUB.x, 150)) },
];
</script>

<template>
  <SyncFigure caption="Each stream is a hash chain; two ops under one seq are refused as EQUIVOCATION" :steps="steps" :key-step="4">
    <template #default="{ step, grad }">
      <text class="f-label" x="205" y="24">mallory's stream</text>

      <!-- the chain: each op names the fingerprint of the one before it -->
      <g :class="{ 'f-hidden': step < 1 }">
        <line class="f-link" x1="150" y1="74" x2="128" y2="74" />
        <path class="f-link" d="M 134 69 L 128 74 L 134 79" />
        <line class="f-link" x1="285" y1="74" x2="263" y2="74" />
        <path class="f-link" d="M 269 69 L 263 74 L 269 79" />
      </g>
      <g :class="{ 'f-hidden': step < 2 }">
        <path class="f-link" d="M 285 184 L 205 184 L 205 105" />
        <path class="f-link" d="M 200 111 L 205 105 L 210 111" />
      </g>
      <g v-for="(card, i) in CARDS" :key="i" :class="{ 'f-hidden': step < card.from }">
        <rect class="f-card" :x="card.x" :y="card.y" width="110" height="62" rx="8" />
        <text class="f-text f-mono" :x="card.x + 12" :y="card.y + 20">mallory:{{ card.seq }}</text>
        <text :class="['f-muted', 'f-mono', { 'f-changed': litPrev(step, i) }]" :x="card.x + 12" :y="card.y + 38">
          prev {{ card.prev }}
        </text>
        <text :class="['f-text', 'f-mono', { 'f-changed': litFp(step, i) }]" :x="card.x + 12" :y="card.y + 54">
          fp {{ card.fp }}
        </text>
      </g>

      <!-- the header a fingerprint hashes -->
      <text class="f-muted" x="15" y="238">the header the fingerprint hashes</text>
      <text :class="['f-text', 'f-mono', { 'f-changed': step === 1 || step === 2 }]" x="15" y="260">{{ header(step) }}</text>

      <!-- two hubs; hub 2 follows hub 1's feed -->
      <line class="f-link" :x1="HUB.x" :y1="HUB.one + 28" :x2="HUB.x" :y2="HUB.two - 28" />
      <circle class="f-node" :cx="HUB.x" :cy="HUB.one" r="28" :fill="grad" />
      <text class="f-node-text" :x="HUB.x" :y="HUB.one">hub 1</text>
      <circle class="f-node" :cx="HUB.x" :cy="HUB.two" r="28" :fill="grad" />
      <text class="f-node-text" :x="HUB.x" :y="HUB.two">hub 2</text>
      <g v-for="(cells, hub) in HUB_CELLS" :key="hub">
        <g v-for="(cell, i) in cells" :key="i" :class="{ 'f-hidden': step < cell.from }">
          <rect class="f-peer-a" :x="cellX(i)" :y="HUB[hub] - 11" width="26" height="22" rx="4" />
          <text class="f-packet-text" :x="cellX(i) + 13" :y="HUB[hub]">{{ cell.label }}</text>
        </g>
      </g>
      <g :class="{ 'f-hidden': step < 3 }">
        <text class="f-muted f-mono" x="520" y="104">holds 3 = 9F…</text>
        <text class="f-muted f-mono" x="520" y="120">vector: mallory 3</text>
        <text class="f-muted f-mono" x="520" y="250">holds 3 = E4…</text>
        <text class="f-muted f-mono" x="520" y="266">vector: mallory 3</text>
      </g>

      <!-- the ops on their way -->
      <g
        v-for="(packet, i) in PACKETS"
        :key="i"
        :style="{ transform: `translate(${packet.path(step).x}px, ${packet.path(step).y}px)` }"
        :class="{ 'f-hidden': packet.path(step).hidden }"
      >
        <rect class="f-peer-a" :x="-packet.w / 2" y="-10" :width="packet.w" height="20" rx="10" />
        <text class="f-packet-text" x="0" y="0">{{ packet.label }}</text>
      </g>

      <!-- refused at hub 2 -->
      <g :class="{ 'f-hidden': step < 4 }">
        <line class="f-link" x1="473" y1="170" x2="487" y2="184" />
        <line class="f-link" x1="487" y1="170" x2="473" y2="184" />
        <text class="f-text f-mono" x="530" y="156">EQUIVOCATION ({{ step === 5 ? 'chain' : 'seq' }})</text>
        <text class="f-muted f-mono" x="530" y="174">{{ step === 5 ? 'prev 9F…, held E4…' : 'held E4…, got 9F…' }}</text>
      </g>
    </template>
  </SyncFigure>
</template>
