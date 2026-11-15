<script setup lang="ts">
// An attachment: the bytes go into the engine's blobs store under their SHA-256, and the record gets a
// register naming them, which replicates as an op. The bytes do not travel with it: a node that reads the
// attachment asks the host it dials, checks the answer against the digest and keeps it; a node that never
// reads it never downloads it.
// Depicts: src/attachments/attachments.js (put: the blob, then the `_attachments/<name>` register; get: the
// fetch where the bytes are missing), src/blobs.js (a blob by digest), src/sync/manager.js (fetchBlob: the
// peers asked, the hash checked, the bytes kept once), src/sync/reads.js (the host's `blob` answer to a peer
// that names the record).
import SyncFigure from './SyncFigure.vue';

const steps = [
  'On the server, you put(id, ‘mockup.png’, bytes). The bytes go into the engine’s blobs store under their SHA-256: the same bytes are one blob, whoever names them.',
  'Then the record gets the register _attachments/mockup.png = { digest, type, length }: an ordinary field write, an op in the log.',
  'The op reaches the laptop and the phone. Both read the register, but neither holds the bytes: a phone syncing a thousand records downloads no photo.',
  'You call get(id, ‘mockup.png’) on the phone. It lacks the bytes, so it asks the host it dials: syncom/blob with the digest, the record id and the name.',
  'The server answers the bytes. The phone hashes them and keeps them only if the hash is the digest; a peer that answers other bytes is not believed.',
  'The laptop never read the attachment, so it holds no bytes. An attachment reaches a node when that node reads it, not before.',
];

const X = { laptop: 110, server: 360, phone: 610 };
const Y = 80;
type Node = 'laptop' | 'server' | 'phone';
const named = (node: Node, step: number) => (node === 'server' ? step >= 1 : step >= 2);
const namedNow = (node: Node, step: number) => (node === 'server' ? step === 1 : step === 2);
const holds = (node: Node, step: number) => node === 'server' || (node === 'phone' && step >= 4);
</script>

<template>
  <SyncFigure
    caption="An attachment's name replicates as a field; its bytes are fetched by digest when a node reads them"
    :steps="steps"
    :key-step="4"
  >
    <template #default="{ step, grad }">
      <line class="f-link" :x1="X.laptop + 30" :y1="Y" :x2="X.server - 30" :y2="Y" />
      <line class="f-link" :x1="X.server + 30" :y1="Y" :x2="X.phone - 30" :y2="Y" />

      <g v-for="(x, node) in X" :key="node">
        <circle class="f-node" :cx="x" :cy="Y" r="30" :fill="grad" />
        <text class="f-node-text" :x="x" :y="Y">{{ node }}</text>

        <rect class="f-card" :x="x - 92" y="130" width="184" height="62" rx="10" />
        <text class="f-muted" :x="x - 78" y="154">title</text>
        <text class="f-text" :x="x - 40" y="154">Design review</text>
        <g :class="{ 'f-hidden': !named(node, step) }">
          <text class="f-muted" :x="x - 78" y="178">mockup.png</text>
          <text :class="['f-text', 'f-mono', { 'f-changed': namedNow(node, step) }]" :x="x - 10" y="178">4c4b… png</text>
        </g>

        <text class="f-muted" :x="x - 92" y="226">blobs</text>
        <rect class="f-cell" :x="x - 52" y="212" width="104" height="22" rx="5" />
        <text :class="['f-muted', { 'f-hidden': holds(node, step) }]" :x="x" y="227" text-anchor="middle">empty</text>
        <g :class="{ 'f-hidden': !holds(node, step) }">
          <rect class="f-peer-b" :x="x - 52" y="212" width="104" height="22" rx="5" />
          <text class="f-packet-text" :x="x" y="223">4c4b… bytes</text>
        </g>
      </g>
      <text :class="['f-muted', { 'f-hidden': step < 4 }]" :x="X.phone" y="254" text-anchor="middle">hash checked against 4c4b…</text>

      <!-- the register's op, to each side -->
      <g
        v-for="(to, side) in { left: X.laptop, right: X.phone }"
        :key="side"
        :class="{ 'f-hidden': step < 1 || step > 2 }"
        :style="{ transform: `translate(${step >= 2 ? to : X.server}px, ${Y - 54}px)` }"
      >
        <rect class="f-peer-b" x="-52" y="-10" width="104" height="20" rx="10" />
        <text class="f-packet-text" x="0" y="0">_attachments</text>
      </g>

      <!-- the phone's request and the server's answer -->
      <g :class="{ 'f-hidden': step !== 3 }" :style="{ transform: `translate(${step >= 3 ? X.server + 125 : X.phone}px, ${Y - 54}px)` }">
        <rect class="f-peer-c" x="-50" y="-10" width="100" height="20" rx="10" />
        <text class="f-packet-text" x="0" y="0">syncom/blob</text>
      </g>
      <g :class="{ 'f-hidden': step !== 4 }" :style="{ transform: `translate(${step >= 4 ? X.phone : X.server}px, ${Y - 54}px)` }">
        <rect class="f-peer-b" x="-50" y="-10" width="100" height="20" rx="10" />
        <text class="f-packet-text" x="0" y="0">the bytes</text>
      </g>

      <g :class="{ 'f-hidden': step !== 5 }">
        <rect class="f-ok" x="240" y="262" width="240" height="26" rx="13" />
        <text class="f-packet-text" x="360" y="275">bytes travel only to a reader</text>
      </g>
    </template>
  </SyncFigure>
</template>
