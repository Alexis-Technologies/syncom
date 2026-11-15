<script setup lang="ts">
// A live demo: two real syncom databases in this page, a laptop and a phone (the phone dials the laptop) over
// @alexify/syncom/testing's in-process link with a latency you can see, both editing the text field `notes` of one
// task. Each textarea edits through a text handle (`openText`: an edit applies at once, the keystrokes are logged a
// window later as one op); a peer's change comes back from `handle.observe` as a delta, and the caret is carried
// through it with `transformIndex` of @alexify/syncom/editor. The reader takes the link offline, types at the same
// place in both, reconnects, and sees both runs kept whole, one after the other. The rest is read from public API
// and events: `change (op, via, { changes })`, `vector`, `nodeId`, `sync.peers()`, the link's
// `disconnect()`/`reconnect()`. Depicts: src/text/handle.js, src/text/splice.js, src/text/sequence.js,
// src/editor/editor.js, src/testing/link.js.
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref } from 'vue';

type Name = 'laptop' | 'phone';
const NAMES: Name[] = ['laptop', 'phone'];
const LATENCY = 450;
const FIELD = 'notes';
const START = 'Ship on Friday.';
const WORDS: Record<Name, string> = { laptop: ' (typed on the laptop)', phone: ' (typed on the phone)' };

interface Entry {
  key: number;
  text: string;
  from: Name | 'you';
  // A plain insert, kept so the next one that continues it reads as one line.
  run: { index: number; content: string } | null;
}
type Change = { action: string; index?: number; count?: number; content?: string };
interface Packet {
  key: number;
  toward: 'laptop' | 'phone';
  origin: Name;
}

const root = ref<HTMLElement | null>(null);
const state = ref<'idle' | 'loading' | 'ready' | 'failed'>('idle');
const error = ref('');
const online = ref(true);
const racing = ref(false);
const logs = reactive<Record<Name, Entry[]>>({ laptop: [], phone: [] });
const waiting = reactive<Record<Name, number>>({ laptop: 0, phone: 0 });
const lengths = reactive<Record<Name, number>>({ laptop: 0, phone: 0 });
const packets = ref<Packet[]>([]);
const inSync = ref(false);
const areas: Partial<Record<Name, HTMLTextAreaElement>> = {};

let lib: any = null;
let mesh: any = null;
let link: any = null;
let handles: Partial<Record<Name, any>> = {};
let offs: (() => void)[] = [];
let recordId = '';
let names = new Map<string, Name>();
let serial = 0;
let generation = 0;
let lastPacket = 0;
let poll: ReturnType<typeof setInterval> | null = null;
let observer: IntersectionObserver | null = null;

const db = (name: Name) => mesh.get(name);
const other = (name: Name): Name => (name === 'laptop' ? 'phone' : 'laptop');
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const bindArea = (name: Name) => (el: unknown) => {
  if (el) areas[name] = el as HTMLTextAreaElement;
  else delete areas[name];
};

const quote = (text: string) => JSON.stringify(text.length > 26 ? `${text.slice(0, 25)}…` : text);

const describe = (changes: Change[]) => {
  const parts: string[] = [];
  for (const change of changes) {
    if (change.action !== 'splice') continue;
    if (change.count) parts.push(`−${change.count} at ${change.index}`);
    if (change.content) parts.push(`+${quote(change.content)} at ${change.index}`);
  }
  return parts.join(', ') || 'no visible change';
};

// The textarea reads what the handle reads; the caret moves with a peer's delta, never with our own edit.
const show = (name: Name, delta: unknown[] | null) => {
  const el = areas[name];
  const handle = handles[name];
  if (!el || !handle) return;
  const text = handle.toString();
  lengths[name] = text.length;
  if (el.value === text) return;
  const focused = document.activeElement === el;
  let start = el.selectionStart;
  let end = el.selectionEnd;
  if (delta) {
    start = lib.transformIndex(Math.min(start, el.value.length), delta, true);
    end = lib.transformIndex(Math.min(end, el.value.length), delta, true);
  }
  el.value = text;
  if (focused) el.setSelectionRange(Math.min(start, text.length), Math.min(end, text.length));
};

// What the reader typed, as the one splice between what the handle read and what the textarea holds now: the
// part after the caret is what stayed, so a letter typed between two equal ones lands where the caret is.
const typed = (name: Name) => {
  const el = areas[name];
  const handle = handles[name];
  if (!el || !handle) return;
  const before: string = handle.toString();
  const after = el.value;
  const caret = Math.min(el.selectionEnd ?? after.length, after.length);
  let suffix = 0;
  const suffixMax = Math.min(before.length, after.length - caret);
  while (suffix < suffixMax && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++;
  let prefix = 0;
  const prefixMax = Math.min(before.length, after.length) - suffix;
  while (prefix < prefixMax && before[prefix] === after[prefix]) prefix++;
  // Never between the two halves of a surrogate pair (SURROGATE): widen to the whole character.
  if (prefix > 0 && /[\uD800-\uDBFF]/.test(before[prefix - 1])) prefix--;
  if (suffix > 0 && /[\uDC00-\uDFFF]/.test(before[before.length - suffix])) suffix--;
  const removed = before.length - prefix - suffix;
  const inserted = after.slice(prefix, after.length - suffix);
  try {
    if (removed > 0) handle.delete(prefix, removed);
    if (inserted.length > 0) handle.insert(prefix, inserted);
  } catch {
    // Refused: the textarea reads the handle again.
    el.value = handle.toString();
  }
  lengths[name] = handle.toString().length;
};

const send = (to: Name, origin: Name) => {
  // Ops arrive one per keystroke burst; a dot per 120 ms is enough to see them travel.
  const now = performance.now();
  if (now - lastPacket < 120) return;
  lastPacket = now;
  const packet: Packet = { key: ++serial, toward: to, origin };
  packets.value.push(packet);
  setTimeout(() => {
    packets.value = packets.value.filter((item) => item.key !== packet.key);
  }, LATENCY + 150);
};

const measure = () => {
  if (!mesh) return;
  for (const name of NAMES) {
    const own = db(name).nodeId;
    waiting[name] = Math.max(0, (db(name).vector[own] ?? 0) - (db(other(name)).vector[own] ?? 0));
  }
  let pending = 0;
  for (const name of NAMES) for (const peer of db(name).sync.peers()) pending += peer.pending;
  const same = handles.laptop?.toString() === handles.phone?.toString();
  const typing = handles.laptop?.pending || handles.phone?.pending;
  inSync.value = online.value && same && !typing && pending === 0 && lib.sameVectors(mesh.storages);
};

const start = async () => {
  state.value = 'loading';
  const mine = ++generation;
  try {
    lib ??= await import('virtual:syncom-demo');
    const engine = lib.memoryEngine();
    link = null;
    const made = await lib.createMesh(NAMES, [['phone', 'laptop']], {
      createStorage: (name: Name, options: any) =>
        lib.createDatabase({
          ...options,
          path: name,
          engine,
          lock: false,
          logger: false,
          sync: { ...options.sync, connect: (node: any) => (link = options.sync.connect(node)) },
        }),
      link: { latency: LATENCY },
    });
    if (mine !== generation) return void (await made.close());
    mesh = made;
    names = new Map(NAMES.map((name) => [db(name).nodeId, name]));
    recordId = await db('laptop').insert({ title: 'Ship the release' });
    await db('laptop').updateText(recordId, FIELD, START);
    await lib.settle(mesh.storages, { timeout: 10_000 });
    if (mine !== generation) return;
    online.value = true;
    offs = [];
    for (const name of NAMES) {
      logs[name] = [];
      const handle = await db(name).openText(recordId, FIELD);
      handles[name] = handle;
      offs.push(
        handle.observe((delta: unknown[] | null, event: { local: boolean; reset?: boolean }) => {
          show(name, event.reset || event.local ? null : delta);
        }),
      );
      const listener = (op: any, via: any, meta: any) => {
        if (op.id !== recordId) return;
        const origin = names.get(op.origin) ?? other(name);
        const from = via ? origin : 'you';
        const changes: Change[] = meta.changes;
        const only = changes.length === 1 && changes[0].action === 'splice' && !changes[0].count ? changes[0] : null;
        const run = only && typeof only.content === 'string' ? { index: only.index ?? 0, content: only.content } : null;
        // An op per keystroke burst: the letters typed on one after another read as one line.
        const last = logs[name][0];
        if (run && last?.from === from && last.run && last.run.index + last.run.content.length === run.index) {
          last.run.content += run.content;
          last.text = `+${quote(last.run.content)} at ${last.run.index}`;
        } else {
          logs[name].unshift({ key: ++serial, text: describe(changes), from, run });
          logs[name].splice(4);
        }
        if (via) send(name, origin);
      };
      db(name).on('change', listener);
      const owner = db(name);
      offs.push(() => owner.off('change', listener));
    }
    state.value = 'ready';
    // The textareas exist once the template shows them.
    await nextTick();
    for (const name of NAMES) show(name, null);
    poll = setInterval(measure, 150);
  } catch (cause) {
    error.value = String(cause);
    state.value = 'failed';
  }
};

const stop = async () => {
  generation++;
  if (poll) clearInterval(poll);
  poll = null;
  for (const off of offs) off();
  offs = [];
  const closing = mesh;
  const open = handles;
  handles = {};
  mesh = null;
  for (const name of NAMES) await open[name]?.close().catch(() => {});
  if (closing) await closing.close();
};

const reset = async () => {
  await stop();
  packets.value = [];
  racing.value = false;
  for (const name of NAMES) {
    const el = areas[name];
    if (el) el.value = '';
  }
  await start();
};

const toggle = async () => {
  if (!link) return;
  if (online.value) {
    link.disconnect();
    online.value = false;
  } else {
    online.value = true;
    await link.reconnect();
  }
};

// The demo types for the reader: the link offline, the two nodes typing at the same place (before the last full
// stop) one letter each in turn, then the link back.
const race = async () => {
  if (racing.value) return;
  racing.value = true;
  const mine = generation;
  try {
    if (online.value) await toggle();
    const at: Partial<Record<Name, number>> = {};
    for (const name of NAMES) {
      const text: string = handles[name].toString();
      at[name] = text.endsWith('.') ? text.length - 1 : text.length;
    }
    const steps = Math.max(WORDS.laptop.length, WORDS.phone.length);
    for (let i = 0; i < steps; i++) {
      for (const name of NAMES) {
        if (mine !== generation) return;
        if (i < WORDS[name].length) handles[name].insert((at[name] ?? 0) + i, WORDS[name][i]);
      }
      await sleep(55);
    }
    await sleep(600);
    if (mine === generation && !online.value) await toggle();
  } catch {
    // A reset in the middle closed the handles.
  } finally {
    if (mine === generation) racing.value = false;
  }
};

const status = computed(() => {
  if (!online.value) {
    const held = NAMES.map((name) => `${name}: ${waiting[name]} op${waiting[name] === 1 ? '' : 's'} waiting`).join(' · ');
    return { ok: false, text: `Offline — ${held}` };
  }
  return inSync.value
    ? { ok: true, text: 'In sync: both fields read the same text' }
    : { ok: false, text: 'Syncing…' };
});

onMounted(() => {
  observer = new IntersectionObserver(
    ([entry]) => {
      if (entry.isIntersecting && state.value === 'idle') void start();
    },
    { rootMargin: '200px' },
  );
  if (root.value) observer.observe(root.value);
});
onBeforeUnmount(() => {
  observer?.disconnect();
  void stop();
});
</script>

<template>
  <div ref="root" class="sc-live">
    <div class="sc-live-head">
      <strong>Live demo</strong>
      <span>Two real syncom databases editing one text field, linked with {{ LATENCY }} ms of latency.</span>
      <button v-if="state === 'ready'" type="button" class="sc-live-reset" @click="reset">Reset</button>
    </div>
    <p v-if="state === 'idle' || state === 'loading'" class="sc-live-wait">Starting two databases…</p>
    <p v-else-if="state === 'failed'" class="sc-live-wait">The demo could not start: {{ error }}</p>
    <template v-else>
      <p class="sc-live-hint">
        Take the link offline, type at the same place in both fields, and bring it back — or
        <button type="button" :disabled="racing" @click="race">let both type at once</button>
      </p>
      <div class="sc-live-grid">
        <template v-for="(name, index) in NAMES" :key="name">
          <div v-if="index > 0" class="sc-live-middle">
            <button
              type="button"
              :class="['sc-live-toggle', { 'sc-live-toggle-off': !online }]"
              :disabled="racing"
              @click="toggle"
            >
              {{ online ? 'online' : 'offline' }}
            </button>
            <div :class="['sc-live-link', { 'sc-live-link-off': !online }]">
              <span
                v-for="packet in packets"
                :key="packet.key"
                :class="['sc-live-packet', `sc-live-packet-${packet.origin}`, packet.toward === 'phone' ? 'sc-live-ltr' : 'sc-live-rtl']"
                :style="{ animationDuration: `${LATENCY}ms` }"
              />
            </div>
          </div>
          <section :class="['sc-live-node', `sc-live-node-${name}`]">
            <header>
              <span class="sc-live-name">{{ name }}</span>
              <span class="sc-live-count">{{ lengths[name] }} characters</span>
            </header>
            <textarea
              :ref="bindArea(name)"
              :aria-label="`${FIELD} on the ${name}`"
              :readonly="racing"
              rows="4"
              spellcheck="false"
              @input="typed(name)"
            />
            <ol class="sc-live-log">
              <li v-for="entry in logs[name]" :key="entry.key">
                <span :class="`sc-live-from sc-live-from-${entry.from}`">{{ entry.from === 'you' ? 'local' : entry.from }}</span>
                {{ entry.text }}
              </li>
            </ol>
          </section>
        </template>
      </div>
      <p :class="['sc-live-status', { 'sc-live-status-ok': status.ok }]">{{ status.text }}</p>
    </template>
  </div>
</template>

<style scoped>
.sc-live {
  margin: 24px 0;
  padding: 14px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 12px;
  background: var(--vp-c-bg-soft);
  font-size: 13.5px;
}
.sc-live-head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px 10px;
  margin-bottom: 8px;
  color: var(--vp-c-text-2);
}
.sc-live-head strong {
  color: var(--vp-c-text-1);
}
.sc-live-reset {
  margin-left: auto;
}
.sc-live button {
  padding: 1px 9px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 6px;
  background: var(--vp-c-bg);
  color: var(--vp-c-text-1);
  font-size: 12.5px;
  cursor: pointer;
}
.sc-live button:hover {
  border-color: var(--vp-c-brand-3);
}
.sc-live button:disabled {
  opacity: 0.55;
  cursor: default;
}
.sc-live-wait {
  margin: 24px 0;
  text-align: center;
  color: var(--vp-c-text-2);
}
.sc-live-hint {
  margin: 0 0 12px;
  color: var(--vp-c-text-2);
}
.sc-live-grid {
  display: grid;
  grid-template-columns: 1fr 76px 1fr;
  align-items: start;
}
.sc-live-node {
  min-width: 0;
  padding: 10px;
  border: 1px solid var(--vp-c-divider);
  border-top: 3px solid var(--node);
  border-radius: 10px;
  background: var(--vp-c-bg);
}
.sc-live-node-laptop {
  --node: var(--sc-peer-a);
}
.sc-live-node-phone {
  --node: var(--sc-peer-c);
}
.sc-live-node header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin-bottom: 8px;
}
.sc-live-name {
  font-weight: 700;
}
.sc-live-count {
  font-size: 11.5px;
  color: var(--vp-c-text-2);
  font-variant-numeric: tabular-nums;
}
.sc-live-node textarea {
  display: block;
  box-sizing: border-box;
  width: 100%;
  min-height: 92px;
  padding: 6px 8px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 6px;
  background: var(--vp-c-bg-soft);
  color: var(--vp-c-text-1);
  font-family: var(--vp-font-family-mono);
  font-size: 13px;
  line-height: 1.5;
  resize: vertical;
}
.sc-live-node textarea:focus {
  outline: none;
  border-color: var(--node);
}
.sc-live-middle {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 0 8px;
  margin-top: 54px;
}
.sc-live .sc-live-toggle {
  border-color: var(--sc-accent);
  color: var(--vp-c-text-1);
}
.sc-live .sc-live-toggle-off {
  border-style: dashed;
  border-color: var(--vp-c-text-3);
  color: var(--vp-c-text-2);
}
.sc-live-link {
  position: relative;
  align-self: stretch;
  height: 3px;
  border-radius: 2px;
  background: var(--vp-c-gray-1);
}
.sc-live-link-off {
  background: repeating-linear-gradient(90deg, var(--vp-c-gray-1) 0 3px, transparent 3px 9px);
  opacity: 0.6;
}
.sc-live-packet {
  position: absolute;
  top: -4px;
  width: 11px;
  height: 11px;
  border-radius: 50%;
  animation-timing-function: ease-in-out;
  animation-fill-mode: both;
}
.sc-live-packet-laptop {
  background: var(--sc-peer-a);
}
.sc-live-packet-phone {
  background: var(--sc-peer-c);
}
.sc-live-ltr {
  animation-name: sc-live-ltr;
}
.sc-live-rtl {
  animation-name: sc-live-rtl;
}
@keyframes sc-live-ltr {
  from {
    left: -6px;
  }
  to {
    left: calc(100% - 5px);
  }
}
@keyframes sc-live-rtl {
  from {
    left: calc(100% - 5px);
  }
  to {
    left: -6px;
  }
}
.sc-live-log {
  min-height: 72px;
  margin: 8px 0 0;
  padding: 6px 0 0;
  border-top: 1px dashed var(--vp-c-divider);
  list-style: none;
  font-family: var(--vp-font-family-mono);
  font-size: 11px;
  line-height: 1.6;
  color: var(--vp-c-text-2);
}
.sc-live-log li {
  margin: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.sc-live-from {
  display: inline-block;
  min-width: 42px;
  font-weight: 700;
}
.sc-live-from-laptop {
  color: var(--sc-peer-a);
}
.sc-live-from-phone {
  color: var(--sc-peer-c);
}
.sc-live-status {
  margin: 12px 0 0;
  padding: 6px 10px;
  border-radius: 8px;
  background: var(--vp-c-default-soft);
  color: var(--vp-c-text-2);
}
.sc-live-status-ok {
  background: color-mix(in srgb, var(--sc-accent) 16%, transparent);
  color: var(--vp-c-text-1);
}
@media (max-width: 720px) {
  .sc-live-grid {
    grid-template-columns: 1fr;
    gap: 10px;
  }
  .sc-live-middle {
    margin-top: 0;
  }
  .sc-live-link {
    display: none;
  }
}
@media (prefers-reduced-motion: reduce) {
  .sc-live-packet {
    display: none;
  }
}
</style>
