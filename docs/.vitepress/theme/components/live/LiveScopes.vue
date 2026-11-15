<script setup lang="ts">
// A live demo: three real syncom databases in this page — a server holding the tasks of two teams, and a laptop
// and a phone that dial it, each granted one team's scope — over @alexify/syncom/testing's in-process link with a
// latency you can see. A record's scope is `sync.scope(id, data)` (here its `team`; none is the global scope), a
// dialer asks for its scopes in `addNode({ scopes })`, and the host's `authorize(context, hello)` decides what each
// node may claim. The reader adds tasks on the server and sees each dialer receive only its own team's and
// everyone's; adds one of the other team on a dialer and sees it stay there, never sent; pushes it anyway, as a
// client ignoring its scopes would, and sees the server refuse it; revokes a grant (`sync.revoke`) and sees the
// dialer forget that scope's records. Everything shown is read from public API and events: `change`, the host's
// `hello`, `refused` and `revoke`, the dialer's `error`, `list()`/`get()`, `sync.listNodes()`, `sync.peers()`. The
// one thing no public API does is misbehave: "push anyway" sends the op in its wire form (`packOps`, not exported)
// through the link's `call`, the way a modified client could, so the host's boundary has something to refuse.
// Depicts: src/scope.js, src/commit.js, src/sync/hosting.js, src/sync/rules.js, src/sync/outbound.js,
// src/sync/manager.js.
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue';

type Name = 'laptop' | 'server' | 'phone';
type Dialer = 'laptop' | 'phone';
type Team = 'design' | 'dev' | 'everyone';
const NAMES: Name[] = ['laptop', 'server', 'phone'];
const DIALERS: Dialer[] = ['laptop', 'phone'];
const TEAMS: Team[] = ['design', 'dev', 'everyone'];
// What each node may claim at hello: the host's policy, which `authorize` enforces.
const GRANTS: Record<Dialer, string[]> = { laptop: ['design'], phone: ['dev'] };
const LATENCY = 450;
const IDEAS: Record<Team, string[]> = {
  design: ['Pick the palette', 'Draw the icons', 'Mock the settings page', 'Choose the font'],
  dev: ['Fix the login bug', 'Add the search index', 'Bump the driver', 'Profile the startup'],
  everyone: ['Plan the offsite', 'Write the release notes', 'Book the demo room'],
};

interface Task {
  id: string;
  title: string;
  team: Team;
  at: number;
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
const rows = reactive<Record<Name, Task[]>>({ laptop: [], server: [], phone: [] });
const logs = reactive<Record<Name, Entry[]>>({ laptop: [], server: [], phone: [] });
const drafts = reactive<Record<Name, string>>({ laptop: '', server: '', phone: '' });
const teams = reactive<Record<Name, Team>>({ laptop: 'design', server: 'design', phone: 'dev' });
// What each dialer asks for (its registry entry), and what the host granted at hello, less what it took back.
const asks = reactive<Record<Dialer, string[]>>({ laptop: [], phone: [] });
const granted = reactive<Record<Dialer, string[] | null>>({ laptop: null, phone: null });
// The ops a dialer wrote outside its scopes, by record id — what "push anyway" sends — and the ones refused.
const outside = reactive<Record<Dialer, Record<string, boolean>>>({ laptop: {}, phone: {} });
const refused = reactive<Record<Dialer, Record<string, boolean>>>({ laptop: {}, phone: {} });
const packets = ref<Packet[]>([]);
const quiet = ref(false);

let lib: any = null;
let mesh: any = null;
let links: Partial<Record<Dialer, any>> = {};
let ops: Record<Dialer, Map<string, any>> = { laptop: new Map(), phone: new Map() };
let names = new Map<string, Name>();
let serial = 0;
let generation = 0;
const refreshing = new Set<Name>();
const dirty = new Set<Name>();
let poll: ReturnType<typeof setInterval> | null = null;
let observer: IntersectionObserver | null = null;

const db = (name: Name) => mesh.get(name);
const scope = (_id: string, data: { team?: string }) => data.team ?? '*';
const teamOf = (data: { team?: string }): Team => (data.team === 'design' || data.team === 'dev' ? data.team : 'everyone');
const listed = (scopes: string[] | null) => (scopes === null ? '…' : scopes.length ? scopes.join(', ') : 'nothing');

const note = (name: Name, text: string, from: Name | 'you') => {
  logs[name].unshift({ key: ++serial, text, from });
  logs[name].splice(4);
};

// A task this dialer holds outside the scopes it asks for: written here, never sent.
const localOnly = (name: Name, task: Task) =>
  name !== 'server' && task.team !== 'everyone' && !asks[name as Dialer].includes(task.team);

const refresh = async (name: Name) => {
  if (!mesh) return;
  if (refreshing.has(name)) return void dirty.add(name);
  refreshing.add(name);
  try {
    const store = db(name);
    const tasks: Task[] = [];
    for (const id of await store.list()) {
      const data = await store.get(id);
      if (data) tasks.push({ id, title: data.title ?? '', team: teamOf(data), at: data.at ?? 0 });
    }
    tasks.sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1));
    rows[name] = tasks;
  } catch {
    // Closed by a reset: the next start reads again.
  } finally {
    refreshing.delete(name);
    if (dirty.delete(name)) void refresh(name);
  }
};

const measure = () => {
  if (!mesh) return;
  for (const name of DIALERS) asks[name] = db(name).sync.listNodes()[0]?.scopes ?? [];
  let pending = 0;
  for (const name of NAMES) for (const peer of db(name).sync.peers()) pending += peer.pending;
  quiet.value = pending === 0;
  for (const name of NAMES) void refresh(name);
};

const send = (origin: Name, to: Name, from: Name) => {
  const side = to === 'laptop' || from === 'laptop' ? 'left' : 'right';
  const packet: Packet = { key: ++serial, side, toward: to === 'server' ? 'server' : 'edge', origin };
  packets.value.push(packet);
  setTimeout(() => {
    packets.value = packets.value.filter((item) => item.key !== packet.key);
  }, LATENCY + 150);
};

// The host's events, attached before the mesh starts so the first hellos are heard.
const listenHost = (server: any) => {
  server.sync.on('hello', (event: { node: string; scopes: string[] }) => {
    const name = names.get(event.node) as Dialer | undefined;
    if (!name) return;
    granted[name] = event.scopes.slice();
    note('server', `hello: granted ${listed(event.scopes)}`, name);
  });
  server.sync.on('refused', (event: { node: string; reason: string; count: number }) => {
    const name = names.get(event.node) ?? 'you';
    const why = event.reason === 'scope' ? 'out of scope' : event.reason;
    note('server', `refused ${event.count} op${event.count === 1 ? '' : 's'}: ${why}`, name);
  });
  server.sync.on('revoke', (event: { node: string; scopes: string[] }) => {
    const name = names.get(event.node) as Dialer | undefined;
    if (!name || !granted[name]) return;
    const taken = new Set(event.scopes);
    granted[name] = (granted[name] ?? []).filter((item) => !taken.has(item));
    note('server', `revoked ${event.scopes.join(', ')} from the ${name}`, 'you');
  });
};

const start = async () => {
  state.value = 'loading';
  const mine = ++generation;
  try {
    lib ??= await import('virtual:syncom-demo');
    const engine = lib.memoryEngine();
    links = {};
    ops = { laptop: new Map(), phone: new Map() };
    names = new Map();
    for (const name of NAMES) logs[name] = [];
    for (const name of DIALERS) {
      granted[name] = null;
      outside[name] = {};
      refused[name] = {};
    }
    const authorize = (_context: unknown, hello: { node: string; scopes?: string[] }) => {
      const may = GRANTS[names.get(hello.node) as Dialer] ?? [];
      const asked = Array.isArray(hello.scopes) ? hello.scopes : ['*'];
      for (const item of asked) if (!may.includes(item)) return false;
      return true;
    };
    const made = await lib.createMesh(NAMES, [['laptop', 'server'], ['phone', 'server']], {
      createStorage: async (name: Name, options: any) => {
        const store = await lib.createDatabase({
          ...options,
          path: name,
          engine,
          lock: false,
          logger: false,
          sync: {
            ...options.sync,
            scope,
            connect: (node: any) => (links[name as Dialer] = options.sync.connect(node)),
          },
        });
        names.set(store.nodeId, name);
        if (name === 'server') {
          listenHost(store);
          // Seeded before the dialers start: they receive these through their first feed.
          await store.insert({ title: IDEAS.design[0], team: 'design', at: Date.now() });
          await store.insert({ title: IDEAS.dev[0], team: 'dev', at: Date.now() + 1 });
          await store.insert({ title: IDEAS.everyone[0], at: Date.now() + 2 });
        }
        return store;
      },
      link: { latency: LATENCY },
      scopes: GRANTS,
      unit: { access: 'public', authorize },
    });
    if (mine !== generation) return void (await made.close());
    mesh = made;
    for (const name of NAMES) {
      db(name).on('change', (op: any, via: any, meta: any) => {
        const title = meta.changes.find((change: any) => change.field === 'title')?.value;
        const what = title === undefined ? op.type : `+ ${JSON.stringify(title)} (${op.scope ?? 'everyone'})`;
        const origin = names.get(op.origin) ?? 'server';
        note(name, what, via ? origin : 'you');
        if (via) send(origin, name, names.get(via.node) ?? 'server');
        // A dialer's own write outside what it asks for stays here: kept, so it can be pushed anyway.
        const own = name === 'server' ? null : (db(name).sync.listNodes()[0]?.scopes ?? []);
        if (!via && own !== null && op.scope && !own.includes(op.scope)) {
          ops[name as Dialer].set(op.id, op);
          outside[name as Dialer][op.id] = true;
          note(name, 'out of scope: kept here, not sent', 'you');
        }
        void refresh(name);
      });
    }
    for (const name of DIALERS) {
      db(name).sync.on('error', (cause: { code?: unknown; scopes?: string[]; message?: string }) => {
        if (cause.code === 'REVOKED') note(name, `took back ${(cause.scopes ?? []).join(', ')}: forgotten here`, 'server');
        else if (cause.code === 403) note(name, 'refuses the feed (403): nothing granted', 'server');
        else note(name, `error ${String(cause.code ?? cause.message)}`, 'server');
        void refresh(name);
      });
    }
    measure();
    poll = setInterval(measure, 250);
    state.value = 'ready';
  } catch (cause) {
    error.value = String(cause);
    state.value = 'failed';
  }
};

const stop = async () => {
  generation++;
  if (poll) clearInterval(poll);
  poll = null;
  const closing = mesh;
  mesh = null;
  if (closing) await closing.close();
};

const reset = async () => {
  await stop();
  packets.value = [];
  for (const name of NAMES) rows[name] = [];
  await start();
};

const add = async (name: Name) => {
  const team = teams[name];
  const pool = IDEAS[team];
  const title = drafts[name].trim() || pool[rows[name].length % pool.length];
  drafts[name] = '';
  const data: Record<string, unknown> = { title, at: Date.now() };
  if (team !== 'everyone') data.team = team;
  await db(name).insert(data);
};

// The op as it was written, sent straight over the dialer's link: what a client that ignores its own scopes could
// do. The host holds the scopes it granted at hello, whatever the client sends.
const pushAnyway = async (name: Dialer, id: string) => {
  const op = ops[name].get(id);
  const link = links[name];
  if (!op || !link) return;
  try {
    const answer = await link.call('syncom/push', { ops: lib.packOps([op]) });
    if (answer.outOfScope > 0) {
      refused[name][id] = true;
      note(name, `refused it: outOfScope ${answer.outOfScope}`, 'server');
    } else {
      note(name, `answered applied ${answer.applied}`, 'server');
    }
  } catch (cause: any) {
    note(name, `push failed: ${String(cause?.code ?? cause?.message ?? cause)}`, 'server');
  }
};

const revoke = (name: Dialer, item: string) => db('server').sync.revoke(db(name).nodeId, [item]);

const status = computed(() => {
  if (!quiet.value) return { ok: false, text: 'Syncing…' };
  const held = DIALERS.map((name) => {
    const count = rows[name].filter((task) => !localOnly(name, task)).length;
    const grant = granted[name];
    return `the ${name} ${count} (granted ${listed(grant)})`;
  });
  return { ok: true, text: `The server holds ${rows.server.length} tasks; ${held.join(', ')}` };
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
      <span>A server and two dialers, each granted one scope, linked with {{ LATENCY }} ms of latency.</span>
      <button v-if="state === 'ready'" type="button" class="sc-live-reset" @click="reset">Reset</button>
    </div>
    <p v-if="state === 'idle' || state === 'loading'" class="sc-live-wait">Starting three databases…</p>
    <p v-else-if="state === 'failed'" class="sc-live-wait">The demo could not start: {{ error }}</p>
    <template v-else>
      <p class="sc-live-hint">
        Add tasks on the server in either team and watch where they go. Then add a task of the other team on a
        dialer, push it anyway, or revoke a grant.
      </p>
      <div class="sc-live-grid">
        <template v-for="(name, index) in NAMES" :key="name">
          <div v-if="index > 0" class="sc-live-link">
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
              <span v-if="name !== 'server'" class="sc-live-asks">asks for {{ listed(asks[name as Dialer]) }}</span>
              <span v-else class="sc-live-asks">hosts every scope</span>
            </header>
            <ul v-if="name === 'server'" class="sc-live-grants">
              <li v-for="dialer in DIALERS" :key="dialer">
                <span :class="`sc-live-from sc-live-from-${dialer}`">{{ dialer }}</span>
                <span v-if="granted[dialer] === null" class="sc-live-muted">not greeted yet</span>
                <template v-else>
                  <span v-if="granted[dialer]!.length === 0" class="sc-live-muted">nothing granted</span>
                  <span v-for="item in granted[dialer]" :key="item" class="sc-live-grant">
                    <span :class="`sc-live-team sc-live-team-${item}`">{{ item }}</span>
                    <button type="button" :title="`Revoke ${item} from the ${dialer}`" @click="revoke(dialer, item)">revoke</button>
                  </span>
                </template>
              </li>
            </ul>
            <ul class="sc-live-tasks">
              <li v-for="task in rows[name]" :key="task.id" :class="{ 'sc-live-held': localOnly(name, task) }">
                <span :class="`sc-live-team sc-live-team-${task.team}`">{{ task.team }}</span>
                <span class="sc-live-title" :title="task.title">{{ task.title }}</span>
                <template v-if="localOnly(name, task)">
                  <em v-if="refused[name as Dialer][task.id]" class="sc-live-flag">refused</em>
                  <template v-else>
                    <em class="sc-live-flag">local only</em>
                    <button
                      v-if="outside[name as Dialer][task.id]"
                      type="button"
                      title="Send it over the link as a client that ignores its scopes would"
                      @click="pushAnyway(name as Dialer, task.id)"
                    >
                      push anyway
                    </button>
                  </template>
                </template>
              </li>
              <li v-if="rows[name].length === 0" class="sc-live-muted">no tasks</li>
            </ul>
            <form class="sc-live-add" @submit.prevent="add(name)">
              <input v-model="drafts[name]" :aria-label="`New task on the ${name}`" placeholder="New task" />
              <select v-model="teams[name]" :aria-label="`Team of the new task on the ${name}`">
                <option v-for="team in TEAMS" :key="team" :value="team">{{ team }}</option>
              </select>
              <button type="submit">Add</button>
            </form>
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
  flex-wrap: wrap;
  align-items: baseline;
  justify-content: space-between;
  gap: 2px 8px;
  margin-bottom: 8px;
}
.sc-live-name {
  font-weight: 700;
}
.sc-live-asks,
.sc-live-muted {
  font-size: 11.5px;
  color: var(--vp-c-text-2);
}
.sc-live-grants {
  margin: 0 0 8px;
  padding: 0 0 8px;
  border-bottom: 1px dashed var(--vp-c-divider);
  list-style: none;
}
.sc-live-grants li {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 6px;
  margin: 0;
  min-height: 24px;
}
.sc-live-grant {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.sc-live-tasks {
  max-height: 168px;
  margin: 0;
  padding: 0;
  overflow-y: auto;
  list-style: none;
}
.sc-live-tasks li {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 2px 6px;
  min-height: 26px;
  margin: 0;
}
.sc-live-held .sc-live-title {
  color: var(--vp-c-text-2);
}
.sc-live-title {
  flex: 1 1 7em;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.sc-live-team {
  flex: none;
  padding: 0 7px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
  line-height: 18px;
  background: var(--vp-c-default-soft);
  color: var(--vp-c-text-2);
}
.sc-live-team-design {
  background: color-mix(in srgb, var(--sc-peer-a) 18%, transparent);
  color: var(--vp-c-text-1);
}
.sc-live-team-dev {
  background: color-mix(in srgb, var(--sc-peer-c) 20%, transparent);
  color: var(--vp-c-text-1);
}
.sc-live-flag {
  flex: none;
  font-size: 11px;
  color: var(--vp-c-text-2);
}
.sc-live-add {
  display: flex;
  gap: 4px;
  margin-top: 8px;
}
.sc-live-add input,
.sc-live-add select {
  min-width: 0;
  padding: 2px 6px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 6px;
  background: var(--vp-c-bg-soft);
  color: var(--vp-c-text-1);
  font-size: 12.5px;
}
.sc-live-add input {
  flex: 1;
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
  padding-left: 46px;
  text-indent: -46px;
}
.sc-live-from {
  display: inline-block;
  min-width: 42px;
  font-weight: 700;
  text-indent: 0;
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
