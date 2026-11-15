<script setup lang="ts">
// The files a write touches, in the order a crash is safest in: the op appended to the log first (the
// commit point), then, as one write set when the defer window closes, the kv puts (the chain block), the
// tags' copies, the pieces the record makes, its file, the pieces it drops and the removals — with what a
// crash at each point leaves on disk and what the next open does about it.
// Depicts: src/commit.js (the append before the landing: issue, then land), src/files/files.js (`write`:
// kv puts, copies, each record's pieces, file and dropped pieces, then the removals; not atomic),
// src/files/journal.js (a torn last line of a journal left out at open), src/entries.js (pieces before the
// file, dropped after it), src/database.js (the unsealed tail replayed at open).
import SyncFigure from './SyncFigure.vue';

const steps = [
  'You update t1. Its op is appended to the log first, a line of the open journal, and your write resolves once that line is on disk. A crash mid-line leaves a torn line, left out.',
  'Up to 16 ms later t1 lands as one write set, in crash order: the kv puts first, the chain block before the record it names. A crash now: the next open replays t1.',
  'Then the tags’ copies: t1 as it was, kept for a tag before its file changes. A crash between leaves a copy, never a changed record without one.',
  'Then the record. A large text keeps its runs in pieces, and the new ones are written first. A crash now leaves pieces no file names, and the old t1 whole.',
  'Then t1’s file, which names its new pieces. A crash now leaves old pieces on disk, never read again: t1 reads whole, old or new, never half of each.',
  'Last, the pieces t1 dropped and the removals. Nothing here is atomic: the log is the commit point, and replaying an op that already landed changes nothing.',
];

const ROWS = [
  { title: 'Op appended to the log', file: 'log/open/….jsonl', after: 'torn line left out: nobody was told' },
  { title: 'kv puts: the chain block', file: 'blockchain/<hash>.json', after: 'replay lands t1 from the log' },
  { title: 'Tag copies: t1 as it was', file: 'tags/v1/data/t1.json', after: 'a copy, t1 unchanged: replay lands it' },
  { title: 'Pieces t1 makes', file: 'data/t1~4.json', after: 'pieces no file names; old t1 whole' },
  { title: 't1’s file', file: 'data/t1.json', after: 'new t1 whole; old pieces never read' },
  { title: 'Pieces t1 drops', file: 'data/t1~2.json', after: 't1 landed; replay changes nothing' },
  { title: 'Removals: records, kv keys', file: 'data/<id>.json, …', after: 'all landed; replay changes nothing' },
];
const rowY = (i: number) => (i === 0 ? 50 : 96 + (i - 1) * 30);
// The rows a step lands, and the last row landed by then.
const lastOf = (step: number) => (step >= 5 ? 6 : step);
const current = (i: number, step: number) => (step >= 5 ? i >= 5 : i === step);
const landed = (i: number, step: number) => i <= lastOf(step);
</script>

<template>
  <SyncFigure
    caption="A write's files land in crash order after its op is in the log, so a crash at any point leaves something the next open can finish"
    :steps="steps"
    :key-step="5"
    view-box="0 0 720 304"
  >
    <template #default="{ step }">
      <text class="f-muted" x="56" y="36">in crash order</text>
      <text class="f-muted" x="244" y="36">the file</text>
      <text class="f-muted" x="474" y="36">a crash right here leaves</text>
      <text class="f-muted" x="56" y="88">then one write set, when the defer window (16 ms) closes</text>

      <g v-for="(row, i) in ROWS" :key="row.title">
        <rect :class="landed(i, step) ? 'f-peer-a' : 'f-cell'" x="20" :y="rowY(i)" width="24" height="24" rx="5" />
        <text
          :class="landed(i, step) ? 'f-packet-text' : 'f-text'"
          x="32"
          :y="landed(i, step) ? rowY(i) + 12 : rowY(i) + 16"
          :text-anchor="landed(i, step) ? undefined : 'middle'"
        >
          {{ i + 1 }}
        </text>
        <text :class="['f-text', { 'f-changed': current(i, step) }]" x="56" :y="rowY(i) + 16">{{ row.title }}</text>
        <text class="f-muted f-mono" x="244" :y="rowY(i) + 16">{{ row.file }}</text>
        <text
          :class="['f-muted', { 'f-hidden': !landed(i, step), 'f-changed': current(i, step) }]"
          x="474"
          :y="rowY(i) + 16"
        >
          {{ row.after }}
        </text>
      </g>

      <!-- the crash, at the last file landed -->
      <g :style="{ transform: `translate(440px, ${rowY(lastOf(step)) + 12}px)` }">
        <rect class="f-peer-c" x="-26" y="-10" width="52" height="20" rx="10" />
        <text class="f-packet-text" x="0" y="0">crash</text>
      </g>

      <text class="f-text" x="20" y="292">
        The next open replays the log’s unsealed tail: what did not land, lands; what did is left as it is.
      </text>
    </template>
  </SyncFigure>
</template>
