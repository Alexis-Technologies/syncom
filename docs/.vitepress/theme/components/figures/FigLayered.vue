<script setup lang="ts">
// Layered backends: layered([memory(), disk]) is one fsi over two. A read is the first layer that has the
// file, filled upward; a write lands on every layer, resolving after the disk under 'through' and after
// memory under 'back', where the disk's copy waits in a queue that every read below drains first.
// Depicts: src/layered/layered.js (read top down with fill, spread to every layer, the write-back queue and
// the operations that settle it first, flush()).
import SyncFigure from './SyncFigure.vue';

const steps = [
  'layered([memory(), disk]) is one backend over two: the database reads and writes through it as through any fsi. Memory holds what passed through it, the disk everything.',
  'A read takes the first layer that has the file, top down. b.json misses memory, the disk answers, and fill copies it up: the next read is a hit at the top.',
  'Under write: ‘through’, the default, a write lands in memory, then on the disk, and resolves once the disk has it. Durability is the disk’s.',
  'Under write: ‘back’ it resolves once memory has it. The disk’s copy waits in a queue, one call at a time, and what the queue holds is lost with the process.',
  'The queue drains to the disk. A read that misses memory, exists(), list(), create() and sync() wait for it first, so nothing stale is read below; flush() awaits it.',
];

const FILES = ['a', 'b', 'c', 'd'];
const COL = { a: 334, b: 424, c: 514, d: 604 } as Record<string, number>;
const MEM_Y = 62;
const DISK_Y = 212;
const inMemory = (f: string, step: number) => f === 'a' || (f === 'b' && step >= 1) || (f === 'c' && step >= 2) || (f === 'd' && step >= 3);
const onDisk = (f: string, step: number) => f === 'a' || f === 'b' || (f === 'c' && step >= 2) || (f === 'd' && step >= 4);
// The calls: each drawn at its destination on its step, hidden elsewhere.
const CALLS = [
  { step: 1, label: 'read b', x: COL.b, y: DISK_Y - 12 },
  { step: 2, label: 'write c', x: COL.c, y: DISK_Y - 12 },
  { step: 3, label: 'write d', x: COL.d, y: MEM_Y - 12 },
];
const resolved = (step: number) => (step === 2 ? 'after the disk' : step === 3 ? 'after memory' : '');
</script>

<template>
  <SyncFigure caption="A layered backend reads from the top and writes through to the disk, or behind it" :steps="steps" :key-step="3">
    <template #default="{ step, grad }">
      <circle class="f-node" cx="70" cy="150" r="30" :fill="grad" />
      <text class="f-node-text" x="70" y="150">laptop</text>
      <text class="f-muted" x="70" y="104" text-anchor="middle">the database</text>
      <path class="f-link" d="M 100 150 H 150 V 75 H 196" />
      <path class="f-link" d="M 150 150 V 225 H 196" />

      <!-- the layers -->
      <rect class="f-card" x="200" y="40" width="500" height="70" rx="12" />
      <text class="f-text f-mono" x="214" y="80">memory()</text>
      <rect class="f-card" x="200" y="190" width="500" height="70" rx="12" />
      <text class="f-text f-mono" x="214" y="230">disk</text>
      <g v-for="f in FILES" :key="f">
        <g :class="{ 'f-hidden': !inMemory(f, step) }">
          <rect class="f-cell" :x="COL[f] - 38" :y="MEM_Y" width="76" height="26" rx="6" />
          <text class="f-text f-mono" :x="COL[f]" :y="MEM_Y + 17" text-anchor="middle">{{ f }}.json</text>
        </g>
        <g :class="{ 'f-hidden': !onDisk(f, step) }">
          <rect class="f-cell" :x="COL[f] - 38" :y="DISK_Y" width="76" height="26" rx="6" />
          <text class="f-text f-mono" :x="COL[f]" :y="DISK_Y + 17" text-anchor="middle">{{ f }}.json</text>
        </g>
      </g>
      <text :class="['f-changed', 'f-text', { 'f-hidden': step !== 1 }]" :x="COL.b" y="103" text-anchor="middle">filled up</text>

      <!-- the write-back queue -->
      <g :class="{ 'f-hidden': step < 3 }">
        <rect class="f-cell" x="290" y="134" width="400" height="32" rx="8" />
        <text class="f-muted" x="304" y="154">write-back queue</text>
        <g :class="{ 'f-hidden': step !== 3 }">
          <rect class="f-peer-a" :x="COL.d - 38" y="137" width="76" height="26" rx="6" />
          <text class="f-packet-text" :x="COL.d" y="150">d.json</text>
        </g>
      </g>

      <!-- the calls -->
      <g
        v-for="c in CALLS"
        :key="c.label"
        :class="{ 'f-hidden': step !== c.step }"
        :style="{ transform: `translate(${step >= c.step ? c.x : 150}px, ${step >= c.step ? c.y : 150}px)` }"
      >
        <rect class="f-peer-a" x="-38" y="-10" width="76" height="20" rx="10" />
        <text class="f-packet-text" x="0" y="0">{{ c.label }}</text>
      </g>

      <!-- when the write resolved -->
      <g :class="{ 'f-hidden': resolved(step) === '' }">
        <rect class="f-ok" x="26" y="196" width="88" height="20" rx="10" />
        <text class="f-packet-text" x="70" y="206">resolved</text>
        <text class="f-muted" x="70" y="234" text-anchor="middle">{{ resolved(step) || 'after memory' }}</text>
      </g>
    </template>
  </SyncFigure>
</template>
