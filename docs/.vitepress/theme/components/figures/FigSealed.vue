<script setup lang="ts">
// A sealed record stays on its node: the laptop writes a plain task, whose op reaches the server, and a task
// with `{ encrypted: true }`, sealed for the laptop's key and written to its record file with no op, so
// nothing of it travels. `atRest()` is the other tool: every value the node stores is ciphertext, while its
// ops still sync as plain data.
// Depicts: src/commit.js (commitSealed and seal: an encrypted write outside the op log),
// src/encryption/encryption.js (the sealing plugin's RSA envelope, atRest), src/entries.js (writeSealed: the
// record file holds the envelope), src/encryption/at-rest-engine.js (every stored value sealed at its place).
import SyncFigure from './SyncFigure.vue';

const steps = [
  'The laptop dials the server. You write a task as usual: it is an op in the laptop’s log, and its record file holds the data.',
  'The op travels to the server, which applies it. The task is on both nodes.',
  'You write a second task with { encrypted: true }. It is sealed for this node’s RSA key and written straight to its record file: no op is logged.',
  'So nothing travels. The server never sees the sealed task, and no snapshot carries it; on the laptop it reads and queries like any other record.',
  'atRest() is the other tool: every value the laptop stores, the log and the catalog too, is ciphertext under your key, while its ops still sync as plain data.',
];

const X = { laptop: 90, server: 630 };
const Y = 60;
const PANEL = { laptop: 20, server: 390 };
const atRest = (step: number) => step >= 4;
</script>

<template>
  <SyncFigure caption="A sealed record makes no op and never leaves its node; atRest() encrypts what a node stores" :steps="steps" :key-step="3">
    <template #default="{ step, grad }">
      <line class="f-link" :x1="X.laptop + 30" :y1="Y" :x2="X.server - 30" :y2="Y" />
      <g v-for="(x, node) in X" :key="node">
        <circle class="f-node" :cx="x" :cy="Y" r="30" :fill="grad" />
        <text class="f-node-text" :x="x" :y="Y">{{ node }}</text>
      </g>
      <text :class="['f-muted', { 'f-hidden': step !== 3 }]" x="360" y="48" text-anchor="middle">no op, nothing to send</text>

      <!-- each node's storage -->
      <g v-for="(x, node) in PANEL" :key="`panel-${node}`">
        <rect class="f-card" :x="x" y="104" width="310" height="168" rx="12" />
        <text class="f-muted" :x="x + 14" y="126">the {{ node }}’s storage</text>
        <text class="f-muted" :x="x + 14" y="231">log</text>
        <rect class="f-cell" :x="x + 46" y="218" width="18" height="16" rx="3" />
        <rect class="f-cell" :x="x + 68" y="218" width="18" height="16" rx="3" />
        <rect
          :class="['f-peer-a', { 'f-hidden': node === 'laptop' ? false : step < 1 }]"
          :x="x + 90"
          y="218"
          width="18"
          height="16"
          rx="3"
        />
      </g>

      <!-- the plain task, on the laptop and, once its op arrived, on the server -->
      <rect class="f-cell" :x="PANEL.laptop + 14" y="138" width="136" height="60" rx="8" />
      <text class="f-text f-mono" :x="PANEL.laptop + 26" y="160">t1</text>
      <text :class="['f-text', { 'f-mono': atRest(step), 'f-changed': step === 4 }]" :x="PANEL.laptop + 26" y="184">
        {{ atRest(step) ? 'enc1:Qm9x…' : 'Ship it' }}
      </text>
      <g :class="{ 'f-hidden': step < 1 }">
        <rect class="f-cell" :x="PANEL.server + 14" y="138" width="136" height="60" rx="8" />
        <text class="f-text f-mono" :x="PANEL.server + 26" y="160">t1</text>
        <text class="f-text" :x="PANEL.server + 26" y="184">Ship it</text>
      </g>

      <!-- the sealed task, on the laptop alone -->
      <g :class="{ 'f-hidden': step < 2 }">
        <rect class="f-cell" :x="PANEL.laptop + 160" y="138" width="136" height="60" rx="8" />
        <text class="f-text f-mono" :x="PANEL.laptop + 172" y="160">t2</text>
        <text :class="['f-text', 'f-mono', { 'f-changed': step === 2 }]" :x="PANEL.laptop + 172" y="184">sealed 9Zq…</text>
        <text :class="['f-muted', { 'f-hidden': step > 3 }]" :x="PANEL.laptop + 118" y="231">no op for t2</text>
      </g>
      <text :class="['f-changed', 'f-text', { 'f-hidden': !atRest(step) }]" :x="PANEL.laptop + 14" y="258">
        atRest: every stored value is ciphertext
      </text>
      <text :class="['f-muted', { 'f-hidden': !atRest(step) }]" :x="PANEL.server + 14" y="258">what arrived here was plain data</text>

      <!-- the plain task's op on its way -->
      <g :class="{ 'f-hidden': step !== 1 }" :style="{ transform: `translate(${step >= 1 ? 520 : 200}px, ${Y}px)` }">
        <rect class="f-peer-a" x="-36" y="-10" width="72" height="20" rx="10" />
        <text class="f-packet-text" x="0" y="0">write t1</text>
      </g>
    </template>
  </SyncFigure>
</template>
