<script setup lang="ts">
// A live demo: three real syncom databases in this page — a server, a laptop and a phone that both dial
// it — over @alexify/syncom/testing's in-process link with a latency you can see. The reader edits the
// task on any node, takes the laptop or the phone offline, writes there, and brings it back. Everything
// shown is read from public API and events: `change (op, via, { changes })`, `vector`, `nodeId`,
// `sync.peers()`. Depicts: src/sync/manager.js, src/sync/hosting.js, src/ops.js, src/testing/link.js.
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue';

type Name = 'laptop' | 'server' | 'phone';
const NAMES: Name[] = ['laptop', 'server', 'phone'];
const DIALERS: Name[] = ['laptop', 'phone'];
const TAGS = ['docs', 'urgent', 'design', 'bug', 'later', 'ui'];
const LATENCY = 450;

interface Row {
  title: string;
  votes: number;
  tags: string[];
}
interface Entry {
  key: number;
  text: string;
  from: Name | 'you';
}
interface Packet {
  key: number;
  side: 'left' | 'right';
  toward: 'server' | 'edge';
  origin: Name;
}

const root = ref<HTMLElement | null>(null);
const state = ref<'idle' | 'loading' | 'ready' | 'failed'>('idle');
const error = ref('');
const rows = reactive<Record<Name, Row>>({
  laptop: { title: '', votes: 0, tags: [] },
  server: { title: '', votes: 0, tags: [] },
  phone: { title: '', votes: 0, tags: [] },
});
const logs = reactive<Record<Name, Entry[]>>({ laptop: [], server: [], phone: [] });
const online = reactive<Record<Name, boolean>>({ laptop: true, server: true, phone: true });
const waiting = reactive<Record<Name, number>>({ laptop: 0, server: 0, phone: 0 });
const drafts = reactive<Record<Name, string>>({ laptop: '', server: '', phone: '' });
const packets = ref<Packet[]>([]);
const inSync = ref(false);

let lib: any = null;
let mesh: any = null;
let links: Partial<Record<Name, any>> = {};
let recordId = '';
let names = new Map<string, Name>();
let serial = 0;
let poll: ReturnType<typeof setInterval> | null = null;
let observer: IntersectionObserver | null = null;

const db = (name: Name) => mesh.get(name);

const describe = (changes: { action: string; field: string; value?: unknown; elements?: unknown[] }[]) => {
  // An op that changes nothing here lost to a newer write of the same field: logged, not shown.
  if (changes.length === 0) return 'no visible change: a newer write wins';
  const parts: string[] = [];
  for (const change of changes) {
    if (change.action === 'inc') parts.push(`${change.field} +${change.value}`);
    else if (change.action === 'add') parts.push(`${change.field} + ${(change.elements ?? []).join(', ')}`);
    else if (change.action === 'remove') parts.push(`${change.field} − ${(change.elements ?? []).join(', ')}`);
    else parts.push(`${change.field} = ${JSON.stringify(change.value)}`);
  }
  return parts.join(', ');
};

const refresh = async (name: Name) => {
  const row = (await db(name).get(recordId)) ?? {};
  rows[name].title = row.title ?? '';
  rows[name].votes = row.votes ?? 0;
  rows[name].tags = row.tags ?? [];
  if (document.activeElement?.getAttribute('data-node') !== name) drafts[name] = rows[name].title;
};

const measure = () => {
  if (!mesh) return;
  const server = db('server');
  for (const name of DIALERS) {
    const own = db(name).nodeId;
    waiting[name] = Math.max(0, (db(name).vector[own] ?? 0) - (server.vector[own] ?? 0));
  }
  let pending = 0;
  for (const name of NAMES) for (const peer of db(name).sync.peers()) pending += peer.pending;
  inSync.value = lib.sameVectors(mesh.storages) && pending === 0;
};

const send = (origin: Name, to: Name, from: Name) => {
  // An op that arrived at `to` from `from` travels along the link between them.
  const side = to === 'laptop' || from === 'laptop' ? 'left' : 'right';
  const packet: Packet = { key: ++serial, side, toward: to === 'server' ? 'server' : 'edge', origin };
  packets.value.push(packet);
  setTimeout(() => {
    packets.value = packets.value.filter((item) => item.key !== packet.key);
  }, LATENCY + 150);
};

const start = async () => {
  state.value = 'loading';
  try {
    lib ??= await import('virtual:syncom-demo');
    const engine = lib.memoryEngine();
    links = {};
    mesh = await lib.createMesh(NAMES, [['laptop', 'server'], ['phone', 'server']], {
      createStorage: (name: Name, options: any) =>
        lib.createDatabase({
          ...options,
          path: name,
          engine,
          lock: false,
          logger: false,
          sync: { ...options.sync, connect: (node: any) => (links[name] = options.sync.connect(node)) },
        }),
      link: { latency: LATENCY },
    });
    names = new Map(NAMES.map((name) => [db(name).nodeId, name]));
    const server = db('server');
    recordId = await server.insert({ title: 'Write the docs' });
    await server.inc(recordId, 'votes', 2);
    await server.add(recordId, 'tags', ['docs']);
    for (const name of NAMES) {
      logs[name] = [];
      online[name] = true;
      db(name).on('change', (op: any, via: any, meta: any) => {
        if (op.id !== recordId) return;
        const from = via ? (names.get(via.node) ?? 'server') : 'you';
        const origin = names.get(op.origin) ?? 'server';
        logs[name].unshift({ key: ++serial, text: describe(meta.changes), from: via ? origin : 'you' });
        logs[name].splice(4);
        if (via && from !== 'you') send(origin, name, from);
        void refresh(name);
      });
    }
    await lib.settle(mesh.storages, { timeout: 10_000 });
    for (const name of NAMES) {
      logs[name] = [];
      await refresh(name);
    }
    poll = setInterval(measure, 150);
    state.value = 'ready';
  } catch (cause) {
    error.value = String(cause);
    state.value = 'failed';
  }
};

const stop = async () => {
  if (poll) clearInterval(poll);
  poll = null;
  const closing = mesh;
  mesh = null;
  if (closing) await closing.close();
};

const reset = async () => {
  await stop();
  packets.value = [];
  await start();
};

const vote = (name: Name) => db(name).inc(recordId, 'votes', 1);
const tag = (name: Name) => {
  const free = TAGS.filter((item) => !rows[name].tags.includes(item));
  if (free.length) return db(name).add(recordId, 'tags', [free[Math.floor(Math.random() * free.length)]]);
};
const untag = (name: Name, item: string) => db(name).remove(recordId, 'tags', [item]);
const rename = (name: Name) => {
  const title = drafts[name].trim();
  if (title && title !== rows[name].title) return db(name).update(recordId, { title });
};
const toggle = async (name: Name) => {
  const link = links[name];
  if (!link) return;
  if (online[name]) {
    link.disconnect();
    online[name] = false;
  } else {
    online[name] = true;
    await link.reconnect();
  }
};

const status = computed(() => {
  const away = DIALERS.filter((name) => !online[name]);
  if (away.length) {
    const held = away.map((name) => `${name}: ${waiting[name]} op${waiting[name] === 1 ? '' : 's'} waiting`).join(' · ');
    return { ok: false, text: `${away.join(' and ')} offline — ${held}` };
  }
  return inSync.value ? { ok: true, text: 'In sync: every node holds the same ops' } : { ok: false, text: 'Syncing…' };
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
      <span>Three real syncom databases in this page, linked with {{ LATENCY }} ms of latency.</span>
      <button v-if="state === 'ready'" type="button" class="sc-live-reset" @click="reset">Reset</button>
    </div>
    <p v-if="state === 'idle' || state === 'loading'" class="sc-live-wait">Starting three databases…</p>
    <p v-else-if="state === 'failed'" class="sc-live-wait">The demo could not start: {{ error }}</p>
    <template v-else>
      <div class="sc-live-grid">
        <template v-for="(name, index) in NAMES" :key="name">
          <div v-if="index > 0" :class="['sc-live-link', { 'sc-live-link-off': !online[NAMES[index - 1] === 'server' ? name : NAMES[index - 1]] }]">
            <span
              v-for="packet in packets.filter((item) => item.side === (index === 1 ? 'left' : 'right'))"
              :key="packet.key"
              :class="[
                'sc-live-packet',
                `sc-live-packet-${packet.origin}`,
                (index === 1) === (packet.toward === 'server') ? 'sc-live-ltr' : 'sc-live-rtl',
              ]"
              :style="{ animationDuration: `${LATENCY}ms` }"
            />
          </div>
          <section :class="['sc-live-node', `sc-live-node-${name}`]">
            <header>
              <span class="sc-live-name">{{ name }}</span>
              <button
                v-if="name !== 'server'"
                type="button"
                :class="['sc-live-toggle', { 'sc-live-toggle-off': !online[name] }]"
                @click="toggle(name)"
              >
                {{ online[name] ? 'online' : 'offline' }}
              </button>
            </header>
            <label class="sc-live-field">
              <span>title</span>
              <input
                v-model="drafts[name]"
                :data-node="name"
                @keydown.enter="($event.target as HTMLInputElement).blur()"
                @blur="rename(name)"
              />
            </label>
            <div class="sc-live-field">
              <span>votes</span>
              <b>{{ rows[name].votes }}</b>
              <button type="button" @click="vote(name)">+1</button>
            </div>
            <div class="sc-live-field sc-live-tags">
              <span>tags</span>
              <button v-for="item in rows[name].tags" :key="item" type="button" class="sc-live-chip" title="Remove" @click="untag(name, item)">
                {{ item }} ×
              </button>
              <button type="button" @click="tag(name)">+ tag</button>
            </div>
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
  margin-bottom: 12px;
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
.sc-live-wait {
  margin: 24px 0;
  text-align: center;
  color: var(--vp-c-text-2);
}
.sc-live-grid {
  display: grid;
  grid-template-columns: 1fr 44px 1fr 44px 1fr;
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
.sc-live-node-server {
  --node: var(--sc-peer-b);
}
.sc-live-node-phone {
  --node: var(--sc-peer-c);
}
.sc-live-node header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}
.sc-live-name {
  font-weight: 700;
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
.sc-live-field {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 6px;
  min-height: 28px;
}
.sc-live-field > span {
  width: 38px;
  font-size: 11.5px;
  color: var(--vp-c-text-2);
}
.sc-live-field input {
  flex: 1;
  min-width: 0;
  padding: 2px 6px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 6px;
  background: var(--vp-c-bg-soft);
  color: var(--vp-c-text-1);
}
.sc-live-field b {
  min-width: 18px;
  font-variant-numeric: tabular-nums;
}
.sc-live .sc-live-chip {
  border-color: transparent;
  background: var(--vp-c-default-soft);
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
.sc-live-from-server {
  color: var(--sc-peer-b);
}
.sc-live-from-phone {
  color: var(--sc-peer-c);
}
.sc-live-link {
  position: relative;
  height: 3px;
  margin-top: 26px;
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
.sc-live-packet-server {
  background: var(--sc-peer-b);
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
