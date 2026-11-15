<script setup lang="ts">
// The feed's cursor across a dropped link and a failing page: every page is labelled with the event id
// of its last entry and the dialer's cursor moves there only once the page landed; the link drops and
// comes back, the transport reopens the subscription from the last event id and the feed replays what
// the dialer missed; the dialer greets again and pushes what it wrote meanwhile (its own ops come back
// on the feed only as a position); a page that fails is a break — the feed reopened from the saved
// cursor, PAGE_FAILED — and the third failure in a row leaves the peer STUCK.
// Depicts: src/sync/manager.js (#subscribe, #receive, #pageFailed, MAX_PAGE_RETRIES, the reconnect
// handler), src/sync/hosting.js (changes), src/wrpc/wrpc.js (lastEventId), src/sync/registry.js.
import SyncFigure from './SyncFigure.vue';

const steps = [
  "The laptop follows the server's changes feed. Every page carries the event id of its last entry, and the laptop's cursor moves there only once the page has landed.",
  "The link drops. The server's log goes on to 47, and you keep writing on the laptop: laptop:13 and 14 wait in its own log.",
  'The link comes back and reopens the subscription from the last event id, 44. The feed replays 45 to 47, and the cursor moves to 47.',
  'The laptop greets the server again and pushes what it wrote meanwhile. Its ops land at 48 and 49; the feed passes over them and the cursor moves to 49.',
  'Page 50 fails to apply on the laptop, say a beforeApply hook throws. The cursor stays at 49; the feed is closed and reopened from there, so the page comes again.',
  'After the third failure in a row the laptop stops: the peer is STUCK, its cursor still at 49. Nothing past that page is taken until you fix the cause and re-enable the node.',
];

// The server's log: each position, the origin's colour, and from which step it is there.
const ENTRIES = [
  { p: 41, cls: 'f-peer-b', from: 0 },
  { p: 42, cls: 'f-peer-c', from: 0 },
  { p: 43, cls: 'f-peer-b', from: 0 },
  { p: 44, cls: 'f-peer-c', from: 0 },
  { p: 45, cls: 'f-peer-b', from: 1 },
  { p: 46, cls: 'f-peer-c', from: 1 },
  { p: 47, cls: 'f-peer-b', from: 1 },
  { p: 48, cls: 'f-peer-a', from: 3 },
  { p: 49, cls: 'f-peer-a', from: 3 },
  { p: 50, cls: 'f-peer-c', from: 4 },
];
const cellX = (p: number) => 120 + (p - 41) * 58;
const CURSOR = [44, 44, 47, 49, 49, 49];
const cursorX = (step: number) => cellX(CURSOR[step]) + 25;

const EVENTS = [
  'page .44 landed → cursor .44',
  'close: link down',
  'reconnect: feed resumes from .44',
  'hello, push laptop:13–14',
  'PAGE_FAILED at .50, attempt 1',
  'STUCK after 3 attempts at .50',
];

type At = { y: number; hidden: boolean };
const at = (y: number, hidden = false): At => ({ y, hidden });
const PACKETS: { label: string; cls: string; w: number; path: (step: number) => At }[] = [
  { label: 'page .44', cls: 'f-peer-b', w: 64, path: (s) => (s === 0 ? at(160) : at(190, true)) },
  { label: 'page .45–.47', cls: 'f-peer-b', w: 90, path: (s) => (s <= 1 ? at(110, true) : s === 2 ? at(150) : at(190, true)) },
  { label: 'laptop:13–14', cls: 'f-peer-a', w: 90, path: (s) => (s <= 2 ? at(190, true) : s === 3 ? at(130) : at(95, true)) },
  { label: 'page .50', cls: 'f-peer-b', w: 64, path: (s) => (s <= 3 ? at(110, true) : at(150)) },
];
</script>

<template>
  <SyncFigure caption="The feed's cursor: resumed after a drop, held at a page that fails" :steps="steps" :key-step="4">
    <template #default="{ step, grad }">
      <!-- the server and its log -->
      <circle class="f-node" cx="60" cy="60" r="28" :fill="grad" />
      <text class="f-node-text" x="60" y="60">server</text>
      <text class="f-muted" x="120" y="34">server's log, by event id</text>
      <g v-for="entry in ENTRIES" :key="entry.p" :class="{ 'f-hidden': step < entry.from }">
        <rect :class="entry.cls" :x="cellX(entry.p)" y="47" width="50" height="26" rx="5" />
        <text class="f-packet-text" :x="cellX(entry.p) + 25" y="60">.{{ entry.p }}</text>
      </g>

      <!-- the laptop's cursor into it -->
      <g :style="{ transform: `translate(${cursorX(step)}px, 0px)` }">
        <line class="f-link" x1="0" y1="75" x2="0" y2="86" />
        <rect class="f-card" x="-44" y="86" width="88" height="22" rx="11" />
        <text
          :class="['f-text', 'f-mono', { 'f-changed': step > 0 && CURSOR[step] !== CURSOR[step - 1] }]"
          x="0"
          y="101"
          text-anchor="middle"
        >
          cursor .{{ CURSOR[step] }}
        </text>
      </g>

      <!-- the link -->
      <line :class="['f-link', { 'f-link-off': step === 1 }]" x1="60" y1="90" x2="60" y2="180" />
      <text :class="['f-muted', { 'f-hidden': step !== 1 }]" x="74" y="140">link down</text>

      <!-- the laptop and what it wrote offline -->
      <circle class="f-node" cx="60" cy="210" r="28" :fill="grad" />
      <text class="f-node-text" x="60" y="210">laptop</text>
      <g :class="{ 'f-hidden': step < 1 || step > 2 }">
        <rect class="f-peer-a" x="110" y="199" width="70" height="22" rx="5" />
        <text class="f-packet-text" x="145" y="210">laptop:13</text>
        <rect class="f-peer-a" x="186" y="199" width="70" height="22" rx="5" />
        <text class="f-packet-text" x="221" y="210">laptop:14</text>
        <text class="f-muted" x="110" y="240">written while offline</text>
      </g>

      <!-- pages and pushes on the link -->
      <g
        v-for="packet in PACKETS"
        :key="packet.label"
        :style="{ transform: `translate(60px, ${packet.path(step).y}px)` }"
        :class="{ 'f-hidden': packet.path(step).hidden }"
      >
        <rect :class="packet.cls" :x="-packet.w / 2" y="-10" :width="packet.w" height="20" rx="10" />
        <text class="f-packet-text" x="0" y="0">{{ packet.label }}</text>
      </g>
      <g :class="{ 'f-hidden': step < 4 }">
        <line class="f-link" x1="100" y1="144" x2="112" y2="156" />
        <line class="f-link" x1="112" y1="144" x2="100" y2="156" />
      </g>

      <!-- what the laptop reports -->
      <text class="f-muted" x="300" y="146">the laptop's sync events</text>
      <text
        v-for="(line, i) in EVENTS"
        :key="i"
        :class="['f-muted', 'f-mono', { 'f-hidden': step < i, 'f-changed': step === i }]"
        x="300"
        :y="168 + i * 20"
      >
        {{ line }}
      </text>
    </template>
  </SyncFigure>
</template>
