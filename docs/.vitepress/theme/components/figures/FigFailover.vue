<script setup lang="ts">
// The leader's tab closes: the next tab is granted the lock, opens the database as the leader beside its
// follower, moves the facade and every live thing to it, counts its generation up and only then closes the
// follower. It is the same node — the same id, log and peers — so the server sees a reconnect. A follower's
// write that reached no leader is tried again at the new one; a call is never run twice.
// Depicts: src/shared/election.js (Web Locks: the lock goes with the tab, the next in line is granted it),
// src/shared/shared.js (#promote: the writer opened beside the follower, #db moved, generation counted up,
// #rebind, 'leader', the follower closed; #forward: a call `{ id, args, retry }` tried again within
// `failover`, CALL_UNKNOWN as LEADER_LOST with maybeApplied), src/shared/channel.js (the call and its answer
// as values).
import SyncFigure from './SyncFigure.vue';

const steps = [
  'Three tabs share the board. Tab 1 holds the lock and leads: it opened the database for writing and alone dials the server. Tabs 2 and 3 follow, read-only.',
  'Tab 1 closes, and its lock goes with it. Tab 3 forwards a write just then: the dial reaches no leader, so nothing was sent, and the write waits for one.',
  'The browser grants the lock to tab 2. It opens the database as the leader beside its follower: the follower holds no lock, so both stand for a moment.',
  "Tab 2 moves shared.db to the new instance, counts generation up, makes every live document and query again, says 'leader', and only then closes its follower.",
  'Same node id, same log, same peers: the server sees a reconnect, not a new node. Tab 3 dials again, and its write runs at the new leader, within failover ms.',
  'A call never runs twice. Tried again where it was seen, it is answered from what that leader kept; one the old leader may have run fails as LEADER_LOST, maybeApplied: true.',
];

const TABS = [20, 210, 400];
const W = 170;
const cx = (i: number) => TABS[i] + W / 2;
// A tab's role at a step: the leader's badge, or a word.
const leads = (i: number, step: number) => (i === 0 && step === 0) || (i === 1 && step >= 3);
const role = (i: number, step: number) => {
  if (i === 0 && step === 1) return 'closing';
  if (i === 1 && step === 2) return 'granted the lock';
  return 'follower';
};
const generation = (i: number, step: number) => (i === 1 && step >= 3 ? 1 : 0);
// The instances a tab holds: the writer (the leader's database) and the read-only follower, side by side
// while tab 2 promotes.
const writer = (i: number, step: number) => {
  if (i === 0) return { shown: step <= 1, x: cx(0) };
  if (i === 1) return { shown: step >= 2, x: step === 2 ? cx(1) + 41 : cx(1) };
  return { shown: false, x: cx(2) };
};
const follower = (i: number, step: number) => {
  if (i === 0) return { shown: false, x: cx(0) };
  if (i === 1) return { shown: step <= 2, x: step === 2 ? cx(1) - 41 : cx(1) };
  return { shown: true, x: cx(2) };
};
// Tab 3's write and the answer, on the followers' channel.
const callAt = (step: number) => (step >= 4 ? cx(1) + 36 : cx(2) - 46);
const callNote = (step: number) => (step >= 1 && step <= 3 ? 'waits for a leader' : step === 5 ? 'answered, once' : '');
</script>

<template>
  <SyncFigure
    caption="When the leader's tab closes, the next tab opens the database as the same node and takes over its writes"
    :steps="steps"
    :key-step="3"
  >
    <template #default="{ step, grad }">
      <!-- the server, dialed by the leader alone -->
      <circle class="f-node" cx="650" cy="108" r="28" :fill="grad" />
      <text class="f-node-text" x="650" y="108">server</text>
      <path :class="['f-link', { 'f-hidden': step > 1, 'f-link-off': step === 1 }]" :d="`M ${cx(0)} 40 V 14 H 650 V 80`" />
      <path :class="['f-link', { 'f-hidden': step < 4 }]" :d="`M ${cx(1)} 40 V 14 H 650 V 80`" />
      <text :class="['f-muted', { 'f-hidden': step === 2 || step === 3 }]" x="640" y="30" text-anchor="end">one connection</text>
      <text :class="['f-muted', { 'f-hidden': step < 4, 'f-changed': step === 4 }]" x="650" y="156" text-anchor="middle">
        a reconnect, same node
      </text>

      <!-- the tabs -->
      <g v-for="(x, i) in TABS" :key="i" :class="{ 'f-hidden': i === 0 && step >= 2 }">
        <rect class="f-card" :x="x" y="40" :width="W" height="136" rx="10" />
        <rect class="f-cell" :x="x" y="40" :width="W" height="26" rx="10" />
        <text class="f-label" :x="cx(i)" y="58">tab {{ i + 1 }}</text>
        <g :class="{ 'f-hidden': !leads(i, step) }">
          <rect class="f-ok" :x="cx(i) - 34" y="76" width="68" height="20" rx="10" />
          <text class="f-packet-text" :x="cx(i)" y="86">leader</text>
        </g>
        <text
          :class="['f-muted', { 'f-hidden': leads(i, step), 'f-changed': role(i, step) !== 'follower' }]"
          :x="cx(i)"
          y="90"
          text-anchor="middle"
        >
          {{ role(i, step) }}
        </text>
        <g
          :class="{ 'f-hidden': !follower(i, step).shown }"
          :style="{ transform: `translate(${follower(i, step).x}px, 117px)` }"
        >
          <rect class="f-card" x="-37" y="-13" width="74" height="26" rx="6" />
          <text class="f-text" x="0" y="4" text-anchor="middle">read-only</text>
        </g>
        <g :class="{ 'f-hidden': !writer(i, step).shown }" :style="{ transform: `translate(${writer(i, step).x}px, 117px)` }">
          <rect class="f-card f-stroke-a" x="-37" y="-13" width="74" height="26" rx="6" />
          <text :class="['f-text', { 'f-changed': i === 1 && step === 2 }]" x="0" y="4" text-anchor="middle">writer</text>
        </g>
        <text
          :class="['f-muted', { 'f-changed': i === 1 && step === 3 }]"
          :x="cx(i)"
          y="160"
          text-anchor="middle"
        >
          generation {{ generation(i, step) }}
        </text>
      </g>
      <text :class="['f-muted', { 'f-hidden': step < 2 }]" :x="cx(0)" y="112" text-anchor="middle">tab 1 closed</text>

      <!-- the followers' channel to the leader -->
      <path :class="['f-link', { 'f-hidden': step >= 2 }]" :d="`M ${cx(0)} 176 V 200 H ${cx(1)}`" />
      <path class="f-link" :d="`M ${cx(1)} 176 V 200 H ${cx(2)} V 176`" />
      <text class="f-muted" x="330" y="225" text-anchor="middle">the followers’ channel</text>
      <g
        :class="{ 'f-hidden': step < 1 || step === 5 }"
        :style="{ transform: `translate(${callAt(step)}px, 200px)` }"
      >
        <rect class="f-peer-c" x="-36" y="-10" width="72" height="20" rx="10" />
        <text class="f-packet-text" x="0" y="0">write #7</text>
      </g>
      <g :class="{ 'f-hidden': step !== 5 }" :style="{ transform: `translate(${step === 5 ? cx(2) - 46 : cx(1) + 36}px, 200px)` }">
        <rect class="f-peer-b" x="-36" y="-10" width="72" height="20" rx="10" />
        <text class="f-packet-text" x="0" y="0">answer</text>
      </g>
      <text :class="['f-muted', { 'f-hidden': callNote(step) === '' }]" :x="cx(2)" y="222" text-anchor="middle">
        {{ callNote(step) }}
      </text>

      <!-- one database, one node -->
      <rect class="f-card" x="230" y="234" width="260" height="56" rx="10" />
      <text class="f-label" x="360" y="256">IndexedDB 'board'</text>
      <text class="f-muted" x="360" y="276" text-anchor="middle">one node id, one log, one list of peers</text>
    </template>
  </SyncFigure>
</template>
