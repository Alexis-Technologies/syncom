<script setup lang="ts">
// The audit chain: every batch the node applies adds a block naming the previous block's hash and the hash
// of each record's data, and each record file names its block. validate() walks the blocks back re-hashing
// them; a record edited on disk no longer matches its block, so a read from the file throws INTEGRITY, and
// repair(id) rebuilds it from the log.
// Depicts: src/chain/chain.js (a block `{ prev, timestamp, data }` filed under its hash, validate() walking
// back to the genesis), src/database.js (#persistBatch: one block a batch; validate(id, data, block); #repair
// from the first whole-record op), src/entries.js (a record file names its block and is checked on a cold
// read, INTEGRITY), src/commit.js (a local write's block).
import SyncFigure from './SyncFigure.vue';

const steps = [
  'With the chain plugin, every batch this node applies adds a block: the previous block’s hash and the hash of each record’s data. Its name is its own hash.',
  'A peer’s page of ops lands as one batch, so one block holds the hashes of both records it touched, and each of their files names that block.',
  'validate() walks back from the tail: it re-hashes each block, checks it hashes to the name it is filed under, and follows prev down to the genesis.',
  'Someone edits task.json on disk: votes 3 becomes 9. No block changed, so validate() still answers true, but the record no longer matches its block.',
  'A read from the file hashes the task’s data and compares it with what block 7c41 recorded. They differ: the read rejects with INTEGRITY, not the edited data.',
  'repair(id) replays the record from the log, from its first whole-record op, and writes it again with a block of its own.',
];

const BLOCKS = [
  { x: 60, name: 'genesis', prev: 'prev 0', holds: '' },
  { x: 230, name: 'block 7c41', prev: 'prev a0f3', holds: 'task e9b2' },
  { x: 400, name: 'block d15e', prev: 'prev 7c41', holds: 'note 3a07, plan 52cc' },
  { x: 570, name: 'block f80b', prev: 'prev d15e', holds: 'task e9b2' },
];
const blockShown = (i: number, step: number) => i <= 1 || (i === 2 && step >= 1) || (i === 3 && step >= 5);
const tail = (step: number) => (step >= 5 ? 3 : step >= 1 ? 2 : 1);
const votes = (step: number) => (step === 3 || step === 4 ? 9 : 3);
const taskBlock = (step: number) => (step >= 5 ? 'block f80b' : 'block 7c41');
</script>

<template>
  <SyncFigure
    caption="Each batch adds a block naming the one before; a record edited on disk no longer matches its block"
    :steps="steps"
    :key-step="4"
  >
    <template #default="{ step }">
      <text class="f-muted" x="60" y="22">the laptop’s chain</text>

      <!-- the blocks -->
      <g v-for="(b, i) in BLOCKS" :key="b.name" :class="{ 'f-hidden': !blockShown(i, step) }">
        <rect class="f-card" :x="b.x" y="40" width="140" height="74" rx="10" />
        <text class="f-text f-mono" :x="b.x + 12" y="61">{{ b.name }}</text>
        <text class="f-muted f-mono" :x="b.x + 12" y="82">{{ b.prev }}</text>
        <text class="f-muted f-mono" :x="b.x + 12" y="102">{{ b.holds }}</text>
        <g v-if="i > 0">
          <line class="f-link" :x1="b.x - 4" y1="77" :x2="b.x - 26" y2="77" />
          <path class="f-link" :d="`M ${b.x - 19} 71 L ${b.x - 26} 77 L ${b.x - 19} 83`" />
        </g>
        <g :class="{ 'f-hidden': step !== 2 || i > 2 }">
          <rect class="f-ok" :x="b.x + 104" y="32" width="28" height="16" rx="8" />
          <text class="f-packet-text" :x="b.x + 118" y="40">ok</text>
        </g>
      </g>
      <text class="f-muted" :x="BLOCKS[tail(step)].x + 70" y="34" text-anchor="middle">tail</text>
      <text :class="['f-text', 'f-mono', { 'f-hidden': step < 2 || step > 3 }]" x="640" y="81" text-anchor="middle">
        validate() → true
      </text>

      <!-- the record files -->
      <text class="f-muted" x="40" y="156">record files</text>
      <line :class="['f-link', 'f-link-off', { 'f-hidden': step >= 5 }]" x1="140" y1="166" x2="300" y2="116" />
      <line :class="['f-link', 'f-link-off', { 'f-hidden': step < 5 }]" x1="140" y1="166" x2="640" y2="116" />
      <rect class="f-card" x="40" y="166" width="200" height="72" rx="10" />
      <text class="f-text f-mono" x="54" y="187">data/task.json</text>
      <text class="f-muted" x="54" y="207">votes</text>
      <text :class="['f-text', 'f-mono', { 'f-changed': step === 3 || step === 5 }]" x="98" y="207">{{ votes(step) }}</text>
      <text :class="['f-muted', 'f-mono', { 'f-changed': step === 5 }]" x="54" y="227">{{ taskBlock(step) }}</text>

      <g :class="{ 'f-hidden': step < 1 }">
        <rect class="f-card" x="300" y="166" width="160" height="72" rx="10" />
        <text class="f-text f-mono" x="314" y="187">data/note.json</text>
        <text class="f-muted f-mono" x="314" y="227">block d15e</text>
        <rect class="f-card" x="480" y="166" width="160" height="72" rx="10" />
        <text class="f-text f-mono" x="494" y="187">data/plan.json</text>
        <text class="f-muted f-mono" x="494" y="227">block d15e</text>
      </g>

      <!-- the read that fails -->
      <g :class="{ 'f-hidden': step !== 4 }">
        <text class="f-changed f-text f-mono" x="40" y="266">INTEGRITY</text>
        <text class="f-muted" x="118" y="266">the data hashes to 41aa; block 7c41 recorded e9b2</text>
      </g>
    </template>
  </SyncFigure>
</template>
