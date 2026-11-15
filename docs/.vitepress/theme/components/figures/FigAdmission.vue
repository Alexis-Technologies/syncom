<script setup lang="ts">
// A peer's page through the host's door, in the order the code checks it: the shape of every op,
// the signatures and fingerprints of the whole page, then op by op the stamp's skew, the place in its
// stream (duplicate, gap), the chain, the scope of the record it writes, the host's authorizeWrite
// rule and beforeApply, the apply; then the batch made durable log first, and only then announced.
// One op of the page stops at the scope check — not logged, not relayed — while the others pass.
// Depicts: src/sync/hosting.js (push: the declared scope, `bound`, `authorize`), src/apply.js
// (checkPage, admit, applyOne, persist, announce), src/shape.js (wellFormed), src/signing/sign.js
// (verify), src/sync/rules.js (refuseOps).
import SyncFigure from './SyncFigure.vue';

const steps = [
  'The laptop pushes a page of three ops to the server. Before anything else is read, each must be well formed: its origin, seq, stamp, type and record id.',
  "Signatures are verified and fingerprints taken for the whole page at once. Then op by op: a stamp more than maxSkew ahead of the server's clock is refused (SKEW).",
  'Each op must be the next of its stream: one the server holds is a duplicate, one that skips ahead a gap. Its prev must name the op held before it, or it is EQUIVOCATION.',
  "laptop:9 updates t7, which the server's scope function puts in team:2, outside the laptop's grant. It stops here: not logged, not relayed, a gap in its stream.",
  "The other two pass authorizeWrite, the host's rule, and beforeApply, then apply to their records. An op a rule refuses is still logged, scrubbed, so no stream breaks.",
  'The batch is made durable log first: one append for both ops, then the record files, and the log is told they landed.',
  "Only then are they announced: the change event wakes every client's feed. The push answer tells the laptop: applied 2, outOfScope 1.",
];

const GATES = [
  ['shape', 'wellFormed: ids, seq, ts'],
  ['signature', 'verified, fingerprinted'],
  ['skew', 'ts ≤ now + maxSkew'],
  ['order', 'next seq: no duplicate, no gap'],
  ['chain', 'prev = the fp held at seq − 1'],
  ['scope', 'the record within the grant'],
  ['rule', 'authorizeWrite says yes'],
  ['apply', 'beforeApply, then applyOp'],
  ['persist', 'one log append, then records'],
  ['announce', 'change event, the relay'],
];
const rowY = (i: number) => 26 + i * 27;
// The row the batch has reached at each step, and the rows each step lights.
const REACHED = [0, 2, 4, 5, 7, 8, 9];
const LIT = [[0], [1, 2], [3, 4], [5], [6, 7], [8], [9]];
const SCOPE = 5;

const OPS = [
  { label: 'phone:5', cls: 'f-peer-c', x: 330, refused: false },
  { label: 'laptop:8', cls: 'f-peer-a', x: 420, refused: false },
  { label: 'laptop:9', cls: 'f-peer-a', x: 510, refused: true },
];
const rowOf = (op: (typeof OPS)[number], step: number) => (op.refused ? Math.min(REACHED[step], SCOPE) : REACHED[step]);
</script>

<template>
  <SyncFigure caption="A pushed page at the host: every check in order, one op stopped at the scope" :steps="steps" :key-step="3">
    <template #default="{ step, grad }">
      <!-- the gates, top to bottom -->
      <g v-for="(gate, i) in GATES" :key="gate[0]">
        <rect class="f-cell" x="10" :y="rowY(i) - 11" width="545" height="22" rx="6" />
        <text :class="['f-text', { 'f-changed': LIT[step].includes(i) }]" x="22" :y="rowY(i) + 4">{{ gate[0] }}</text>
        <text class="f-muted" x="96" :y="rowY(i) + 4">{{ gate[1] }}</text>
      </g>

      <!-- the page's three ops -->
      <g
        v-for="op in OPS"
        :key="op.label"
        :style="{ transform: `translate(${op.x}px, ${rowY(rowOf(op, step))}px)` }"
      >
        <rect :class="op.cls" x="-35" y="-9" width="70" height="18" rx="9" />
        <text class="f-packet-text" x="0" y="0">{{ op.label }}</text>
      </g>
      <g :class="{ 'f-hidden': step < 3 }">
        <line class="f-link" :x1="551" :y1="rowY(SCOPE) - 6" :x2="563" :y2="rowY(SCOPE) + 6" />
        <line class="f-link" :x1="563" :y1="rowY(SCOPE) - 6" :x2="551" :y2="rowY(SCOPE) + 6" />
      </g>

      <!-- the host -->
      <circle class="f-node" cx="642" cy="50" r="28" :fill="grad" />
      <text class="f-node-text" x="642" y="50">server</text>
      <text class="f-muted" x="642" y="96" text-anchor="middle">pushed by the laptop</text>
      <text class="f-muted" x="585" y="128">server's log</text>
      <rect class="f-cell" x="585" y="136" width="16" height="16" rx="3" />
      <rect class="f-cell" x="605" y="136" width="16" height="16" rx="3" />
      <rect class="f-cell" x="625" y="136" width="16" height="16" rx="3" />
      <rect class="f-cell" x="645" y="136" width="16" height="16" rx="3" />
      <rect :class="['f-peer-c', { 'f-hidden': step < 5 }]" x="665" y="136" width="16" height="16" rx="3" />
      <rect :class="['f-peer-a', { 'f-hidden': step < 5 }]" x="685" y="136" width="16" height="16" rx="3" />

      <g :class="{ 'f-hidden': step < 6 }">
        <rect class="f-card" x="575" y="172" width="135" height="64" rx="8" />
        <text class="f-muted" x="587" y="192">push answer</text>
        <text class="f-text f-mono" x="587" y="211">applied 2</text>
        <text class="f-text f-mono" x="587" y="228">outOfScope 1</text>
        <text class="f-muted" x="580" y="273">→ every client's feed</text>
      </g>
    </template>
  </SyncFigure>
</template>
