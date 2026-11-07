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
const { packOps, unpackOps } = require('./wire.js');
const { vectorAdvance, vectorMerge, keyScope, opKey } = require('../vector.js');
const { outbound, unreachable } = require('./outbound.js');
const { isSyncLink } = require('./link.js');
const { writerOf, traced } = require('../telemetry/writer.js');
const { notify, runHook, normalizeHooks } = require('../hooks.js');
const { GLOBAL_SCOPE, inScope, opInScope } = require('../scope.js');
const { PROTOCOL, DEFAULT_PAGE_SIZE, schemaOf, kindsOf } = require('./protocol.js');
const { createUnit } = require('./hosting.js');
const { NodeRegistry } = require('./registry.js');
const { SharedHub, normalizeShared } = require('./shared.js');
const { SyncomError } = require('../errors.js');
const { wellFormed, VERDICT, isPlainObject } = require('../shape.js');
const { scrubOp } = require('../header.js');
const { SIGNER, REWIND, DB, SOURCE } = require('../symbols.js');
const { hashBytes } = require('../crypto/digest.js');
const { fromBase64 } = require('../crypto/pem.js');

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
// What a peer may answer for one blob: 64 MiB.
const MAX_BLOB_BYTES = 64 * 1024 * 1024;
const encoder = new TextEncoder();
// A failed recovery waits this long (doubling, by timestamp) before the next.
const RECOVER_BACKOFF = 1000;
const MAX_RECOVER_BACKOFF = 60_000;

// The hooks a manager accepts (`createDatabase({ sync: { hooks } })`).
// `beforeSend({ op, peer })` sees every op about to go to a peer: `false`
// sends it scrubbed — the header alone, a no-op where it lands — never
// withheld, since seqs run contiguously per origin and scope and a missing op
// would stop every later op of its stream at the peer. `onRevoke({ url, node,
// scopes })` runs when a host takes scopes back; without it the records of
// those scopes are forgotten here.
const SYNC_HOOKS = ['beforeConnect', 'beforeBootstrap', 'beforeSend', 'onRevoke'];

// The fields an op touches — what a revert of it brings back to the host's: a set's keys, an unset's names, the
// field of a kind's op (`key`); null for the whole record (a write, a delete, a merge).
const touchedBy = (op) => {
  if (op.type === 'set') return isPlainObject(op.data) ? Object.keys(op.data) : null;
  if (op.type === 'unset') return Array.isArray(op.value) ? op.value.slice() : null;
  if (op.type === 'write' || op.type === 'delete' || op.type === 'merge') return null;
  return typeof op.key === 'string' ? [op.key] : null;
};
// What a proof of this node's key signs: the host's challenge, bound to both node ids.
const proveMessage = (challenge, host, node) => JSON.stringify([1, 'prove', challenge, host, node]);
// What #connect's chain carries when beforeConnect said no.
const NOT_DIALLED = Symbol('syncom.notDialled');
// `addNode({ direction })`: what a link carries. `'both'` (the default) pushes and subscribes; `'pull'` only
// subscribes — nothing of this node goes to the peer, and the peer is not waited for by retention; `'push'`
// only pushes — no feed, no bootstrap.
const DIRECTIONS = new Set(['both', 'pull', 'push']);
const directionOf = (node) => (DIRECTIONS.has(node.direction) ? node.direction : 'both');

// Node registry entries are keyed by url; the file name is the url itself,
// percent-encoded — unlike the old `<host>.json`, two peers on one host or a
// url without a port cannot collide.
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
  // The nodes on disk (src/sync/registry.js).
  #registry;
  #otel;
  #hooks;
  #maxOutbox = DEFAULT_MAX_OUTBOX;
  #maxPageBytes = DEFAULT_MAX_PAGE_BYTES;
  // The log shared with the other hubs (src/sync/shared.js), or null.
  #sharedOptions = null;
  #shared = null;
  // Who waits for a state of the peers (`awaitInSync`, `awaitInitialReplication`, `awaitDocumentPushed`): each a
  // check run whenever a peer moves, resolved once it holds.
  #waiters = new Set();
  // Hosting side: the live sessions by node (what the units greeted) and the scopes taken back from each node.
  #sessions = new Map();
  #revocations = new Map();

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
    this.#sharedOptions = normalizeShared(this.#options.sharedLog);
    // The registry lives where the storage does: over its backend.
    this.#registry = new NodeRegistry(storage[DB].kv, storage.logger);
    return this.#init();
  }

  async #init() {
    this.#nodes = await this.#registry.load();
    // One listener for both halves: the dialing side's fan-out to its
    // links, and the hosting side's wake-up of every live `changes` feed.
    this.#onChange = (op, via, detail) => this.#fanOut(op, via, detail);
    this.#storage.on('change', this.#onChange);
    const { connect, autoStart = typeof connect === 'function' } = this.#options;
    // A node that dials keeps its own ops until every node it syncs with has
    // them: nobody else can hand a host what this node wrote offline, so
    // retention compacts only what was delivered (and what others made).
    if (typeof connect === 'function') this.#storage.log.retain((entry) => this.#undelivered(entry));
    // The shared log, read and appended to from the open on: what the hubs
    // of a mesh hold in common, whether or not this one dials.
    if (this.#sharedOptions !== null) {
      const kv = this.#storage[DB].kv;
      const pageSize = this.#options.pageSize ?? DEFAULT_PAGE_SIZE;
      this.#shared = new SharedHub(this, this.#storage, this.#sharedOptions, { kv, pageSize });
      await this.#shared.start();
    }
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
    const { url, token, scopes, direction = 'both' } = nodeData ?? {};
    if (typeof url !== 'string' || url.length === 0) throw new TypeError('Node URL is required');
    if (this.#nodes.has(url)) throw new SyncomError('NODE_EXISTS', `Node with URL ${url} already exists`, { url });
    if (scopes !== undefined) {
      if (!Array.isArray(scopes)) throw new TypeError('Node scopes must be an array of strings');
      for (let i = 0; i < scopes.length; i++) {
        if (typeof scopes[i] !== 'string') throw new TypeError('Node scopes must be an array of strings');
      }
    }
    if (!DIRECTIONS.has(direction)) throw new TypeError("Node direction must be 'both', 'pull' or 'push'");
    const node = {
      url,
      token,
      scopes: scopes ?? [GLOBAL_SCOPE],
      direction,
      enabled: true,
      lastSync: null,
      cursor: null,
      remote: null,
    };
    this.#nodes.set(url, node);
    await this.#registry.write(node);
    notify(this, this.#storage.logger, 'node', { url, action: 'add' });
    if (this.#started) this.#connect(node);
  }

  async removeNode(url) {
    const node = this.#nodes.get(url);
    if (!node) throw new SyncomError('NODE_NOT_FOUND', `Node with URL ${url} not found`, { url });
    this.#nodes.delete(url);
    this.#disconnect(url);
    await this.#registry.remove(url);
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

  // A node's file saved, coalesced and serialized per node (src/sync/registry.js).
  #saveNode(node) {
    if (!this.#nodes.has(node.url)) return Promise.resolve();
    return this.#registry.save(node, (url) => this.#nodes.has(url));
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
    this.#settle();
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
      if (!node.enabled || directionOf(node) === 'pull' || !opInScope(op, node.scopes)) continue;
      if (op.from !== undefined && op.from === node.remote?.id) continue;
      if (!((node.acked?.[opKey(op)] ?? 0) >= op.seq)) return true;
    }
    return false;
  }

  // ---------------------------------------------------------------------
  // Waiting for the peers

  // Every waiter's check, run once more: what moved may be what one waited for.
  #settle() {
    if (this.#waiters.size === 0) return;
    for (const waiter of [...this.#waiters]) {
      if (!waiter.check()) continue;
      this.#waiters.delete(waiter);
      waiter.resolve();
    }
  }

  // A promise that resolves once `check()` holds — now, or at a later settle; `signal` cuts it short.
  #await(check, signal) {
    if (check()) return Promise.resolve();
    if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('aborted'));
    return new Promise((resolve, reject) => {
      const waiter = { check, resolve };
      this.#waiters.add(waiter);
      signal?.addEventListener?.(
        'abort',
        () => {
          if (!this.#waiters.delete(waiter)) return;
          reject(signal.reason ?? new Error('aborted'));
        },
        { once: true },
      );
    });
  }

  // The dialed peer of an enabled node, or null where there is none to wait for: the dial failed (the next
  // `sync()` dials again), or the node was never dialed (`start()` not called).
  #peerOf(node) {
    const peer = this.#peers.get(node.url);
    return peer !== undefined && !peer.failed ? peer : null;
  }

  // Whether this node holds everything its peer told it of and the peer everything of this node's: the link up and
  // greeted, nothing to push (no outbox, no push in flight, not behind) and — where it subscribes — the host's
  // feed read to its end (an idle page since the last one with ops). A node without a peer is not waited for.
  #inSyncWith(node) {
    const peer = this.#peerOf(node);
    if (peer === null) return true;
    if (!peer.connected || !peer.remote || peer.bootstrapping) return false;
    const direction = directionOf(node);
    if (direction !== 'pull' && (peer.outbox.length > 0 || peer.inflight || peer.behind)) return false;
    if (direction !== 'push' && !peer.caughtUp) return false;
    return true;
  }

  /**
   * Resolves once every enabled node is in sync with this one: each link up and greeted, nothing left to push
   * to it, and its feed read to its end (the host's idle page). A node that is disabled, or whose dial failed,
   * is not waited for. `signal` cuts the wait short (rejects with its reason).
   */
  awaitInSync({ signal = null } = {}) {
    return this.#await(() => {
      for (const node of this.#nodes.values()) if (node.enabled && !this.#inSyncWith(node)) return false;
      return true;
    }, signal);
  }

  /**
   * Resolves once every enabled node has been in sync with this one at least once since it was dialed: the
   * first handshake done and the first lull of its feed seen (or a bootstrap joined) — what a client waits for
   * before it reads.
   */
  awaitInitialReplication({ signal = null } = {}) {
    return this.#await(() => {
      for (const node of this.#nodes.values()) {
        if (!node.enabled) continue;
        const peer = this.#peerOf(node);
        if (peer !== null && !peer.initial) return false;
      }
      return true;
    }, signal);
  }

  /**
   * Resolves once the newest op this node made for the record `id` is acknowledged by every enabled node it
   * goes to (a node of the op's scope that takes pushes) — at once when this node made none.
   */
  awaitDocumentPushed(id, { signal = null } = {}) {
    if (typeof id !== 'string') throw new TypeError('awaitDocumentPushed(id): id must be a string');
    const own = this.#storage.nodeId;
    let newest = null;
    const entries = this.#storage.log.entriesOf(id);
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i].op.origin === own) {
        newest = entries[i].op;
        break;
      }
    }
    if (newest === null) return Promise.resolve();
    const key = opKey(newest);
    return this.#await(() => {
      for (const node of this.#nodes.values()) {
        if (!node.enabled || directionOf(node) === 'pull' || !opInScope(newest, node.scopes)) continue;
        if (!((node.acked?.[key] ?? 0) >= newest.seq)) return false;
      }
      return true;
    }, signal);
  }

  // ---------------------------------------------------------------------
  // The dialing side

  async start() {
    // Stopped with the dialing, started with it: a shared log's consumer left `stuck` is read again from here.
    if (this.#shared !== null) await this.#shared.start();
    if (this.#started) return;
    if (typeof this.#options.connect !== 'function') {
      if (this.#shared !== null) return;
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
    if (this.#shared !== null) await this.#shared.stop();
    await this.#registry.drain();
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
        direction: directionOf(peer.node),
        caughtUp: peer.caughtUp,
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
      // The host's feed read to its end since the last page with ops (its idle page), and whether this link
      // was ever in sync — what `awaitInSync` and `awaitInitialReplication` wait for.
      caughtUp: false,
      initial: false,
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
          // The host took scopes back: what it granted shrinks, what it held of them is forgotten here.
          'syncom/revoke': (event) => {
            this.#revoked(peer, event?.scopes).catch((error) => this.#fail(peer, error));
          },
          open: () => {
            peer.connected = true;
          },
          close: () => {
            peer.connected = false;
            peer.subscription = null;
            peer.caughtUp = false;
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
    this.#settle();
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
    // The host asks for proof of this node's key before it takes or hands anything: the challenge signed.
    if (typeof answer.challenge === 'string') await this.#prove(peer, answer);
    // Scopes the host took back since this node last greeted it.
    if (Array.isArray(answer.revoked) && answer.revoked.length > 0) await this.#revoked(peer, answer.revoked, false);
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
    const direction = directionOf(node);
    // A pull-only link carries nothing of this node's; a push-only one takes no feed and joins no snapshot.
    const pulls = direction !== 'push';
    if (direction !== 'pull') {
      try {
        await this.#push(peer, 'handshake');
        peer.behind = false;
      } catch (error) {
        // Reported by the caller; what the host lacks waits for #recover. The
        // inbound half does not wait on it: the feed opens (but for a rewound
        // node, which bootstraps first), and its pages are the sign of life
        // the recovery pushes at.
        this.#fallBehind(peer, null);
        if (pulls && resubscribe && !rewound && !peer.subscription && !peer.closed) this.#subscribe(peer);
        throw error;
      }
    }
    if (!pulls) {
      // Pushed once: a push-only link has been in sync.
      peer.initial = true;
      this.#settle();
      return;
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

  // The host's challenge signed under this node's key — the key that is its id — and answered: without the
  // signing plugin there is nothing to sign with, and the host would refuse every call (UNPROVEN).
  async #prove(peer, answer) {
    const signer = this.#storage[SIGNER];
    if (signer === null) {
      const message = `${peer.node.url} asks for proof of this node's key, and this node has none (the signing plugin)`;
      throw new SyncomError('UNPROVEN', message, { url: peer.node.url, node: answer.node });
    }
    const sig = await signer.signMessage(proveMessage(answer.challenge, answer.node, this.#storage.nodeId));
    await peer.link.call('syncom/prove', { sig });
  }

  // The host took scopes back (`syncom/revoke`, or hello's `revoked`): the registry entry narrows and is saved,
  // `REVOKED` is reported, the `onRevoke` hook runs — without one, every record of those scopes is forgotten
  // here (never an op: the host would refuse it) — and the feed is opened again under the new grant.
  async #revoked(peer, scopes, resubscribe = true) {
    if (!Array.isArray(scopes) || scopes.length === 0 || peer.closed) return;
    const { node } = peer;
    const taken = new Set();
    for (let i = 0; i < scopes.length; i++) if (typeof scopes[i] === 'string') taken.add(scopes[i]);
    const kept = [];
    for (let i = 0; i < node.scopes.length; i++) if (!taken.has(node.scopes[i])) kept.push(node.scopes[i]);
    node.scopes = kept;
    await this.#saveNode(node);
    const revoked = [...taken];
    const message = `${node.url} took back the scopes ${revoked.join(', ')}`;
    this.#fail(peer, new SyncomError('REVOKED', message, { scopes: revoked, node: peer.remote?.id ?? null }));
    if (this.#hooks.onRevoke !== null) {
      await runHook(this.#hooks, 'onRevoke', { url: node.url, node: peer.remote?.id ?? null, scopes: revoked });
    } else await this.#forgetScopes(taken);
    if (resubscribe && !peer.closed && peer.connected && directionOf(node) !== 'push') {
      peer.subscription?.unsubscribe?.();
      peer.subscription = null;
      this.#subscribe(peer);
    }
  }

  // Every record of the scopes taken back, forgotten here: read as a peer's record is scoped, one by one.
  async #forgetScopes(taken) {
    const storage = this.#storage;
    const scopeOf = this.#options.scope;
    if (typeof scopeOf !== 'function') return;
    const ids = await storage.list();
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      let scope;
      try {
        const data = await storage.get(id);
        if (data === null) continue;
        scope = scopeOf(id, data);
      } catch (error) {
        storage.logger.warn({ event: 'sync.revoke.unread', id, err: error });
        continue;
      }
      if (taken.has(scope)) await storage.forget(id);
    }
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
        this.#settle();
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
        this.#settle();
      },
      (error) => {
        peer.recovering = false;
        this.#fallBehind(peer, error);
      },
    );
  }

  #push(peer, reason) {
    if (directionOf(peer.node) === 'pull') return Promise.resolve(0);
    return this.#serializePush(peer, () => this.#pushFromLog(peer, reason));
  }

  // Everything in our log the host has not seen, by its vector — ops of its
  // own origin excluded (it has those by definition); src/sync/outbound.js picks
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
      const page = await this.#outgoing(peer, ops.slice(index, index + pageSize));
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
      if (Array.isArray(answer?.refused) && answer.refused.length > 0) await this.#refused(peer, answer.refused);
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

  // A page as it goes out: every op `beforeSend` says no to goes as a scrub leaves it — a copy, the log's op
  // untouched — the header alone, a no-op where it lands and no gap in its stream.
  async #outgoing(peer, page) {
    if (this.#hooks.beforeSend === null) return page;
    const out = [];
    for (let i = 0; i < page.length; i++) {
      const op = page[i];
      const verdict = await runHook(this.#hooks, 'beforeSend', { op, peer: peer.ref });
      if (verdict !== false) {
        out.push(op);
        continue;
      }
      const copy = { ...op };
      scrubOp(copy);
      out.push(copy);
    }
    return out;
  }

  // Ops the host's `authorizeWrite` refused: each reported (WRITE_REFUSED), and one of this node's own reverted
  // — the fields the op touched brought to what the host holds of them (new ops stamped above the refused one,
  // `actor: 'revert'`, through the kinds' patches, so every node comes to the host's state and what the host
  // accepted since stands), or the record forgotten here where the host holds nothing (no op: there is nothing to
  // bring the others to). A revert the host refuses too is reported, never reverted again — the answer names the
  // op's actor, so a log that compacted the op tells it the same. A purge refused is reported alone: nothing can be
  // written over a purge here.
  async #refused(peer, refused) {
    const storage = this.#storage;
    for (let i = 0; i < refused.length; i++) {
      const { origin, seq, scope, id, current, actor } = refused[i];
      const own = origin === storage.nodeId && typeof id === 'string';
      const held = own
        ? storage.log.entryOf(typeof scope === 'string' ? `${origin}@${scope}` : origin, seq)
        : undefined;
      // What the op touched: the fields of a set or an unset, the field of a kind's op, the whole record for a
      // write, a delete or a merge; the whole record where the log no longer holds the op.
      const touched = held === undefined ? null : touchedBy(held.op);
      const revert = own && actor !== 'revert' && held?.op.type !== 'purge';
      const what = revert
        ? current === null || current === undefined
          ? '; forgotten here'
          : '; reverted to what it holds'
        : '';
      const message = `${peer.node.url} refused ${origin}:${seq} on ${id}${what}`;
      const fields = { origin, seq, id, current: current ?? null, own, touched };
      this.#fail(peer, new SyncomError('WRITE_REFUSED', message, fields));
      if (!revert) continue;
      try {
        await storage[SOURCE].revert(id, current ?? null, touched, { actor: 'revert' });
      } catch (error) {
        storage.logger.warn({ event: 'sync.revert.failed', url: peer.node.url, id, err: error });
      }
    }
  }

  #subscribe(peer) {
    const { node, link } = peer;
    const feed = ++peer.feed;
    // The end of a feed opened before this one (cut by the host, say) must not take this one's handle off the peer.
    let handle = null;
    const ended = () => {
      if (peer.subscription === handle) peer.subscription = null;
    };
    handle = link.subscribe(
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
          ended();
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
        onEnd: ended,
      },
    );
    peer.subscription = handle;
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
    // The pages queued behind the failed one are the old feed's — an idle page among them would move the cursor
    // past it — and are dropped whether or not a feed is opened again (a stuck peer opens none).
    peer.feed++;
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
    // The host's feed read to its end: an idle page says so, and the link is in sync (`awaitInSync`) — unless
    // the link went down meanwhile (a page delivered before the close, run after it: the feed moved on without us).
    if (value.idle === true) {
      peer.caughtUp = peer.connected;
      peer.initial = true;
      if (eventId) peer.node.cursor = eventId;
      this.#settle();
      return;
    }
    // A page of nothing but this node's own echoes: the position moved, the
    // cursor follows in memory, and that is all.
    if (ops.length === 0) {
      if (eventId) peer.node.cursor = eventId;
      return;
    }
    peer.caughtUp = false;
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
      // resume.
      const held = new Set(peer.remote.kinds);
      const kinds = this.#storage.kinds;
      const missing = [];
      for (let i = 0; i < kinds.length; i++) if (!held.has(kinds[i])) missing.push(kinds[i]);
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
    this.#settle();
    return { pages, records: total };
  }

  /**
   * The bytes of an attachment's blob asked of the peers this node dials, by digest (`syncom/blob`): the first
   * connected peer that holds them answers — a stream where the transport carries one, base64 otherwise — the
   * bytes are checked against the digest and kept in this node's blobs store. None has them: `BLOB_NOT_FOUND`
   * (`digest`, `asked`). Past `MAX_BLOB_BYTES` a peer's answer is refused.
   */
  async fetchBlob(digest) {
    if (typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest)) {
      throw new TypeError('fetchBlob() takes a digest: SHA-256 as hex');
    }
    let asked = 0;
    let cause = null;
    for (const peer of this.#peers.values()) {
      if (!peer.connected || peer.link === null) continue;
      asked++;
      let bytes;
      try {
        const answer = await peer.link.call('syncom/blob', { digest });
        bytes = await this.#readBlob(peer.link, answer);
      } catch (error) {
        // Not there (404), not served (403), a transport's failure: the next peer.
        cause = error;
        continue;
      }
      if ((await hashBytes(bytes)) !== digest) {
        this.#storage.logger.warn({ event: 'sync.blob.mismatch', url: peer.node.url, node: peer.ref.node, digest });
        continue;
      }
      const store = this.#storage[DB]?.blobs;
      if (store !== undefined) await store.put(digest, bytes);
      return bytes;
    }
    throw new SyncomError('BLOB_NOT_FOUND', `No connected peer holds blob ${digest} (${asked} asked)`, {
      digest,
      asked,
      cause,
    });
  }

  // A blob as a host answers it: the bytes of a stream, or base64 in the answer itself; bounded by MAX_BLOB_BYTES.
  async #readBlob(link, answer) {
    if (answer === null || typeof answer !== 'object') {
      throw new SyncomError('BAD_PAGE', 'A blob answer that is no object');
    }
    if (typeof answer.base64 === 'string') {
      if (answer.base64.length > (MAX_BLOB_BYTES / 3) * 4 + 4) {
        throw new SyncomError('BAD_PAGE', 'A blob past MAX_BLOB_BYTES');
      }
      return fromBase64(answer.base64);
    }
    if (typeof link.stream !== 'function') {
      throw new SyncomError('STREAMS_UNSUPPORTED', 'The host streamed a blob but the link cannot read streams');
    }
    const chunks = [];
    let length = 0;
    for await (const chunk of link.stream(answer.id)) {
      const bytes = typeof chunk === 'string' ? encoder.encode(chunk) : chunk;
      length += bytes.length;
      if (length > MAX_BLOB_BYTES) throw new SyncomError('BAD_PAGE', 'A blob past MAX_BLOB_BYTES');
      chunks.push(bytes);
    }
    const out = new Uint8Array(length);
    let at = 0;
    for (let i = 0; i < chunks.length; i++) {
      out.set(chunks[i], at);
      at += chunks[i].length;
    }
    return out;
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
  #fanOut(op, via, detail) {
    // To the shared log first: what the other hubs, and every feed read from it, learn of this op — offered with
    // its log position, which the relay's watermark is kept by.
    if (this.#shared !== null) this.#shared.offer(op, via, detail?.seq ?? null);
    if (this.#wakers.size > 0) for (const wake of [...this.#wakers]) wake();
    if (this.#peers.size === 0) return;
    const key = opKey(op);
    const scope = op.scope ?? GLOBAL_SCOPE;
    for (const peer of this.#peers.values()) {
      if (peer.ref === via || !peer.remote || !peer.connected || directionOf(peer.node) === 'pull') continue;
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
    // A follower's log and vector are as of its open: a feed served from them
    // would never move, so without a shared log it hosts no more than it dials
    // (a writer whose lease was lost is the same from then on). Over a shared
    // log it hosts from the log: the feed, the vector a hello answers, the
    // pushes forwarded to the inbox.
    if (this.#storage.readOnly && this.#shared === null) {
      const { path } = this.#storage;
      throw new SyncomError('READ_ONLY', `Storage at ${path} is read-only: it does not host without a shared log`, {
        path,
        lease: this.#storage.stats().lock !== null,
        reason: 'hosting',
      });
    }
    return createUnit(this, options, {
      storage: this.#storage,
      otel: this.#otel,
      wakers: this.#wakers,
      feeds: this.#feeds,
      drift: (schema, peer) => this.#drift(schema, peer),
      shared: this.#shared,
      sessions: this.#sessions,
      revoked: this.#revocations,
      scopeOf: (id, data) => (typeof this.#options.scope === 'function' ? this.#options.scope(id, data) : GLOBAL_SCOPE),
    });
  }

  /** The shared log as this hub stands to it — its cursors, the relay's watermark, the counts — or null without one. */
  shared() {
    return this.#shared === null ? null : this.#shared.stats();
  }

  /**
   * Hosting side: takes `scopes` back from the peer `node` on every unit of this manager — its live feeds end,
   * it is told at once (`syncom/revoke`), its grant is narrower from here on and its next hello says so
   * (`revoked`). A grant of everything (`'*'`) cannot be narrowed by a scope: revoke what hello granted.
   */
  revoke(node, scopes) {
    if (typeof node !== 'string' || node.length === 0) {
      throw new TypeError('revoke(node, scopes): node must be a string');
    }
    if (!Array.isArray(scopes) || scopes.length === 0) {
      throw new TypeError('revoke(node, scopes): scopes must be a non-empty array');
    }
    for (let i = 0; i < scopes.length; i++) {
      if (typeof scopes[i] !== 'string') throw new TypeError('revoke(node, scopes): scopes must be strings');
    }
    let held = this.#revocations.get(node);
    if (held === undefined) this.#revocations.set(node, (held = new Set()));
    for (let i = 0; i < scopes.length; i++) held.add(scopes[i]);
    const sessions = this.#sessions.get(node);
    if (sessions !== undefined) {
      for (const session of sessions) session.revoke(scopes);
    }
    // Every live feed looks again: one of the node's ends.
    for (const wake of [...this.#wakers]) wake();
    notify(this, this.#storage.logger, 'revoke', { node, scopes: scopes.slice() });
  }
}

module.exports = { SyncManager, isSyncLink };
