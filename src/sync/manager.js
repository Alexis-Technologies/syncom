'use strict';

// Replication between nodes. Two halves live here:
//
//   SyncManager — the DIALING side. For every registered node it asks the
//   injected `connect(node)` factory for a link (a duck-typed SyncLink — the
//   `@alexify/syncom/wrpc` subpath wraps a WrpcClient into one), then runs
//   the handshake: hello, push what the host lacks, subscribe to what the
//   host learns from now on. Reconnecting, backing off and resuming the
//   subscription from the last event id are the LINK's job (wrpc already
//   does all three); on `reconnect` the manager only repeats hello + push,
//   the outbound half a transport cannot know about.
//
//   unit() — the HOSTING side, built in src/sync/hosting.js: a plain object of
//   `{ access, handler }` procedures shaped for wrpc's defineRouter, with no
//   import of wrpc. The manager lends it the storage, the wakers every live
//   `changes` feed waits on, and the set `hosted()` lists.
//
// Every node is both: a mesh is nodes dialing whichever nodes they can
// reach, with ops relayed transitively and de-duplicated by version vector.

const { Emitter } = require('../utils.js');
const { packOps, unpackOps } = require('../ops.js');
const { vectorAdvance, vectorMerge, keyScope, opKey } = require('../vector.js');
const { outbound, unreachable } = require('../outbound.js');
const { isSyncLink } = require('../link.js');
const { writerOf, traced } = require('../telemetry.js');
const { notify, runHook, normalizeHooks } = require('../hooks.js');
const { GLOBAL_SCOPE, inScope, opInScope } = require('../scope.js');
const { PROTOCOL, DEFAULT_PAGE_SIZE, schemaOf, kindsOf } = require('../protocol.js');
const { createUnit } = require('./hosting.js');
const { SyncomError } = require('../errors.js');
const { wellFormed, VERDICT } = require('../shape.js');
const { SIGNER, REWIND } = require('../symbols.js');

const REMOTE = 'remote';
// A page that fails this many times in a row leaves its peer `stuck`.
const MAX_PAGE_RETRIES = 3;
// A host that answers 428 to this many fresh hellos in a row is not going to
// remember us; the dialer stops greeting and reports a loop.
const MAX_REHELLOS = 5;
// Ops queued for a peer beyond this are dropped — the vector-based push that
// recovers the peer carries what it lacks, and memory is not a buffer.
const DEFAULT_MAX_OUTBOX = 10_000;
// The bytes a streamed snapshot page may carry: a host's page is bounded by
// its own pageSize, and a host that streams without end must not take this
// node's memory with it.
const DEFAULT_MAX_PAGE_BYTES = 256 * 1024 * 1024;
// A failed recovery waits this long (doubling, by timestamp) before the next.
const RECOVER_BACKOFF = 1000;
const MAX_RECOVER_BACKOFF = 60_000;

// The hooks a manager accepts (`open({ sync: { hooks } })`). There is no
// hook on what leaves for a peer: seqs run contiguously per origin and
// scope, so an op withheld from one peer is a gap that stops every later
// op of that stream at it — per-peer visibility is what scopes are for.
const SYNC_HOOKS = ['beforeConnect', 'beforeBootstrap'];
// What #connect's chain carries when beforeConnect said no.
const NOT_DIALLED = Symbol('syncom.notDialled');

// Node registry entries are keyed by url; the file name is the url itself,
// percent-encoded — unlike the old `<host>.json`, two peers on one host or a
// url without a port cannot collide.
const fileName = (url) => `${encodeURIComponent(url)}.json`;

// The part of a vector that concerns `scopes`: global keys (`origin`) and
// the `origin@scope` keys of the scopes asked for.
const scopedVector = (vector, scopes) => {
  if (!scopes || scopes.includes(GLOBAL_SCOPE)) return vector;
  const asked = new Set(scopes);
  const out = {};
  const keys = Object.keys(vector);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const scope = keyScope(key);
    if (scope === null || asked.has(scope)) out[key] = vector[key];
  }
  return out;
};

class SyncManager extends Emitter {
  #storage;
  #path;
  #options;
  #nodes = new Map();
  #peers = new Map();
  #wakers = new Set();
  #feeds = new Set();
  #onChange = null;
  #started = false;
  // The presence instances this manager carries (`presence()`): their
  // updates go to every connected peer, a peer's come back to them.
  #presences = new Set();
  #saving = new Map();
  #otel;
  #hooks;
  #fsi;
  #maxOutbox = DEFAULT_MAX_OUTBOX;
  #maxPageBytes = DEFAULT_MAX_PAGE_BYTES;

  constructor(storage, options = {}) {
    super({ maxListeners: options?.maxListeners });
    this.#storage = storage;
    this.#options = options ?? {};
    this.#hooks = normalizeHooks(this.#options.hooks, SYNC_HOOKS, 'SyncManager');
    const { maxOutbox } = this.#options;
    if (maxOutbox !== undefined && !(Number.isInteger(maxOutbox) && maxOutbox > 0)) {
      throw new TypeError('sync.maxOutbox must be a positive integer');
    }
    if (maxOutbox !== undefined) this.#maxOutbox = maxOutbox;
    const { maxPageBytes } = this.#options;
    if (maxPageBytes !== undefined) {
      if (!((Number.isInteger(maxPageBytes) && maxPageBytes > 0) || maxPageBytes === Infinity)) {
        throw new TypeError('sync.maxPageBytes must be a positive integer (Infinity to disable)');
      }
      this.#maxPageBytes = maxPageBytes;
    }
    this.#otel = writerOf(storage.telemetry);
    // Reserved for the broker-backed hub mode (see src/shared-log.js).
    if (this.#options.sharedLog !== undefined) {
      throw new TypeError('sync.sharedLog is reserved: the shared-log hub mode is not in this version');
    }
    // The registry lives where the storage does: over its backend.
    this.#fsi = storage.fsi;
    this.#path = `${storage.path}/${REMOTE}`;
    return this.#init();
  }

  async #init() {
    const files = await this.#fsi.list(this.#path);
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      // A registry file is rewritten on every page received; one torn by a
      // crash is reported and skipped, not fatal to the open.
      let node = null;
      try {
        node = JSON.parse(await this.#fsi.read(this.#path, file));
      } catch (error) {
        this.#storage.logger.warn({ event: 'sync.node.unreadable', file, err: error });
        continue;
      }
      if (node && typeof node.url === 'string') this.#nodes.set(node.url, node);
    }
    // One listener for both halves: the dialing side's fan-out to its
    // links, and the hosting side's wake-up of every live `changes` feed.
    this.#onChange = (op, via) => this.#fanOut(op, via);
    this.#storage.on('change', this.#onChange);
    const { connect, autoStart = typeof connect === 'function' } = this.#options;
    // A node that dials keeps its own ops until every node it syncs with has
    // them: nobody else can hand a host what this node wrote offline, so
    // retention compacts only what was delivered (and what others made).
    if (typeof connect === 'function') this.#storage.log.retain((entry) => this.#undelivered(entry));
    if (autoStart && typeof connect === 'function') await this.start();
    return this;
  }

  get storage() {
    return this.#storage;
  }

  get started() {
    return this.#started;
  }

  // ---------------------------------------------------------------------
  // Registry

  async addNode(nodeData) {
    const { url, token, scopes } = nodeData ?? {};
    if (typeof url !== 'string' || url.length === 0) throw new TypeError('Node URL is required');
    if (this.#nodes.has(url)) throw new SyncomError('NODE_EXISTS', `Node with URL ${url} already exists`, { url });
    if (scopes !== undefined) {
      if (!Array.isArray(scopes)) throw new TypeError('Node scopes must be an array of strings');
      for (let i = 0; i < scopes.length; i++) {
        if (typeof scopes[i] !== 'string') throw new TypeError('Node scopes must be an array of strings');
      }
    }
    const node = {
      url,
      token,
      scopes: scopes ?? [GLOBAL_SCOPE],
      enabled: true,
      lastSync: null,
      cursor: null,
      remote: null,
    };
    this.#nodes.set(url, node);
    await this.#fsi.write(this.#path, fileName(url), JSON.stringify(node), { atomic: true });
    notify(this, this.#storage.logger, 'node', { url, action: 'add' });
    if (this.#started) this.#connect(node);
  }

  async removeNode(url) {
    const node = this.#nodes.get(url);
    if (!node) throw new SyncomError('NODE_NOT_FOUND', `Node with URL ${url} not found`, { url });
    this.#nodes.delete(url);
    this.#disconnect(url);
    await this.#fsi.remove(this.#path, fileName(url));
    notify(this, this.#storage.logger, 'node', { url, action: 'remove' });
  }

  listNodes() {
    const out = [];
    for (const node of this.#nodes.values()) out.push({ ...node });
    return out;
  }

  async enableNode(url, enabled = true) {
    const node = this.#nodes.get(url);
    if (!node) throw new SyncomError('NODE_NOT_FOUND', `Node with URL ${url} not found`, { url });
    node.enabled = enabled;
    await this.#saveNode(node);
    notify(this, this.#storage.logger, 'node', { url, action: enabled ? 'enable' : 'disable' });
    if (!enabled) this.#disconnect(url);
    else if (this.#started) this.#connect(node);
  }

  // Registry writes are coalesced AND serialized per node: cursors move on
  // every batch, so calls that land while a write is pending share it, and
  // one that lands while a write is in flight runs after it — two writes to
  // one file interleaving is how a reopen reads half a JSON document.
  #saveNode(node) {
    const { url } = node;
    if (!this.#nodes.has(url)) return Promise.resolve();
    let state = this.#saving.get(url);
    if (!state) {
      state = { last: Promise.resolve(), next: null };
      this.#saving.set(url, state);
    }
    if (state.next) return state.next;
    const write = state.last.then(async () => {
      state.next = null;
      if (!this.#nodes.has(url)) return;
      await this.#fsi.write(this.#path, fileName(url), JSON.stringify(node), { atomic: true });
    });
    state.next = write;
    state.last = write
      .catch(() => {})
      .then(() => {
        if (state.next === null) this.#saving.delete(url);
      });
    return write;
  }

  // Whether `key` of a peer's vector is one of this node's own streams
  // (`origin`, `origin@scope`) and `seq` a seq the peer holds of it.
  #owns(key, seq) {
    const own = this.#storage.nodeId;
    return (key === own || key.startsWith(`${own}@`)) && Number.isSafeInteger(seq) && seq > 0;
  }

  // What a peer is known to hold of this node's own streams: replaced by a
  // hello's vector (a reinstalled host holds less than before), raised by
  // a push's answer. Saved with the registry entry, so the log keeps the
  // right ops across a restart too.
  #ack(node, vector, replace = false) {
    const acked = replace ? {} : { ...node.acked };
    const keys = vector && typeof vector === 'object' ? Object.keys(vector) : [];
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      const seq = vector[key];
      if (this.#owns(key, seq) && !(acked[key] >= seq)) acked[key] = seq;
    }
    node.acked = acked;
  }

  // An entry of this node's own that an enabled registered node in its
  // scope has not acknowledged. Only registered nodes are waited for: ops
  // written before the first node was added are retained like any others
  // (a host that lacks them is told UNDELIVERABLE). An op born from a node's
  // snapshot never travels back to it, so that node is not waited for.
  #undelivered(entry) {
    const { op } = entry;
    if (op.origin !== this.#storage.nodeId) return false;
    for (const node of this.#nodes.values()) {
      if (!node.enabled || !opInScope(op, node.scopes)) continue;
      if (op.from !== undefined && op.from === node.remote?.id) continue;
      if (!((node.acked?.[opKey(op)] ?? 0) >= op.seq)) return true;
    }
    return false;
  }

  // ---------------------------------------------------------------------
  // The dialing side

  async start() {
    if (this.#started) return;
    if (typeof this.#options.connect !== 'function') {
      throw new TypeError('sync.start() needs a connect(node) factory in the storage sync options');
    }
    this.#started = true;
    for (const node of this.#nodes.values()) {
      if (node.enabled) this.#connect(node);
    }
    notify(this, this.#storage.logger, 'start');
  }

  async stop() {
    this.#started = false;
    for (const url of [...this.#peers.keys()]) this.#disconnect(url);
    const writes = [];
    for (const state of this.#saving.values()) writes.push(state.last);
    await Promise.all(writes);
    notify(this, this.#storage.logger, 'stop');
  }

  /** Pushes whatever the connected peers lack right now; resolves when done. */
  async sync(url) {
    // An enabled node whose dial failed has no peer: it is dialled again.
    if (this.#started) {
      for (const node of this.#nodes.values()) {
        if (node.enabled && (url === undefined || node.url === url)) this.#connect(node);
      }
    }
    let peers;
    if (url) {
      const peer = this.#peers.get(url);
      peers = peer ? [peer] : [];
    } else {
      peers = [...this.#peers.values()];
    }
    const results = [];
    for (const peer of peers) {
      if (!peer.remote) continue;
      const pushed = await this.#push(peer, 'manual');
      peer.behind = false;
      results.push({ url: peer.node.url, pushed });
    }
    return results;
  }

  /** Ops queued for peers, over every dialed peer — what the outbox gauge reads. */
  pendingOps() {
    let total = 0;
    for (const peer of this.#peers.values()) total += peer.outbox.length;
    return total;
  }

  /** Live view of every dialed peer. */
  peers() {
    const out = [];
    for (const peer of this.#peers.values()) {
      out.push({
        url: peer.node.url,
        node: peer.remote?.id ?? null,
        connected: peer.connected,
        subscribed: Boolean(peer.subscription),
        cursor: peer.node.cursor,
        lastSync: peer.node.lastSync,
        pending: peer.outbox.length + (peer.inflight ? 1 : 0),
        behind: peer.behind,
        stuck: peer.stuck,
        lastError: peer.lastError,
      });
    }
    return out;
  }

  /** Hosting side: every peer with a live `changes` feed on this node. */
  hosted() {
    const out = [];
    for (const feed of this.#feeds) out.push({ ...feed, scopes: feed.scopes === null ? null : [...feed.scopes] });
    return out;
  }

  #connect(node) {
    if (this.#peers.has(node.url) && !this.#peers.get(node.url).failed) return;
    const peer = {
      node,
      // What the application sees as `via` on a change, an apply, a hook:
      // the peer by url and node id, never the link or its token.
      ref: { url: node.url, node: null },
      lastError: null,
      link: null,
      remote: null,
      connected: false,
      subscription: null,
      outbox: [],
      // Every push to this peer runs on this chain (see #serializePush);
      // `inflight` is what peers() shows while one runs.
      pushing: Promise.resolve(),
      inflight: false,
      flushQueued: false,
      // A relay that failed: what the host lacks is pushed from the vector
      // at the next sign of life on the link (see #recover), backed off by
      // timestamp after a failed recovery.
      behind: false,
      recovering: false,
      recoverAfter: 0,
      backoff: 0,
      rehellos: 0,
      bootstrapping: false,
      handshaking: null,
      closed: false,
      handlers: null,
      // Inbound pages run one after another; `feed` numbers the
      // subscription they came on, so pages of a closed one are dropped.
      inbound: Promise.resolve(),
      feed: 0,
      failures: 0,
      stuck: false,
      // The dial itself failed — no link: the next sync() dials again.
      failed: false,
      // Streams of this node's own the host claimed more of at the last
      // hello, without proof: nothing of them goes to it (see #rewind).
      rewound: null,
    };
    this.#peers.set(node.url, peer);
    Promise.resolve()
      // beforeConnect sees a copy of the registry entry; `false` leaves the
      // node registered but not dialled — no peer, no error.
      .then(() => runHook(this.#hooks, 'beforeConnect', { ...node }))
      .then((verdict) => {
        if (verdict !== false) return this.#options.connect(node);
        if (this.#peers.get(node.url) === peer) this.#peers.delete(node.url);
        return NOT_DIALLED;
      })
      .then((link) => {
        if (link === NOT_DIALLED) return;
        if (peer.closed) return void link?.close?.();
        if (!isSyncLink(link)) {
          throw new TypeError('connect(node) must return a SyncLink (call/subscribe/on/off/close)');
        }
        peer.link = link;
        peer.handlers = {
          // A host's presence event: its own, or what it relays of its
          // room — the host checked who said what, a signature says the rest.
          'syncom/presence': (update) => {
            this.receivePresence(update, null).catch((error) => {
              this.#storage.logger.warn({ event: 'sync.presence.receive', url: peer.node.url, err: error });
            });
          },
          open: () => {
            peer.connected = true;
          },
          close: () => {
            peer.connected = false;
            peer.subscription = null;
            notify(this, this.#storage.logger, 'peer', { url: node.url, connected: false });
          },
          reconnect: () => {
            peer.connected = true;
            notify(this, this.#storage.logger, 'peer', { url: node.url, connected: true, reconnected: true });
            // The link restored the subscription itself (when the host still
            // knows us); what it cannot restore is the outbound half.
            this.#handshake(peer, { resubscribe: !peer.subscription }).catch((error) => this.#fail(peer, error));
          },
        };
        const events = Object.keys(peer.handlers);
        for (let i = 0; i < events.length; i++) link.on(events[i], peer.handlers[events[i]]);
        peer.connected = true;
        notify(this, this.#storage.logger, 'connect', { url: node.url });
        return this.#handshake(peer, { resubscribe: true });
      })
      .catch((error) => {
        // No link came of it: peers() still shows the node and its error,
        // and the next sync() dials it again.
        if (peer.link === null) peer.failed = true;
        this.#fail(peer, error);
      });
  }

  #disconnect(url) {
    const peer = this.#peers.get(url);
    if (!peer) return;
    peer.closed = true;
    this.#peers.delete(url);
    if (peer.link) {
      if (peer.handlers) {
        const events = Object.keys(peer.handlers);
        for (let i = 0; i < events.length; i++) peer.link.off(events[i], peer.handlers[events[i]]);
      }
      peer.subscription?.unsubscribe?.();
      try {
        peer.link.close();
      } catch {
        // A link already gone is what close() was for.
      }
    }
  }

  #fail(peer, error) {
    if (peer.closed) return;
    peer.lastError = { code: error?.code ?? null, message: error?.message ?? String(error), at: Date.now() };
    this.#storage.logger.warn({ event: 'sync.error', url: peer.node.url, err: error });
    notify(this, this.#storage.logger, 'error', Object.assign(error, { url: peer.node.url }));
  }

  // The same schema version with another snapshot hash on the far side: not
  // a version difference (the lens handles those) but two builds of "the
  // same" schema that disagree. Reported, never refused — `authorize` sees
  // `hello.schema` for a host that wants to refuse.
  #drift(theirs, peer) {
    const mine = this.#storage.schemaInfo;
    if (!mine || !theirs || mine.version !== theirs.version) return;
    if (!mine.hash || !theirs.hash || mine.hash === theirs.hash) return;
    const logger = this.#storage.logger;
    logger.warn({ event: 'schema.drift', peer: peer.node, version: mine.version });
    notify(this.#storage, logger, 'schema', {
      kind: 'drift',
      peer,
      version: mine.version,
      hash: theirs.hash,
      local: mine.hash,
    });
  }

  // Single-flight: a reconnect and a refused restored subscription can both
  // ask for one in the same tick.
  #handshake(peer, options) {
    if (peer.handshaking) return peer.handshaking;
    peer.handshaking = this.#hello(peer, options).finally(() => {
      peer.handshaking = null;
    });
    return peer.handshaking;
  }

  async #hello(peer, { resubscribe }) {
    const { node, link } = peer;
    const answer = await link.call('syncom/hello', {
      node: this.#storage.nodeId,
      vector: this.#storage.vector,
      version: PROTOCOL,
      scopes: node.scopes,
      // For `authorize(context, hello)`; a transport-level credential (a
      // wrpc `headers`/`authenticate` option) is the other way to carry it.
      token: node.token,
      schema: schemaOf(this.#storage.schemaInfo),
      kinds: this.#storage.kinds,
    });
    if (peer.closed) return;
    if (!answer || typeof answer.node !== 'string') throw new SyncomError('BAD_HELLO', `Bad hello from ${node.url}`);
    if (answer.duplicate) {
      // A host may say it already dials us; one link is enough.
      this.#disconnect(node.url);
      return;
    }
    // A host reinstalled since we last spoke: its log speaks another epoch,
    // so our cursor is void and the subscription will say `bootstrap`.
    if (node.remote && node.remote.epoch !== answer.epoch) node.cursor = null;
    const schema = schemaOf(answer.schema);
    peer.remote = { id: answer.node, vector: answer.vector ?? {}, epoch: answer.epoch, kinds: kindsOf(answer.kinds) };
    peer.ref.node = answer.node;
    node.remote = { id: answer.node, epoch: answer.epoch, schema };
    // Before anything is pushed: a rewound node moves its streams past what
    // the host holds, then takes the host's state back in a bootstrap.
    const rewound = await this.#rewind(peer, answer);
    this.#ack(node, answer.vector, true);
    peer.undeliverable = false;
    await this.#saveNode(node);
    notify(this, this.#storage.logger, 'peer', { url: node.url, connected: true, node: answer.node, schema });
    this.#drift(schema, { url: node.url, node: answer.node });
    // Greeted: the host learns this node's presence, and relays it.
    this.#sendPresence(peer);
    try {
      await this.#push(peer, 'handshake');
      peer.behind = false;
    } catch (error) {
      // Reported by the caller; what the host lacks waits for #recover. The
      // inbound half does not wait on it: the feed opens (but for a rewound
      // node, which bootstraps first), and its pages are the sign of life
      // the recovery pushes at.
      this.#fallBehind(peer, null);
      if (resubscribe && !rewound && !peer.subscription && !peer.closed) this.#subscribe(peer);
      throw error;
    }
    // The state the lost ops made is in the host's: joined back, and the
    // bootstrap subscribes from where its first page was taken.
    if (rewound) await this.#bootstrap(peer);
    if (resubscribe && !peer.subscription) this.#subscribe(peer);
  }

  // The host holds more of this node's own streams than its log does: the
  // directory was restored from an older copy (or another instance runs
  // with its identity), and ops minted from here would reuse seqs the host
  // already has — dropped there as duplicates. Or the host says so and
  // lies: a stream moved on its word is a gap at every other peer, or past
  // a safe integer and malformed everywhere. So a stream moves past the
  // host's on proof alone — the op the host holds at the seq it claims,
  // this node's own and signed by its key (`answer.proof`, hosting.js) — or
  // under `sync.rewind: 'adopt'`. Reported either way, with what moved
  // (`adopted`); a stream that did not move goes to that host no more until
  // the next hello. Writes made since the restore and before this hello are
  // lost to the host. A proven op is also what the stream's next op chains
  // to (its fingerprint, the stream's head); a stream adopted without one
  // names no predecessor for it. True when something moved: the bootstrap
  // follows.
  async #rewind(peer, answer) {
    const { log } = this.#storage;
    const { vector } = answer;
    const local = {};
    let remote = null;
    peer.rewound = null;
    const keys = vector && typeof vector === 'object' ? Object.keys(vector) : [];
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      const seq = vector[key];
      if (!this.#owns(key, seq)) continue;
      const held = log.seqOf(key);
      if (seq <= held) continue;
      (remote ??= {})[key] = seq;
      local[key] = held;
    }
    if (remote === null) return false;
    const { proven, proofs } = await this.#proven(remote, answer.proof);
    const taking = this.#options.rewind === 'adopt' ? remote : proven;
    let op = null;
    if (Object.keys(taking).length > 0) {
      op = await this.#storage[REWIND](taking, { via: peer.ref, from: peer.remote.id, proofs });
    }
    const adopted = op === null ? {} : { ...op.vector };
    const stays = Object.keys(remote);
    for (let i = 0; i < stays.length; i++) {
      if (!Object.hasOwn(adopted, stays[i])) (peer.rewound ??= new Set()).add(stays[i]);
    }
    const message = `${peer.node.url} holds more of this node's ops than its log: a restored copy, a second instance or a false claim`;
    this.#fail(peer, new SyncomError('REWOUND', message, { local, remote, adopted }));
    return op !== null;
  }

  // Of a host's claims on this node's own streams, the ones its hello
  // proves: the op it holds at the seq it claims, this node's own (origin,
  // stream, seq) and signed by this node's key — what no host can make —
  // and the ops themselves (`proofs`), what the streams chain on from.
  // Nothing is proven without the signing plugin: the key is the proof.
  async #proven(remote, proof) {
    const identity = this.#storage[SIGNER];
    const proven = {};
    const proofs = [];
    if (!identity || !Array.isArray(proof)) return { proven, proofs };
    const ops = unpackOps(proof);
    for (let i = 0; i < ops.length; i++) {
      const op = ops[i];
      if (!wellFormed(op) || op.origin !== this.#storage.nodeId || op.sig === undefined) continue;
      const key = opKey(op);
      if (!Object.hasOwn(remote, key) || remote[key] !== op.seq) continue;
      try {
        if ((await identity.verify(op, 'require')) !== VERDICT.OK) continue;
        proven[key] = op.seq;
        proofs.push(op);
      } catch {
        // A proof that cannot be checked proves nothing.
      }
    }
    return { proven, proofs };
  }

  // Every push to a peer — handshake, manual, relay, recovery — runs on one
  // chain: two never overlap, so the vector a push answers with is always
  // the latest and no op is in flight twice.
  #serializePush(peer, task) {
    const run = peer.pushing.then(async () => {
      peer.inflight = true;
      try {
        return await task();
      } finally {
        peer.inflight = false;
      }
    });
    peer.pushing = run.catch(() => {});
    return run;
  }

  // A push that failed, or an outbox that overflowed: the peer is `behind`,
  // and what it lacks is recomputed from the vector at the next sign of life
  // on the link (see #recover) — not on a timer, which is the link's business.
  #fallBehind(peer, error) {
    if (peer.closed) return;
    peer.behind = true;
    peer.recoverAfter = Date.now() + peer.backoff;
    peer.backoff = peer.backoff === 0 ? RECOVER_BACKOFF : Math.min(peer.backoff * 2, MAX_RECOVER_BACKOFF);
    if (error) this.#fail(peer, error);
  }

  // A page received from the peer, or an op to relay to it: if it is behind,
  // catch it up the way a handshake does — one recovery at a time, `behind`
  // cleared only once it went through, backed off after one that failed.
  #recover(peer) {
    if (!peer.behind || peer.recovering || !peer.connected || !peer.remote) return;
    if (Date.now() < peer.recoverAfter) return;
    peer.recovering = true;
    this.#push(peer, 'recover').then(
      () => {
        peer.recovering = false;
        peer.behind = false;
      },
      (error) => {
        peer.recovering = false;
        this.#fallBehind(peer, error);
      },
    );
  }

  #push(peer, reason) {
    return this.#serializePush(peer, () => this.#pushFromLog(peer, reason));
  }

  // Everything in our log the host has not seen, by its vector — ops of its
  // own origin excluded (it has those by definition); src/outbound.js picks
  // them, as a branch merge does. A host that is behind what we still
  // retain cannot be caught up from here; it will bootstrap from a node
  // that dials it, or we from it.
  async #pushFromLog(peer, reason) {
    const { ops, first } = outbound(this.#storage.log, {
      exclude: peer.remote.id,
      vector: peer.remote.vector,
      scopes: peer.node.scopes,
      own: this.#storage.nodeId,
    });
    const missing = this.#lost(peer, first);
    const { rewound } = peer;
    if (missing === null && rewound === null) return this.#send(peer, ops, reason);
    const sending = [];
    for (let i = 0; i < ops.length; i++) {
      const key = opKey(ops[i]);
      if (missing !== null && Object.hasOwn(missing, key)) continue;
      if (rewound !== null && rewound.has(key)) continue;
      sending.push(ops[i]);
    }
    return this.#send(peer, sending, reason);
  }

  // Our own streams the host cannot be caught up on from this log (null
  // when none): what it holds stops short of the first op retained here.
  // Reported once per hello; their ops stay unsent — every one would be a
  // gap at the host.
  #lost(peer, first) {
    const missing = unreachable(first, peer.remote.vector);
    if (Object.keys(missing).length === 0) return null;
    if (!peer.undeliverable) {
      peer.undeliverable = true;
      const message = `${peer.node.url} lacks ops of this node that its log no longer holds`;
      this.#fail(peer, new SyncomError('UNDELIVERABLE', message, { missing }));
    }
    return missing;
  }

  // One span per push, whatever its page count: with wrpc underneath, the
  // `syncom/push` client span of every page nests under it, and the server
  // span on the far side under that — the link carries the context.
  // `reason` says what caused it: a handshake, a manual sync(), a relay of
  // ops that just landed, or a recovery push after a failed one.
  async #send(peer, ops, reason) {
    const otel = this.#otel;
    if (!otel.enabled || ops.length === 0) return this.#sendPages(peer, ops);
    const attributes = {
      'syncom.push.reason': reason,
      'syncom.ops.count': ops.length,
      'syncom.peer.url': peer.node.url,
      'syncom.peer.node': peer.remote.id,
    };
    const pages = Math.ceil(ops.length / (this.#options.pageSize ?? DEFAULT_PAGE_SIZE));
    let result = 'error';
    try {
      const sent = await traced(
        otel,
        'syncom.push',
        attributes,
        () => this.#sendPages(peer, ops),
        () => ({
          'syncom.pages': pages,
        }),
      );
      result = 'ok';
      return sent;
    } finally {
      otel.recordPush(reason, result, ops.length);
    }
  }

  async #sendPages(peer, ops) {
    const pageSize = this.#options.pageSize ?? DEFAULT_PAGE_SIZE;
    let sent = 0;
    for (let index = 0; index < ops.length; index += pageSize) {
      const page = ops.slice(index, index + pageSize);
      const answer = await peer.link.call('syncom/push', { ops: packOps(page) });
      // The host answers with the keys the page touched; merged, never replaced.
      if (answer?.vector) {
        vectorMerge(peer.remote.vector, answer.vector);
        this.#ack(peer.node, answer.vector);
      }
      if (answer?.gaps > 0) {
        // Ops the host could not take in order: it lacks earlier ones of
        // their streams, which this page did not carry.
        this.#storage.logger.warn({ event: 'sync.push.gaps', url: peer.node.url, gaps: answer.gaps });
      }
      sent += page.length;
    }
    peer.backoff = 0;
    if (sent > 0 && !peer.closed) {
      peer.node.lastSync = Date.now();
      await this.#saveNode(peer.node);
      notify(this, this.#storage.logger, 'sync', { url: peer.node.url, pushed: sent });
    }
    return sent;
  }

  #subscribe(peer) {
    const { node, link } = peer;
    const feed = ++peer.feed;
    peer.subscription = link.subscribe(
      'syncom/changes',
      { scopes: node.scopes },
      {
        lastEventId: node.cursor ?? undefined,
        // One page after another: a page that fails must stop the ones
        // behind it from moving the cursor past it (see #pageFailed).
        onData: (value, eventId) => {
          peer.inbound = peer.inbound
            .then(() => this.#receive(peer, value, eventId, feed))
            .catch((error) => this.#pageFailed(peer, feed, error));
        },
        onError: (error) => {
          peer.subscription = null;
          if (peer.closed) return;
          // 428 "say hello first": the host forgot us — on wrpc a reconnect
          // is a new server-side client, and its restored subscription
          // arrives before our hello does. Greet again, then subscribe.
          if (error?.code === 428 && peer.connected) {
            if (++peer.rehellos > MAX_REHELLOS) {
              const message = `The host answered 428 to ${MAX_REHELLOS} fresh hellos in a row; not greeting again`;
              this.#fail(peer, new SyncomError('HANDSHAKE_LOOP', message, { cause: error }));
              return;
            }
            this.#handshake(peer, { resubscribe: true }).catch((e) => this.#fail(peer, e));
            return;
          }
          this.#fail(peer, error);
        },
        onEnd: () => {
          peer.subscription = null;
        },
      },
    );
  }

  // A page that could not be applied is a break in the stream, not a page to
  // step over: the subscription is closed (its queued pages are dropped —
  // they carry another feed number) and reopened from the last cursor that
  // was saved, so the page comes again. Bounded: a page that fails
  // MAX_PAGE_RETRIES times in a row leaves the peer `stuck` — reported, and
  // the application's to resolve (enableNode off and on, or a bootstrap).
  #pageFailed(peer, feed, error) {
    if (peer.closed || feed !== peer.feed) return;
    peer.failures++;
    peer.subscription?.unsubscribe?.();
    peer.subscription = null;
    const stuck = peer.failures >= MAX_PAGE_RETRIES;
    const message = `Page after ${peer.node.cursor ?? 'the start'} failed (${error?.message ?? error})`;
    const reported = new SyncomError(stuck ? 'STUCK' : 'PAGE_FAILED', message, {
      cause: error,
      cursor: peer.node.cursor ?? null,
      attempt: peer.failures,
    });
    this.#fail(peer, reported);
    if (stuck) {
      peer.stuck = true;
      return;
    }
    if (peer.connected) this.#subscribe(peer);
  }

  async #receive(peer, value, eventId, feed) {
    if (peer.closed || feed !== peer.feed || !value) return;
    if (value.bootstrap) {
      // Not a page: a bootstrap the hook refused or that failed is reported
      // as it is, and asked again at the next handshake — the feed has ended.
      try {
        await this.#bootstrap(peer);
      } catch (error) {
        this.#fail(peer, error);
      }
      return;
    }
    const ops = unpackOps(value.ops);
    // A page of nothing but this node's own echoes: the position moved, the
    // cursor follows in memory, and that is all.
    if (ops.length === 0) {
      if (eventId) peer.node.cursor = eventId;
      return;
    }
    // The host's own `advance` ops, received on its feed, move this node's
    // vector (their merges came down the same feed); nothing else does.
    const result = await this.#storage.applyRemote(ops, {
      via: peer.ref,
      scopes: peer.node.scopes,
      peer: { url: peer.node.url, node: peer.remote.id },
      adoptFrom: peer.remote.id,
    });
    // Hung up while applying: the cursor is not saved, so a restart replays
    // this page as duplicates — better than a registry write racing whoever
    // reopens the directory next.
    if (peer.closed) return;
    peer.failures = 0;
    peer.stuck = false;
    peer.rehellos = 0;
    // The host has every op it just sent: known, so a relay does not hand
    // them straight back to it.
    for (const op of ops) vectorAdvance(peer.remote.vector, op);
    if (result.gaps > 0) {
      // Ops of a stream this node is behind on: they are lost to it unless
      // the stream is replayed, and the counter alone is easy to miss.
      this.#storage.logger.warn({ event: 'sync.gaps', url: peer.node.url, gaps: result.gaps, cursor: eventId });
    }
    if (eventId) peer.node.cursor = eventId;
    peer.node.lastSync = Date.now();
    await this.#saveNode(peer.node);
    notify(this, this.#storage.logger, 'sync', { url: peer.node.url, received: ops.length, ...result });
    // A page from the host is a sign of life: a peer left behind is caught up.
    this.#recover(peer);
  }

  // Bootstrap: page through the host's whole state, joining each page, then
  // subscribe from the position the FIRST page was taken at — anything that
  // landed while paging is replayed and folds in as a no-op.
  async #bootstrap(peer) {
    if (peer.bootstrapping) return;
    peer.bootstrapping = true;
    try {
      // A bootstrap replaces this node's view of the peer's scopes wholesale;
      // beforeBootstrap may refuse it. The feed has ended by now, so a
      // refused peer stays connected for pushes but receives nothing until
      // the next handshake asks again.
      const verdict = await runHook(this.#hooks, 'beforeBootstrap', { url: peer.node.url, node: peer.remote.id });
      if (verdict === false) return;
      // A host that holds fewer kinds than this node would hand over a
      // snapshot without those fields, and the joined vector would say the
      // ops behind them were seen: refused, reported, the feed left to
      // resume. A host that named no kinds is from before plugins.
      const theirs = peer.remote.kinds;
      const missing = [];
      if (theirs !== null) {
        const held = new Set(theirs);
        const kinds = this.#storage.kinds;
        for (let i = 0; i < kinds.length; i++) if (!held.has(kinds[i])) missing.push(kinds[i]);
      }
      if (missing.length > 0) {
        const message = `${peer.node.url} cannot hold the ${missing.join(', ')} kind${missing.length > 1 ? 's' : ''}; not bootstrapping from it`;
        this.#otel.recordBootstrap('refused');
        this.#fail(peer, new SyncomError('KINDS_MISMATCH', message, { node: peer.remote.id, missing }));
        return;
      }
      const otel = this.#otel;
      if (!otel.enabled) return void (await this.#join(peer));
      const attributes = { 'syncom.peer.url': peer.node.url, 'syncom.peer.node': peer.remote.id };
      let result = 'error';
      try {
        await traced(
          otel,
          'syncom.bootstrap',
          attributes,
          () => this.#join(peer),
          (stats) => ({
            'syncom.pages': stats.pages,
            'syncom.records': stats.records,
          }),
        );
        result = 'ok';
      } finally {
        otel.recordBootstrap(result);
      }
    } finally {
      peer.bootstrapping = false;
    }
  }

  async #join(peer) {
    const { node, link } = peer;
    peer.subscription?.unsubscribe?.();
    peer.subscription = null;
    let cursor = null;
    let startEventId = null;
    let startVector = null;
    let pages = 0;
    let total = 0;
    // The host pages; this node checks it moves on: a cursor that does not
    // pass the last one (record ids, in order) would page for ever.
    const bad = (reason, message) => new SyncomError('BAD_PAGE', `${node.url}: ${message}`, { url: node.url, reason });
    do {
      const page = await link.call('syncom/snapshot', { cursor, scopes: node.scopes });
      pages++;
      if (peer.closed) return { pages, records: total };
      if (page === null || typeof page !== 'object') throw bad('shape', 'a snapshot page that is no object');
      startEventId ??= page.eventId;
      startVector ??= page.vector ?? null;
      const records = page.id !== undefined ? await this.#readSnapshot(link, page, bad) : page.records;
      if (!Array.isArray(records)) throw bad('shape', 'a snapshot page without its records');
      const next = page.cursor ?? null;
      if (next !== null && (typeof next !== 'string' || (cursor !== null && next <= cursor))) {
        throw bad('cursor', `a snapshot cursor that does not move on (${JSON.stringify(next)} after ${cursor})`);
      }
      await this.#storage.mergeSnapshot(records, { via: peer.ref, from: peer.remote.id });
      total += records.length;
      cursor = next;
    } while (cursor !== null);
    // Everything up to the host's vector at the FIRST page is inside what
    // was joined; adopting it (for the scopes asked for) means nobody
    // offers those ops again. Later ops replay from the cursor.
    if (startVector) {
      await this.#storage.adoptVector(scopedVector(startVector, node.scopes), { via: peer.ref, from: peer.remote.id });
    }
    if (peer.closed) return { pages, records: total };
    node.cursor = startEventId;
    node.lastSync = Date.now();
    await this.#saveNode(node);
    notify(this, this.#storage.logger, 'bootstrap', { url: node.url, records: total });
    if (!peer.closed) this.#subscribe(peer);
    return { pages, records: total };
  }

  // A streamed page: NDJSON, one `{ id, data, meta }` per line, parsed line
  // by line as the chunks arrive; the records are collected and handed to
  // mergeSnapshot as one page — a page is bounded by the host's `pageSize`.
  async #readSnapshot(link, page, bad) {
    if (typeof link.stream !== 'function') {
      throw new SyncomError('STREAMS_UNSUPPORTED', 'The host streamed a snapshot but the link cannot read streams');
    }
    const decoder = new TextDecoder();
    const records = [];
    let rest = '';
    let bytes = 0;
    for await (const chunk of link.stream(page.id)) {
      bytes += chunk.length;
      if (bytes > this.#maxPageBytes) {
        throw bad('bytes', `a streamed snapshot page past sync.maxPageBytes (${this.#maxPageBytes})`);
      }
      rest += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
      let newline = rest.indexOf('\n');
      while (newline !== -1) {
        const line = rest.slice(0, newline);
        rest = rest.slice(newline + 1);
        if (line.length > 0) records.push(JSON.parse(line));
        newline = rest.indexOf('\n');
      }
    }
    rest += decoder.decode();
    if (rest.trim().length > 0) records.push(JSON.parse(rest));
    return records;
  }

  // One op landed here (locally or from a peer): wake the hosting feeds, and
  // queue it for every dialed peer except the one it came from.
  #fanOut(op, via) {
    if (this.#wakers.size > 0) for (const wake of [...this.#wakers]) wake();
    if (this.#peers.size === 0) return;
    const key = opKey(op);
    const scope = op.scope ?? GLOBAL_SCOPE;
    for (const peer of this.#peers.values()) {
      if (peer.ref === via || !peer.remote || !peer.connected) continue;
      if (peer.behind) {
        // Nothing is queued for a peer that is behind: the vector-based push
        // that recovers it carries this op with everything else it lacks.
        this.#recover(peer);
        continue;
      }
      if (op.origin === peer.remote.id || op.from === peer.remote.id) continue;
      if ((peer.remote.vector[key] ?? 0) >= op.seq || peer.rewound?.has(key)) continue;
      if (!inScope(scope, peer.node.scopes)) continue;
      peer.outbox.push(op);
      if (peer.outbox.length > this.#maxOutbox) {
        this.#storage.logger.warn({ event: 'sync.outbox.dropped', url: peer.node.url, ops: peer.outbox.length });
        peer.outbox = [];
        this.#fallBehind(peer, null);
        continue;
      }
      this.#scheduleFlush(peer);
    }
  }

  // Ops that land in one tick travel as one push, behind whatever push is
  // already in flight. A relay that fails drops its outbox and leaves the
  // peer behind, for #recover to catch up from the vector.
  #scheduleFlush(peer) {
    if (peer.flushQueued) return;
    peer.flushQueued = true;
    this.#serializePush(peer, async () => {
      peer.flushQueued = false;
      while (peer.outbox.length > 0 && !peer.closed && peer.connected && !peer.behind) {
        const ops = peer.outbox;
        peer.outbox = [];
        await this.#send(peer, ops, 'relay');
      }
    }).catch((error) => {
      peer.outbox = [];
      this.#fallBehind(peer, error);
    });
  }

  // ---------------------------------------------------------------------
  // The hosting side

  /**
   * Carries a presence instance (`@alexify/syncom/presence`): its updates
   * go to every connected host as the `syncom/presence` event, a host's
   * come back to it; a host hands its own and its room's to this node at
   * hello. Several instances, one per scope. Returns the function that
   * stops carrying it.
   */
  presence(instance) {
    if (!instance || typeof instance.apply !== 'function' || typeof instance.on !== 'function') {
      throw new TypeError('presence() takes a presence instance');
    }
    const onUpdate = (update) => this.#announcePresence(update);
    instance.on('update', onUpdate);
    this.#presences.add(instance);
    for (const peer of this.#peers.values()) if (peer.remote) this.#sendPresence(peer, instance);
    return () => {
      instance.off('update', onUpdate);
      this.#presences.delete(instance);
    };
  }

  // A peer's presence update, from a dialed host or a greeted client: to
  // every instance of its scope. Never logged.
  async receivePresence(update, via) {
    for (const instance of this.#presences) {
      if (instance.scope !== update?.scope) continue;
      const counts = await instance.apply(update, { from: via?.node ?? null });
      if (!this.#otel.enabled) continue;
      if (counts.forged > 0) this.#otel.recordPresenceRefused('forged', counts.forged);
      if (counts.unsigned > 0) this.#otel.recordPresenceRefused('unsigned', counts.unsigned);
      if (counts.refused > 0) this.#otel.recordPresenceRefused('invalid', counts.refused);
    }
  }

  #announcePresence(update) {
    for (const peer of this.#peers.values()) {
      if (!peer.connected || !peer.remote || typeof peer.link?.send !== 'function') continue;
      try {
        peer.link.send('syncom/presence', update);
      } catch (error) {
        this.#storage.logger.warn({ event: 'sync.presence.send', url: peer.node.url, err: error });
      }
    }
  }

  // This node's own state to a host just greeted.
  #sendPresence(peer, only = null) {
    if (typeof peer.link?.send !== 'function') return;
    for (const instance of this.#presences) {
      if (only !== null && instance !== only) continue;
      if (instance.local === null) continue;
      try {
        peer.link.send('syncom/presence', instance.encode([instance.node]));
      } catch (error) {
        this.#storage.logger.warn({ event: 'sync.presence.send', url: peer.node.url, err: error });
      }
    }
  }

  /**
   * The router unit a wrpc server (or anything shaped like one) hosts:
   * `defineRouter({ syncom: storage.sync.unit({ access: 'public' }) })`.
   * `access` defaults to wrpc's own default, 'session'; `authorize(context,
   * hello)` gates a peer by whatever the transport presented. Built in
   * src/sync/hosting.js from what both halves share.
   */
  unit(options = {}) {
    return createUnit(this, options, {
      storage: this.#storage,
      otel: this.#otel,
      wakers: this.#wakers,
      feeds: this.#feeds,
      drift: (schema, peer) => this.#drift(schema, peer),
    });
  }
}

module.exports = { SyncManager, isSyncLink };
