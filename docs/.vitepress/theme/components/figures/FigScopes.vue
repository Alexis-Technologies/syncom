<script setup lang="ts">
// Partial sync by scope: the scope function puts each record in a scope; the phone's hello asks for
// team:1 and the host grants it; the snapshot and the feed carry team:1 and the global scope only; an
// op the phone pushes for a record the host scopes elsewhere is refused (outOfScope, not logged, not
// relayed); a revoke ends the old grant's feed, tells the phone, and the phone forgets the records of
// that scope locally, with no op.
// Depicts: src/scope.js (inScope), src/commit.js (scopeData, assignScope), src/sync/hosting.js
// (greet, push, changes), src/sync/rules.js (grant), src/apply.js (outOfBounds),
// src/sync/manager.js (revoke, #revoked, #forgetScopes).
import SyncFigure from './SyncFigure.vue';

const steps = [
  "Your scope function puts every record in a scope: t1 and t2 in team:1, t3 in team:2, the board's settings in the global scope '*', which every node receives.",
  "The phone is registered with scopes: ['team:1']. Its hello asks for them and the server grants them; your authorize rule could refuse the hello instead.",
  'The snapshot and the feed carry team:1 and the global scope only: the phone gets t1, t2 and the settings. t3 never reaches it.',
  'You update t3 on the phone by its id. The phone holds no t3, so its op looks global, but the server scopes t3 as it holds it, in team:2, and refuses the op as outOfScope.',
  "Later you call sync.revoke() on the server for the phone's team:1. The feed opened under the old grant ends, and the server tells the phone which scopes it took back.",
  'The phone reports REVOKED and forgets t1 and t2: their files, catalog rows and log payloads, with no op, so nothing reaches the server. The settings stay.',
];

const BOX = { team1: 100, team2: 168, global: 236 };
const SERVER_X = 20;
const PHONE_X = 520;
type Chip = { id: string; scope: keyof typeof BOX; dx: number; w: number; toPhone: boolean };
const CHIPS: Chip[] = [
  { id: 't1', scope: 'team1', dx: 12, w: 70, toPhone: true },
  { id: 't2', scope: 'team1', dx: 92, w: 70, toPhone: true },
  { id: 't3', scope: 'team2', dx: 12, w: 70, toPhone: false },
  { id: 'settings', scope: 'global', dx: 12, w: 84, toPhone: true },
];
const COPIES = CHIPS.filter((chip) => chip.toPhone);
// A copy of a chip on the phone: on its way from the server's box, there, or forgotten.
const copyAt = (chip: Chip, step: number) => {
  const there = step >= 2;
  const forgotten = step >= 5 && chip.scope === 'team1';
  return { x: there ? PHONE_X - SERVER_X : 0, hidden: !there || forgotten };
};

const NOTES = [
  'scope(t1) = team:1, scope(t3) = team:2',
  "the phone's grant: team:1, and * for all",
  'snapshot and feed: team:1 and *',
  't3 is team:2 here: outside the grant',
  'the feed of the old grant ends',
  'REVOKED: t1 and t2 forgotten, no op sent',
];

type At = { x: number; hidden: boolean };
const PACKETS: { label: string; cls: string; w: number; path: (step: number) => At }[] = [
  {
    label: "scopes: ['team:1']",
    cls: 'f-peer-c',
    w: 128,
    path: (s) => (s === 0 ? { x: 520, hidden: true } : s === 1 ? { x: 220, hidden: false } : { x: 130, hidden: true }),
  },
  {
    label: 'set t3',
    cls: 'f-peer-c',
    w: 56,
    path: (s) => (s <= 2 ? { x: 560, hidden: true } : { x: 250, hidden: s !== 3 }),
  },
  {
    label: 'revoke team:1',
    cls: 'f-peer-b',
    w: 100,
    path: (s) => (s <= 3 ? { x: 160, hidden: true } : s === 4 ? { x: 550, hidden: false } : { x: 640, hidden: true }),
  },
];
</script>

<template>
  <SyncFigure caption="Scopes: a node gets the records it was granted, writes only those, and forgets them on a revoke" :steps="steps" :key-step="3">
    <template #default="{ step, grad }">
      <line class="f-link" x1="98" y1="50" x2="622" y2="50" />
      <circle class="f-node" cx="70" cy="50" r="28" :fill="grad" />
      <text class="f-node-text" x="70" y="50">server</text>
      <circle class="f-node" cx="650" cy="50" r="28" :fill="grad" />
      <text class="f-node-text" x="650" y="50">phone</text>

      <!-- the server's records, by scope -->
      <rect class="f-cell" :x="SERVER_X" :y="BOX.team1" width="180" height="58" rx="8" />
      <rect class="f-cell" :x="SERVER_X" :y="BOX.team2" width="180" height="58" rx="8" />
      <rect class="f-cell" :x="SERVER_X" :y="BOX.global" width="180" height="58" rx="8" />
      <text :class="['f-muted', { 'f-changed': step === 0 }]" :x="SERVER_X + 12" :y="BOX.team1 + 16">team:1</text>
      <text :class="['f-muted', { 'f-changed': step === 0 }]" :x="SERVER_X + 12" :y="BOX.team2 + 16">team:2</text>
      <text :class="['f-muted', { 'f-changed': step === 0 }]" :x="SERVER_X + 12" :y="BOX.global + 16">* (global)</text>
      <g v-for="chip in CHIPS" :key="chip.id">
        <rect class="f-card" :x="SERVER_X + chip.dx" :y="BOX[chip.scope] + 24" :width="chip.w" height="26" rx="6" />
        <text class="f-text f-mono" :x="SERVER_X + chip.dx + chip.w / 2" :y="BOX[chip.scope] + 41" text-anchor="middle">
          {{ chip.id }}
        </text>
      </g>

      <!-- what the phone holds -->
      <g :class="{ 'f-hidden': step < 1 }">
        <rect class="f-cell" :x="PHONE_X" :y="BOX.team1" width="180" height="58" rx="8" />
        <rect class="f-card f-link-off" :x="PHONE_X" :y="BOX.team2" width="180" height="58" rx="8" />
        <rect class="f-cell" :x="PHONE_X" :y="BOX.global" width="180" height="58" rx="8" />
        <text :class="['f-muted', { 'f-changed': step === 5 }]" :x="PHONE_X + 12" :y="BOX.team1 + 16">
          {{ step >= 5 ? 'team:1: revoked' : 'team:1' }}
        </text>
        <text class="f-muted" :x="PHONE_X + 12" :y="BOX.team2 + 16">team:2: not granted</text>
        <text class="f-muted" :x="PHONE_X + 12" :y="BOX.global + 16">* (global)</text>
      </g>
      <g
        v-for="chip in COPIES"
        :key="chip.id"
        :style="{ transform: `translate(${copyAt(chip, step).x}px, 0px)` }"
        :class="{ 'f-hidden': copyAt(chip, step).hidden }"
      >
        <rect class="f-card" :x="SERVER_X + chip.dx" :y="BOX[chip.scope] + 24" :width="chip.w" height="26" rx="6" />
        <text class="f-text f-mono" :x="SERVER_X + chip.dx + chip.w / 2" :y="BOX[chip.scope] + 41" text-anchor="middle">
          {{ chip.id }}
        </text>
      </g>

      <!-- on the link -->
      <g
        v-for="packet in PACKETS"
        :key="packet.label"
        :style="{ transform: `translate(${packet.path(step).x}px, 50px)` }"
        :class="{ 'f-hidden': packet.path(step).hidden }"
      >
        <rect :class="packet.cls" :x="-packet.w / 2" y="-10" :width="packet.w" height="20" rx="10" />
        <text class="f-packet-text" x="0" y="0">{{ packet.label }}</text>
      </g>
      <g :class="{ 'f-hidden': step !== 3 }">
        <line class="f-link" x1="199" y1="44" x2="211" y2="56" />
        <line class="f-link" x1="211" y1="44" x2="199" y2="56" />
        <text class="f-muted" x="250" y="80" text-anchor="middle">refused: outOfScope</text>
      </g>
      <text :class="['f-muted', { 'f-hidden': step < 1, 'f-changed': step === 4 }]" x="430" y="80" text-anchor="middle">
        {{ step >= 4 ? 'revoked: team:1' : 'granted: team:1' }}
      </text>

      <text :class="['f-text', 'f-mono', { 'f-hidden': step !== 4 }]" x="360" y="122" text-anchor="middle">
        server.sync.revoke(phone, ['team:1'])
      </text>
      <text class="f-muted" x="360" y="150" text-anchor="middle">{{ NOTES[step] }}</text>
    </template>
  </SyncFigure>
</template>
