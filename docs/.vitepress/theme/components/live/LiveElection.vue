<script setup lang="ts">
// A live demo: browser "tabs" electing a leader in this page with the real `elect()` of @alexify/syncom/shared,
// the election `openShared` runs, here without a database. Each tab is an elector of its own over one name: Web
// Locks (`navigator.locks`, what a browser uses) or the BroadcastChannel heartbeat (the fallback). The reader
// closes a tab — `release()`, as a tab that goes lets go — and watches another take over; opens one, which
// follows. Everything shown is read from the elector's public face: `leader`, `token`, `mode`, `onLead`,
// `onLost`. Depicts: src/shared/election.js, src/shared/shared.js.
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import Segmented from '../Segmented.vue';

type Mode = 'locks' | 'heartbeat';

interface Tab {
  key: number;
  label: string;
  token: string;
  mode: string;
  leader: boolean;
  flash: number;
}
interface Entry {
  key: number;
  text: string;
}
interface Held {
  elector: any;
  channel: BroadcastChannel | null;
  offs: (() => void)[];
}

const HEARTBEAT = 500;
const START_TABS = 3;
const MAX_TABS = 5;
const MODES = [
  { id: 'locks', title: 'Web Locks' },
  { id: 'heartbeat', title: 'Heartbeat' },
];

const root = ref<HTMLElement | null>(null);
const state = ref<'idle' | 'loading' | 'ready' | 'failed'>('idle');
const error = ref('');
const mode = ref<Mode>('locks');
const hasLocks = ref(true);
const tabs = ref<Tab[]>([]);
const log = ref<Entry[]>([]);

let lib: any = null;
let held = new Map<number, Held>();
// The election's name: one per start, so two browser tabs on this page never elect together.
let name = '';
let serial = 0;
let opened = 0;
// When the leader closed, for the time the next grant took.
let goneAt: number | null = null;
let poll: ReturnType<typeof setInterval> | null = null;
let observer: IntersectionObserver | null = null;

const tabOf = (key: number) => tabs.value.find((tab) => tab.key === key);

const note = (text: string) => {
  log.value.unshift({ key: ++serial, text });
  log.value.splice(5);
};

const led = (key: number) => {
  const tab = tabOf(key);
  if (!tab || tab.leader) return;
  tab.leader = true;
  tab.flash++;
  const why = mode.value === 'locks' ? 'the lock was granted' : 'it heard no leader and no smaller claim';
  const after = goneAt === null ? '' : `, ${Math.round(performance.now() - goneAt)} ms after the leader closed`;
  goneAt = null;
  note(`${tab.label} leads: ${why}${after}`);
};

const lost = (key: number) => {
  const tab = tabOf(key);
  if (!tab || !tab.leader) return;
  tab.leader = false;
  note(`${tab.label} yields: a leader with a smaller token spoke`);
};

// The view follows `leader` as well as the events: the first grant may come before onLead is attached.
const follow = () => {
  for (const tab of tabs.value) {
    const elector = held.get(tab.key)?.elector;
    if (!elector) continue;
    if (elector.leader && !tab.leader) led(tab.key);
    else if (!elector.leader && tab.leader) lost(tab.key);
  }
};

const open = () => {
  if (tabs.value.length >= MAX_TABS) return;
  const key = ++serial;
  const label = `Tab ${++opened}`;
  let channel: BroadcastChannel | null = null;
  const options: Record<string, unknown> = { name };
  if (mode.value === 'locks') {
    options.locks = navigator.locks;
  } else {
    channel = new BroadcastChannel(name);
    options.channel = channel;
    options.heartbeat = HEARTBEAT;
  }
  const elector = lib.elect(options);
  tabs.value.push({ key, label, token: elector.token, mode: elector.mode, leader: false, flash: 0 });
  held.set(key, { elector, channel, offs: [elector.onLead(() => led(key)), elector.onLost(() => lost(key))] });
  note(`${label} opens and asks to lead`);
  if (elector.leader) led(key);
};

const close = (key: number) => {
  const tab = tabOf(key);
  const entry = held.get(key);
  if (!tab || !entry) return;
  held.delete(key);
  for (const off of entry.offs) off();
  if (tab.leader) goneAt = performance.now();
  entry.elector.release();
  entry.channel?.close();
  tabs.value = tabs.value.filter((item) => item.key !== key);
  const how = mode.value === 'locks' ? 'its lock is let go' : 'it says bye';
  note(`${tab.label} closes${tab.leader ? ' (the leader)' : ''}: ${how}`);
};

const stop = () => {
  if (poll) clearInterval(poll);
  poll = null;
  for (const entry of held.values()) {
    for (const off of entry.offs) off();
    entry.elector.release();
    entry.channel?.close();
  }
  held = new Map();
  tabs.value = [];
};

const start = async () => {
  state.value = 'loading';
  try {
    lib ??= await import('virtual:syncom-demo');
    hasLocks.value = typeof navigator !== 'undefined' && typeof navigator.locks?.request === 'function';
    if (!hasLocks.value) mode.value = 'heartbeat';
    name = `syncom-demo:leader:${Math.random().toString(36).slice(2)}`;
    opened = 0;
    goneAt = null;
    log.value = [];
    for (let i = 0; i < START_TABS; i++) open();
    poll = setInterval(follow, 100);
    state.value = 'ready';
  } catch (cause) {
    error.value = String(cause);
    state.value = 'failed';
  }
};

const reset = async () => {
  stop();
  await start();
};

const switchMode = (value: string) => {
  if (value === mode.value || (value === 'locks' && !hasLocks.value)) return;
  mode.value = value as Mode;
  void reset();
};

const status = computed(() => {
  const leaders = tabs.value.filter((tab) => tab.leader);
  const others = tabs.value.length - leaders.length;
  if (tabs.value.length === 0) return { ok: false, text: 'No tab open: nobody leads. Open one.' };
  if (leaders.length === 0) {
    const wait = mode.value === 'locks' ? 'the next grant' : 'a beat with no leader heard';
    return { ok: false, text: `No leader yet: waiting for ${wait}` };
  }
  if (leaders.length > 1) {
    return {
      ok: false,
      text: `${leaders.length} leaders for a moment: the larger token yields when it hears the smaller one (the database's lock is the last word)`,
    };
  }
  const rest = others === 0 ? 'no other tab is open' : others === 1 ? 'the other tab follows' : `the other ${others} follow`;
  return { ok: true, text: `${leaders[0].label} leads; ${rest}` };
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
  stop();
});
</script>

<template>
  <div ref="root" class="sc-live">
    <div class="sc-live-head">
      <strong>Live demo</strong>
      <span>Tabs electing a leader with the real <code>elect()</code>, all in this page.</span>
      <span v-if="state === 'ready'" class="sc-live-actions">
        <Segmented label="Election" :items="MODES" :model-value="mode" @update:model-value="switchMode" />
        <button type="button" @click="reset">Reset</button>
      </span>
    </div>
    <p v-if="state === 'idle' || state === 'loading'" class="sc-live-wait">Opening three tabs…</p>
    <p v-else-if="state === 'failed'" class="sc-live-wait">The demo could not start: {{ error }}</p>
    <template v-else>
      <p v-if="!hasLocks" class="sc-live-note">This browser has no Web Locks: the tabs elect over the heartbeat.</p>
      <div class="sc-live-tabs">
        <section
          v-for="tab in tabs"
          :key="tab.key"
          :class="['sc-live-tab', { 'sc-live-tab-leader': tab.leader }]"
          :aria-label="`${tab.label}: ${tab.leader ? 'leader' : 'follower'}`"
        >
          <header>
            <span class="sc-live-dots" aria-hidden="true"><i /><i /><i /></span>
            <span class="sc-live-name">{{ tab.label }}</span>
            <button type="button" class="sc-live-close" :title="`Close ${tab.label}`" @click="close(tab.key)">×</button>
          </header>
          <div :key="tab.flash" :class="['sc-live-role', { 'sc-live-role-flash': tab.flash > 0 && tab.leader }]">
            {{ tab.leader ? 'leader' : 'follower' }}
          </div>
          <p class="sc-live-does">
            {{
              tab.leader
                ? 'Under openShared: opens the database, dials the peers, serves the others’ writes.'
                : 'Under openShared: reads, and sends its writes to the leader.'
            }}
          </p>
          <dl class="sc-live-meta">
            <dt>token</dt>
            <dd :title="tab.token">{{ tab.token }}</dd>
            <dt>mode</dt>
            <dd>{{ tab.mode }}</dd>
          </dl>
        </section>
        <button v-if="tabs.length < MAX_TABS" type="button" class="sc-live-new" @click="open">+ Open tab</button>
      </div>
      <ol class="sc-live-log">
        <li v-for="entry in log" :key="entry.key">{{ entry.text }}</li>
      </ol>
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
  align-items: center;
  gap: 6px 10px;
  margin-bottom: 12px;
  color: var(--vp-c-text-2);
}
.sc-live-head strong {
  color: var(--vp-c-text-1);
}
.sc-live-actions {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
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
  opacity: 0.5;
  cursor: default;
}
.sc-live-wait {
  margin: 24px 0;
  text-align: center;
  color: var(--vp-c-text-2);
}
.sc-live-note {
  margin: 0 0 10px;
  color: var(--vp-c-text-2);
}
.sc-live-tabs {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 10px;
  align-items: stretch;
}
.sc-live-tab {
  min-width: 0;
  padding: 0 10px 10px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 10px;
  background: var(--vp-c-bg);
  transition: border-color 0.25s;
}
.sc-live-tab-leader {
  border-color: var(--sc-accent);
  box-shadow: 0 0 0 1px var(--sc-accent);
}
.sc-live-tab header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 -10px 10px;
  padding: 5px 6px 5px 10px;
  border-bottom: 1px solid var(--vp-c-divider);
  border-radius: 10px 10px 0 0;
  background: var(--vp-c-default-soft);
}
.sc-live-dots {
  display: inline-flex;
  gap: 3px;
}
.sc-live-dots i {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--vp-c-text-3);
  opacity: 0.5;
}
.sc-live-name {
  flex: 1;
  font-weight: 700;
}
.sc-live .sc-live-close {
  padding: 0 6px;
  border-color: transparent;
  background: transparent;
  font-size: 14px;
  line-height: 18px;
}
.sc-live-role {
  display: inline-block;
  padding: 1px 9px;
  border-radius: 999px;
  background: var(--vp-c-default-soft);
  color: var(--vp-c-text-2);
  font-size: 12px;
  font-weight: 600;
}
.sc-live-tab-leader .sc-live-role {
  background: color-mix(in srgb, var(--sc-accent) 22%, transparent);
  color: var(--vp-c-text-1);
}
.sc-live-role-flash {
  animation: sc-live-flash 0.9s ease-out;
}
@keyframes sc-live-flash {
  from {
    box-shadow: 0 0 0 6px color-mix(in srgb, var(--sc-accent) 45%, transparent);
  }
  to {
    box-shadow: 0 0 0 0 transparent;
  }
}
.sc-live-does {
  min-height: 36px;
  margin: 8px 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--vp-c-text-2);
}
.sc-live-meta {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 0 8px;
  margin: 0;
  font-family: var(--vp-font-family-mono);
  font-size: 11px;
  color: var(--vp-c-text-2);
}
.sc-live-meta dd {
  margin: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  color: var(--vp-c-text-1);
}
.sc-live .sc-live-new {
  min-height: 120px;
  border-style: dashed;
  background: transparent;
  color: var(--vp-c-text-2);
}
.sc-live-log {
  min-height: 72px;
  margin: 12px 0 0;
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
  .sc-live-tabs {
    grid-template-columns: repeat(auto-fill, minmax(130px, 1fr));
  }
  .sc-live-actions {
    margin-left: 0;
  }
  .sc-live-log li {
    white-space: normal;
  }
}
@media (prefers-reduced-motion: reduce) {
  .sc-live-tab {
    transition: none;
  }
  .sc-live-role-flash {
    animation: none;
  }
}
</style>
