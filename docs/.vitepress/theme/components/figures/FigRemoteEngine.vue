<script setup lang="ts">
// The database on the main thread, its engine in a worker: serveEngine answers the engine contract over a
// message port and remoteEngine is the engine on the other side, so every write set and every read is a
// message and its answer. The seqs are minted where the database lives; a closed port fails every call.
// Depicts: src/engines/remote.js (serveEngine's table of stores and methods checked before a store sees a
// call, remoteEngine's message per call, ENGINE_UNREACHABLE on a closed port or a timeout),
// src/engines/engines.js (the subpath), src/log.js (the seqs reserved at the append, where the database is).
import SyncFigure from './SyncFigure.vue';

const steps = [
  'In a worker, serveEngine(engine, port) answers the engine contract. On the main thread, remoteEngine(port) is the engine you hand createDatabase().',
  'You write a task. The database stamps the op and mints its seq on the main thread, then hands the engine the log append and the record’s write set, a message each.',
  'The served side checks each call against its table of stores and methods, and the engine writes off the main thread. Each answer comes back as a message.',
  'A read is a message too: records.get(id) crosses to the worker…',
  '…and the record’s text comes back. Only data crosses, as structured clones: rows, texts and bytes, never a callback.',
  'If the worker exits or the port closes, every call waiting and every call after fails with ENGINE_UNREACHABLE, and so does a call past its timeout.',
];

// The messages on the port: each drawn at its destination on its step, hidden elsewhere.
const MESSAGES = [
  { step: 1, from: 320, to: 400, label: 'append, write', cls: 'f-peer-a', w: 100 },
  { step: 2, from: 400, to: 320, label: 'answers', cls: 'f-peer-b', w: 84 },
  { step: 3, from: 320, to: 400, label: 'records.get', cls: 'f-peer-a', w: 84 },
  { step: 4, from: 400, to: 320, label: 'the text', cls: 'f-peer-b', w: 84 },
];
const STORES = [
  { name: 'records', x: 464, w: 84 },
  { name: 'log', x: 556, w: 60 },
  { name: 'kv', x: 624, w: 60 },
];
const busy = (store: string, step: number) => (step === 2 && store !== 'kv') || ((step === 3 || step === 4) && store === 'records');
const gone = (step: number) => step === 5;
</script>

<template>
  <SyncFigure caption="The database on the main thread, its engine in a worker: every call crosses the port as a message" :steps="steps" :key-step="2">
    <template #default="{ step, grad }">
      <!-- the main thread -->
      <rect class="f-card" x="20" y="30" width="250" height="240" rx="12" />
      <text class="f-muted" x="34" y="52">main thread</text>
      <circle class="f-node" cx="80" cy="104" r="28" :fill="grad" />
      <text class="f-node-text" x="80" y="104">laptop</text>
      <text class="f-text" x="120" y="98">the database</text>
      <text class="f-muted" x="120" y="116">queue, clock, seqs</text>
      <text class="f-muted" x="34" y="168">next seq</text>
      <text :class="['f-text', 'f-mono', { 'f-changed': step === 1 }]" x="96" y="168">{{ step >= 1 ? 43 : 42 }}</text>
      <rect class="f-cell" x="34" y="196" width="222" height="40" rx="8" />
      <text class="f-text f-mono" x="145" y="221" text-anchor="middle">remoteEngine(port)</text>
      <text :class="['f-changed', 'f-text', 'f-mono', { 'f-hidden': !gone(step) }]" x="145" y="258" text-anchor="middle">
        ENGINE_UNREACHABLE
      </text>

      <!-- the worker -->
      <rect class="f-card" x="450" y="30" width="250" height="240" rx="12" />
      <text class="f-muted" x="464" y="52">worker</text>
      <g :class="{ 'f-hidden': gone(step) }">
        <text class="f-muted" x="464" y="84">the engine’s stores</text>
        <g v-for="s in STORES" :key="s.name">
          <rect :class="busy(s.name, step) ? 'f-peer-a' : 'f-cell'" :x="s.x" y="96" :width="s.w" height="26" rx="6" />
          <text :class="busy(s.name, step) ? 'f-packet-text' : 'f-text f-mono'" :x="s.x + s.w / 2" :y="busy(s.name, step) ? 109 : 113" text-anchor="middle">
            {{ s.name }}
          </text>
        </g>
        <text class="f-muted" x="464" y="148">IndexedDB, SQLite, files…</text>
        <rect class="f-cell" x="464" y="196" width="222" height="40" rx="8" />
        <text class="f-text f-mono" x="575" y="221" text-anchor="middle">serveEngine(engine, port)</text>
      </g>
      <text :class="['f-muted', { 'f-hidden': !gone(step) }]" x="575" y="160" text-anchor="middle">exited</text>

      <!-- the port -->
      <line :class="['f-link', { 'f-link-off': gone(step) }]" x1="270" y1="216" x2="450" y2="216" />
      <text class="f-muted" x="360" y="250" text-anchor="middle">MessagePort</text>
      <g
        v-for="m in MESSAGES"
        :key="m.label"
        :class="{ 'f-hidden': step !== m.step }"
        :style="{ transform: `translate(${step >= m.step ? m.to : m.from}px, 216px)` }"
      >
        <rect :class="m.cls" :x="-m.w / 2" y="-10" :width="m.w" height="20" rx="10" />
        <text class="f-packet-text" x="0" y="0">{{ m.label }}</text>
      </g>
    </template>
  </SyncFigure>
</template>
