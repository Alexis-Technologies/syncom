<script setup lang="ts">
// Schema versions: a record written under version 1 is read through the lens as version 2 (the migrations
// from its version up, then the entity's validator) without being written; a write to it migrates it first —
// one `version` op carrying what the lens changed — and a node on version 1 keeps syncing and applies the newer
// ops as written; migrate() does the same for the records nobody wrote to.
// Depicts: src/schema/lens.js (the migrations from the record's version, then the validator; nothing
// written), src/schema/api.js (migrateRecord: the names the lens removed and the registers it wrote, as one
// `version` op; migrate() per record), src/commit.js (a local field op on an older record migrates it first, in
// one transaction), src/apply.js (an op from a newer version applied as it is, the `schema` event of kind
// `ahead`), src/ops.js (the version a record is of, in its meta).
import SyncFigure from './SyncFigure.vue';

const steps = [
  'The phone runs schema version 1 and the server version 2, where a task’s title is called name. Both hold a task written under v1: { title }, with its version.',
  'On the server, get() reads it through the lens: the migration to 2 renames title to name, then the entity’s validator runs if it has one. The stored record does not change.',
  'The server marks the task done. The write migrates the task first, in one transaction: an op that says the task is of v2 and carries what the lens changed (title removed, name written), then the op with the one field. The stored record now holds name.',
  'Both are ordinary ops, so they reach the phone, which applies them as written, with a schema event of kind ahead, and reads name, not title. Nothing else of the task was written, so what the phone did to its other fields meanwhile still merges.',
  'A task nobody writes to stays as it was stored. migrate() on the server migrates each of those the same way, one op per record. Run it on one node, once the nodes that write have upgraded.',
];

const X = { server: 90, phone: 630 };
const Y = 56;
const serverField = (step: number) => (step >= 2 ? 'name' : 'title');
const phoneField = (step: number) => (step >= 3 ? 'name' : 'title');
const MESSAGES = [
  { step: 3, label: 'version · set' },
  { step: 4, label: 'version · v 2' },
];
</script>

<template>
  <SyncFigure caption="A record written under an older schema is read through the lens; nodes on two versions keep syncing" :steps="steps" :key-step="2">
    <template #default="{ step, grad }">
      <line class="f-link" :x1="X.server + 28" :y1="Y" :x2="X.phone - 28" :y2="Y" />
      <circle class="f-node" :cx="X.server" :cy="Y" r="28" :fill="grad" />
      <text class="f-node-text" :x="X.server" :y="Y">server</text>
      <text class="f-muted" :x="X.server + 38" :y="Y - 34">schema v2</text>
      <circle class="f-node" :cx="X.phone" :cy="Y" r="28" :fill="grad" />
      <text class="f-node-text" :x="X.phone" :y="Y">phone</text>
      <text class="f-muted" :x="X.phone - 38" :y="Y - 34" text-anchor="end">schema v1</text>

      <!-- the server: stored, the lens, what get() reads -->
      <text class="f-muted" x="20" y="102">stored</text>
      <rect class="f-card" x="20" y="110" width="230" height="56" rx="10" />
      <text class="f-muted" x="34" y="133">{{ serverField(step) }}</text>
      <text :class="['f-text', { 'f-changed': step === 2 }]" x="84" y="133">Ship it</text>
      <g :class="{ 'f-hidden': step < 2 }">
        <text class="f-muted" x="34" y="155">done</text>
        <text :class="['f-text', 'f-mono', { 'f-changed': step === 2 }]" x="84" y="155">true</text>
      </g>
      <text :class="['f-muted', 'f-mono', { 'f-changed': step === 2 }]" x="236" y="133" text-anchor="end">v {{ step >= 2 ? 2 : 1 }}</text>

      <g :class="{ 'f-hidden': step < 1 }">
        <line class="f-link" x1="135" y1="168" x2="135" y2="178" />
        <rect class="f-cell" x="30" y="180" width="210" height="24" rx="12" />
        <text class="f-text" x="135" y="196" text-anchor="middle">
          {{ step >= 2 ? 'already v 2: read as stored' : 'lens: migration 2, validator' }}
        </text>
        <line class="f-link" x1="135" y1="206" x2="135" y2="216" />
        <rect class="f-card" x="20" y="218" width="230" height="56" rx="10" />
        <text class="f-muted f-mono" x="236" y="241" text-anchor="end">get()</text>
        <text class="f-muted" x="34" y="241">name</text>
        <text :class="['f-text', { 'f-changed': step === 1 }]" x="84" y="241">Ship it</text>
        <g :class="{ 'f-hidden': step < 2 }">
          <text class="f-muted" x="34" y="263">done</text>
          <text class="f-text f-mono" x="84" y="263">true</text>
        </g>
      </g>

      <!-- the phone: stored and read as is -->
      <text class="f-muted" x="470" y="102">stored, read as written</text>
      <rect class="f-card" x="470" y="110" width="230" height="56" rx="10" />
      <text class="f-muted" x="484" y="133">{{ phoneField(step) }}</text>
      <text :class="['f-text', { 'f-changed': step === 3 }]" x="534" y="133">Ship it</text>
      <g :class="{ 'f-hidden': step < 3 }">
        <text class="f-muted" x="484" y="155">done</text>
        <text :class="['f-text', 'f-mono', { 'f-changed': step === 3 }]" x="534" y="155">true</text>
      </g>
      <text :class="['f-muted', 'f-mono', { 'f-changed': step === 3 }]" x="686" y="133" text-anchor="end">v {{ step >= 3 ? 2 : 1 }}</text>
      <text :class="['f-muted', { 'f-hidden': step !== 3 }]" x="470" y="188">schema event: ahead</text>

      <!-- the server's ops on their way -->
      <g
        v-for="m in MESSAGES"
        :key="m.label"
        :class="{ 'f-hidden': step !== m.step }"
        :style="{ transform: `translate(${step >= m.step ? 520 : 200}px, ${Y}px)` }"
      >
        <rect class="f-peer-b" x="-52" y="-10" width="104" height="20" rx="10" />
        <text class="f-packet-text" x="0" y="0">{{ m.label }}</text>
      </g>
    </template>
  </SyncFigure>
</template>
