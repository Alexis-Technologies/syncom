<script setup lang="ts">
// A dialer meeting a host, as a sequence: hello (node id, protocol version, schema, vector, scopes)
// and the host's answer (node id, vector, log epoch, kinds); the dialer pushes what the host's
// vector lacks, in pages, and the answer carries the keys the page moved; then the dialer subscribes
// to the host's changes feed from its saved cursor, the feed replays what landed since (less the
// dialer's own ops), sends one idle page when read to its end, and live ops flow both ways.
// Depicts: src/sync/manager.js (#hello, #pushFromLog, #sendPages, #subscribe, #receive),
// src/sync/hosting.js (greet, push, changes), src/sync/outbound.js (outbound), src/sync/protocol.js
// (PROTOCOL, DEFAULT_PAGE_SIZE).
import SyncFigure from './SyncFigure.vue';

const steps = [
  'The laptop dials the server and says hello: its node id, the protocol version, its schema version and hash, its version vector and the scopes it asks for.',
  "The server checks the protocol and its authorize rule, grants the scopes, and answers with its node id, its vector, its log's epoch and the kinds it holds.",
  "By the server's vector the laptop sees what the server lacks, laptop:10 to 12, and pushes those ops in pages of up to 500. The server admits and applies them.",
  'The push answer carries the vector keys the page moved: the laptop now knows the server holds laptop:12, and no relay will send those ops again.',
  "The laptop subscribes to the server's changes feed from its saved cursor. The feed replays what landed since, server:31 to 34, and leaves out the laptop's own ops.",
  'The feed reaches its end and sends one idle page: the laptop is in sync. From now on every new op flows at once, pushed to the server and fed back from it.',
];

const LEFT = 195;
const RIGHT = 525;
type Lane = { y: number; to: 'host' | 'dialer'; label: string; w: number; detail: string; step: number };
const LANES: Lane[] = [
  { y: 30, to: 'host', label: 'hello', w: 54, detail: 'node · version 1 · schema · vector · scopes', step: 0 },
  { y: 70, to: 'dialer', label: 'answer', w: 60, detail: 'node · vector · epoch · kinds', step: 1 },
  { y: 110, to: 'host', label: 'laptop:10–12', w: 92, detail: "what the server's vector lacks, ≤ 500 a page", step: 2 },
  { y: 150, to: 'dialer', label: 'vector', w: 58, detail: 'the keys the page moved: laptop 12', step: 3 },
  { y: 190, to: 'dialer', label: 'server:31–34', w: 92, detail: 'changes from mwh…q.50: the replay', step: 4 },
  { y: 230, to: 'dialer', label: 'idle', w: 44, detail: 'read to its end: caught up', step: 5 },
];
// A packet sits at its sender's end until its step, then at the receiver's.
const packetX = (lane: Lane, step: number) => {
  const atHost = RIGHT - lane.w / 2 - 10;
  const atDialer = LEFT + lane.w / 2 + 10;
  const arrived = step >= lane.step;
  if (lane.to === 'host') return arrived ? atHost : atDialer;
  return arrived ? atDialer : atHost;
};
const head = (lane: Lane) =>
  lane.to === 'host'
    ? `M ${RIGHT - 7} ${lane.y - 5} L ${RIGHT} ${lane.y} L ${RIGHT - 7} ${lane.y + 5}`
    : `M ${LEFT + 7} ${lane.y - 5} L ${LEFT} ${lane.y} L ${LEFT + 7} ${lane.y + 5}`;

const laptopRows = (step: number) => [
  { name: 'laptop', value: '12', changed: false },
  { name: 'server', value: step >= 4 ? '34' : '30', changed: step === 4 },
  { name: 'cursor', value: step >= 4 ? 'mwh…q.57' : 'mwh…q.50', changed: step === 4 },
];
const serverRows = (step: number) => [
  { name: 'laptop', value: step >= 2 ? '12' : '9', changed: step === 2 },
  { name: 'server', value: '34', changed: false },
  { name: 'epoch', value: 'mwh…q', changed: false },
];
</script>

<template>
  <SyncFigure caption="Hello, push what the host lacks, then follow its feed" :steps="steps" :key-step="5">
    <template #default="{ step, grad }">
      <!-- the dialer and the host -->
      <circle class="f-node" cx="100" cy="56" r="30" :fill="grad" />
      <text class="f-node-text" x="100" y="56">laptop</text>
      <circle class="f-node" cx="620" cy="56" r="30" :fill="grad" />
      <text class="f-node-text" x="620" y="56">server</text>
      <text class="f-muted" x="100" y="100" text-anchor="middle">dials</text>
      <text class="f-muted" x="620" y="100" text-anchor="middle">hosts</text>

      <rect class="f-card" x="15" y="108" width="170" height="86" rx="10" />
      <text class="f-muted" x="28" y="128">vector</text>
      <g v-for="(row, i) in laptopRows(step)" :key="row.name">
        <text class="f-muted" x="28" :y="148 + i * 19">{{ row.name }}</text>
        <text :class="['f-text', 'f-mono', { 'f-changed': row.changed }]" x="96" :y="148 + i * 19">{{ row.value }}</text>
      </g>
      <rect class="f-card" x="535" y="108" width="170" height="86" rx="10" />
      <text class="f-muted" x="548" y="128">vector</text>
      <g v-for="(row, i) in serverRows(step)" :key="row.name">
        <text class="f-muted" x="548" :y="148 + i * 19">{{ row.name }}</text>
        <text :class="['f-text', 'f-mono', { 'f-changed': row.changed }]" x="616" :y="148 + i * 19">{{ row.value }}</text>
      </g>
      <text :class="['f-muted', { 'f-hidden': step < 1 || step > 2 }]" x="22" y="214">server lacks laptop:10–12</text>

      <!-- the messages, one lane each -->
      <g v-for="lane in LANES" :key="lane.y">
        <g :class="{ 'f-hidden': step < lane.step }">
          <line class="f-link" :x1="LEFT" :y1="lane.y" :x2="RIGHT" :y2="lane.y" />
          <path class="f-link" :d="head(lane)" />
          <text class="f-muted" x="360" :y="lane.y + 16" text-anchor="middle">{{ lane.detail }}</text>
        </g>
        <g
          :style="{ transform: `translate(${packetX(lane, step)}px, ${lane.y}px)` }"
          :class="{ 'f-hidden': step < lane.step }"
        >
          <rect :class="lane.to === 'host' ? 'f-peer-a' : 'f-peer-b'" :x="-lane.w / 2" y="-10" :width="lane.w" height="20" rx="10" />
          <text class="f-packet-text" x="0" y="0">{{ lane.label }}</text>
        </g>
      </g>

      <!-- then live, both ways -->
      <g :class="{ 'f-hidden': step < 5 }">
        <line class="f-link" :x1="LEFT" y1="268" :x2="RIGHT" y2="268" />
        <path class="f-link" :d="`M ${RIGHT - 7} 263 L ${RIGHT} 268 L ${RIGHT - 7} 273`" />
        <path class="f-link" :d="`M ${LEFT + 7} 263 L ${LEFT} 268 L ${LEFT + 7} 273`" />
        <rect class="f-peer-a" :x="RIGHT - 70" y="258" width="56" height="20" rx="10" />
        <text class="f-packet-text" :x="RIGHT - 42" y="268">push</text>
        <rect class="f-peer-b" :x="LEFT + 14" y="258" width="56" height="20" rx="10" />
        <text class="f-packet-text" :x="LEFT + 42" y="268">feed</text>
        <text class="f-muted" x="360" y="288" text-anchor="middle">then live: every new op, both ways</text>
      </g>
    </template>
  </SyncFigure>
</template>
