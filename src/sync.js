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
//   unit() — the HOSTING side: a plain object of `{ access, handler }`
//   procedures shaped for wrpc's defineRouter, with no import of wrpc.
//   `changes` is an async generator, which wrpc treats as a subscription;
//   its values are labelled with this node's log position through the
//   `tracked` shape (Symbol.for('wrpc.tracked'), part of wrpc's frozen wire
//   protocol), so a resuming subscriber replays exactly what it missed.
//
// Every node is both: a mesh is nodes dialing whichever nodes they can
// reach, with ops relayed transitively and de-duplicated by version vector.

const { Emitter } = require('./utils.js');
const { packOps, unpackOps } = require('./ops.js');
const { vectorHas, vectorAdvance, vectorMax, opKey, keyScope } = require('./vector.js');
const { isSyncLink } = require('./link.js');
const { createTelemetry, traced } = require('./telemetry.js');
const { notify, runHook, normalizeHooks } = require('./hooks.js');

const REMOTE = 'remote';
const PROTOCOL = 1;
const GLOBAL_SCOPE = '*';
const DEFAULT_PAGE_SIZE = 500;
const DEFAULT_PAGE_BYTES = 4 << 20;
// A page that fails this many times in a row leaves its peer `stuck`.
const MAX_PAGE_RETRIES = 3;
// A host that answers 428 to this many fresh hellos in a row is not going to
// remember us; the dialer stops greeting and reports a loop.
const MAX_REHELLOS = 5;
// Ops queued for a peer beyond this are dropped — the vector-based push that
// recovers the peer carries what it lacks, and memory is not a buffer.
const DEFAULT_MAX_OUTBOX = 10_000;
// A failed recovery waits this long (doubling, by timestamp) before the next.
const RECOVER_BACKOFF = 1000;
const MAX_RECOVER_BACKOFF = 60_000;
const TRACKED = Symbol.for('wrpc.tracked');

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

const coded = (message, code) => {
  const error = new Error(message);
  error.code = code;
  error.expose = true;
  return error;
};

const LIMIT_KEYS = ['opsPerPush', 'bytesPerPush', 'opsPerSecond'];

// `unit({ limits })`: each a positive number, unknown keys refused.
const normalizeLimits = (limits) => {
  if (limits === undefined || limits === null) return null;
  if (typeof limits !== 'object') throw new TypeError('unit({ limits }): limits must be an object');
  const normalized = {};
  for (const key of Object.keys(limits)) {
    if (!LIMIT_KEYS.includes(key)) throw new TypeError(`unit({ limits }): unknown limit '${key}'`);
    const value = limits[key];
    if (value === undefined) continue;
    if (!Number.isFinite(value) || value <= 0) {
      throw new TypeError(`unit({ limits }): ${key} must be a positive number`);
    }
    normalized[key] = value;
  }
  return normalized;
};

// The part of a vector that concerns `scopes`: global keys (`origin`) and
// the `origin@scope` keys of the scopes asked for.
const scopedVector = (vector, scopes) => {
  if (!scopes || scopes.includes(GLOBAL_SCOPE)) return vector;
  const out = {};
  for (const key in vector) {
    const scope = keyScope(key);
    if (scope === null || scopes.includes(scope)) out[key] = vector[key];
  }
  return out;
};

const inScope = (op, scopes) => {
  const scope = op.scope ?? GLOBAL_SCOPE;
  return !scopes || scope === GLOBAL_SCOPE || scopes.includes(GLOBAL_SCOPE) || scopes.includes(scope);
};

// The scopes a read may cover: what hello granted, narrowed to what the
// call asks for. A peer granted `'*'` reads what it asks (nothing asked:
// everything); one granted a list reads the intersection — asking for `'*'`
// or for nothing is asking for its list, asking only for others is 403.
const grant = (asked, granted) => {
  const wanted = Array.isArray(asked) ? asked.filter((scope) => typeof scope === 'string') : null;
  if (granted.includes(GLOBAL_SCOPE)) return wanted;
  if (wanted === null || wanted.includes(GLOBAL_SCOPE)) return granted;
  const scopes = wanted.filter((scope) => granted.includes(scope));
  if (scopes.length === 0) throw coded('Scopes not granted', 403);
  return scopes;
};

// A peer's schema as hello carries it — `{ version, hash }` — or null for
// a peer without one (or one speaking a shape this node does not read).
const schemaOf = (value) => {
  if (!value || typeof value !== 'object' || !Number.isInteger(value.version)) return null;
  return { version: value.version, hash: typeof value.hash === 'string' ? value.hash : null };
};

// Resolves on the next change (or abort). The manager keeps ONE listener on
// the storage and wakes every waiting subscription from it, because Emitter
// refuses more than ten listeners and a host has as many `changes` feeds as
// it has peers.
const waitFor = (wakers, signal) =>
  new Promise((resolve) => {
    if (signal?.aborted) return void resolve();
    const done = () => {
      wakers.delete(done);
      signal?.removeEventListener?.('abort', done);
      resolve();
    };
    wakers.add(done);
    signal?.addEventListener?.('abort', done, { once: true });
  });

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
  #saving = new Map();
  #otel;
  #hooks;
  #fsi;
  #maxOutbox = DEFAULT_MAX_OUTBOX;

  constructor(storage, options = {}) {
    super();
    this.#storage = storage;
    this.#options = options ?? {};
    this.#hooks = normalizeHooks(this.#options.hooks, SYNC_HOOKS, 'SyncManager');
    const { maxOutbox } = this.#options;
    if (maxOutbox !== undefined && !(Number.isInteger(maxOutbox) && maxOutbox > 0)) {
      throw new TypeError('sync.maxOutbox must be a positive integer');
    }
    if (maxOutbox !== undefined) this.#maxOutbox = maxOutbox;
    this.#otel = createTelemetry(storage.telemetry);
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
      const raw = await this.#fsi.read(this.#path, file);
      const node = JSON.parse(raw);
      if (node && typeof node.url === 'string') this.#nodes.set(node.url, node);
    }
    // One listener for both halves: the dialing side's fan-out to its
    // links, and the hosting side's wake-up of every live `changes` feed.
    this.#onChange = (op, via) => this.#fanOut(op, via);
    this.#storage.on('change', this.#onChange);
    const { connect, autoStart = typeof connect === 'function' } = this.#options;
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
    if (typeof url !== 'string' || url.length === 0) throw new Error('Node URL is required');
    if (this.#nodes.has(url)) throw new Error(`Node with URL ${url} already exists`);
    if (scopes !== undefined && !(Array.isArray(scopes) && scopes.every((s) => typeof s === 'string'))) {
      throw new Error('Node scopes must be an array of strings');
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
    await this.#fsi.write(this.#path, fileName(url), JSON.stringify(node));
    notify(this, this.#storage.logger, 'node', { url, action: 'add' });
    if (this.#started) this.#connect(node);
  }

  async removeNode(url) {
    const node = this.#nodes.get(url);
    if (!node) throw new Error(`Node with URL ${url} not found`);
    this.#nodes.delete(url);
    this.#disconnect(url);
    await this.#fsi.remove(this.#path, fileName(url));
    notify(this, this.#storage.logger, 'node', { url, action: 'remove' });
  }

  listNodes() {
    return Array.from(this.#nodes.values(), (node) => ({ ...node }));
  }

  async enableNode(url, enabled = true) {
    const node = this.#nodes.get(url);
    if (!node) throw new Error(`Node with URL ${url} not found`);
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
      await this.#fsi.write(this.#path, fileName(url), JSON.stringify(node));
    });
    state.next = write;
    state.last = write
      .catch(() => {})
      .then(() => {
        if (state.next === null) this.#saving.delete(url);
      });
    return write;
  }

  // ---------------------------------------------------------------------
  // The dialing side

  async start() {
    if (this.#started) return;
    if (typeof this.#options.connect !== 'function') {
      throw new Error('sync.start() needs a connect(node) factory in the storage sync options');
    }
    this.#started = true;
    for (const node of this.#nodes.values()) {
      if (node.enabled) this.#connect(node);
    }
    notify(this, this.#storage.logger, 'start');
  }

  async stop() {
    this.#started = false;
    for (const url of Array.from(this.#peers.keys())) this.#disconnect(url);
    await Promise.all(Array.from(this.#saving.values(), (state) => state.last));
    notify(this, this.#storage.logger, 'stop');
  }

  /** Pushes whatever the connected peers lack right now; resolves when done. */
  async sync(url) {
    const peers = url ? [this.#peers.get(url)].filter(Boolean) : Array.from(this.#peers.values());
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
    return Array.from(this.#peers.values(), (peer) => ({
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
    }));
  }

  /** Hosting side: every peer with a live `changes` feed on this node. */
  hosted() {
    return Array.from(this.#feeds, (feed) => ({ ...feed, scopes: feed.scopes === null ? null : [...feed.scopes] }));
  }

  #connect(node) {
    if (this.#peers.has(node.url)) return;
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
        for (const event in peer.handlers) link.on(event, peer.handlers[event]);
        peer.connected = true;
        notify(this, this.#storage.logger, 'connect', { url: node.url });
        return this.#handshake(peer, { resubscribe: true });
      })
      .catch((error) => this.#fail(peer, error));
  }

  #disconnect(url) {
    const peer = this.#peers.get(url);
    if (!peer) return;
    peer.closed = true;
    this.#peers.delete(url);
    if (peer.link) {
      if (peer.handlers) for (const event in peer.handlers) peer.link.off(event, peer.handlers[event]);
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
    });
    if (peer.closed) return;
    if (!answer || typeof answer.node !== 'string') throw new Error(`Bad hello from ${node.url}`);
    if (answer.duplicate) {
      // A host may say it already dials us; one link is enough.
      this.#disconnect(node.url);
      return;
    }
    // A host reinstalled since we last spoke: its log speaks another epoch,
    // so our cursor is void and the subscription will say `bootstrap`.
    if (node.remote && node.remote.epoch !== answer.epoch) node.cursor = null;
    const schema = schemaOf(answer.schema);
    peer.remote = { id: answer.node, vector: answer.vector ?? {}, epoch: answer.epoch };
    peer.ref.node = answer.node;
    node.remote = { id: answer.node, epoch: answer.epoch, schema };
    await this.#saveNode(node);
    notify(this, this.#storage.logger, 'peer', { url: node.url, connected: true, node: answer.node, schema });
    this.#drift(schema, { url: node.url, node: answer.node });
    try {
      await this.#push(peer, 'handshake');
      peer.behind = false;
    } catch (error) {
      // Reported by the caller; what the host lacks waits for #recover.
      this.#fallBehind(peer, null);
      throw error;
    }
    if (resubscribe && !peer.subscription) this.#subscribe(peer);
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
  // own origin excluded (it has those by definition). A host that is behind
  // what we still retain cannot be caught up from here; it will bootstrap
  // from a node that dials it, or we from it.
  async #pushFromLog(peer, reason) {
    const { node } = peer;
    const entries =
      this.#storage.log.since(undefined) ??
      this.#storage.log.since(this.#storage.log.formatId(this.#storage.log.floor - 1)) ??
      [];
    const ops = [];
    for (const { op } of entries) {
      if (op.origin === peer.remote.id || op.from === peer.remote.id) continue;
      if (vectorHas(peer.remote.vector, op)) continue;
      if (!inScope(op, node.scopes)) continue;
      ops.push(op);
    }
    return this.#send(peer, ops, reason);
  }

  // One span per push, whatever its page count: with wrpc underneath, the
  // `syncom/push` client span of every page nests under it, and the server
  // span on the far side under that — the link carries the context.
  // `reason` says what caused it: a handshake, a manual sync(), or a relay
  // of ops that just landed.
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
      if (answer?.vector) peer.remote.vector = vectorMax(peer.remote.vector, answer.vector);
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
              this.#fail(peer, Object.assign(new Error(message, { cause: error }), { code: 'HANDSHAKE_LOOP' }));
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
    const reported = Object.assign(new Error(message, { cause: error }), {
      code: stuck ? 'STUCK' : 'PAGE_FAILED',
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
    do {
      const page = await link.call('syncom/snapshot', { cursor, scopes: node.scopes });
      pages++;
      if (peer.closed) return { pages, records: total };
      startEventId ??= page.eventId;
      startVector ??= page.vector ?? null;
      const records = page.id !== undefined ? await this.#readSnapshot(link, page) : page.records;
      await this.#storage.mergeSnapshot(records, { via: peer.ref, from: peer.remote.id });
      total += records.length;
      cursor = page.cursor ?? null;
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

  // A streamed page: NDJSON, one `{ id, data, meta }` per line, parsed as the
  // chunks arrive so a page costs one record of memory, not one page.
  async #readSnapshot(link, page) {
    if (typeof link.stream !== 'function') {
      throw new Error('The host streamed a snapshot but the link cannot read streams');
    }
    const decoder = new TextDecoder();
    const records = [];
    let rest = '';
    for await (const chunk of link.stream(page.id)) {
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
    for (const wake of Array.from(this.#wakers)) wake();
    for (const peer of this.#peers.values()) {
      if (peer.ref === via || !peer.remote || !peer.connected) continue;
      if (peer.behind) {
        // Nothing is queued for a peer that is behind: the vector-based push
        // that recovers it carries this op with everything else it lacks.
        this.#recover(peer);
        continue;
      }
      if (op.origin === peer.remote.id || op.from === peer.remote.id) continue;
      if (vectorHas(peer.remote.vector, op)) continue;
      if (!inScope(op, peer.node.scopes)) continue;
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
   * The router unit a wrpc server (or anything shaped like one) hosts:
   * `defineRouter({ syncom: storage.sync.unit({ access: 'public' }) })`.
   * `access` defaults to wrpc's own default, 'session'; `authorize(context,
   * hello)` gates a peer by whatever the transport presented.
   */
  unit(options = {}) {
    const {
      access = 'session',
      authorize = null,
      tracked = null,
      pageSize = DEFAULT_PAGE_SIZE,
      pageBytes = DEFAULT_PAGE_BYTES,
      meta,
    } = options;
    const limits = normalizeLimits(options.limits);
    if (meta !== undefined && (typeof meta !== 'object' || meta === null || Array.isArray(meta))) {
      throw new TypeError('unit({ meta }): meta must be an object');
    }
    const storage = this.#storage;
    const wakers = this.#wakers;
    const feeds = this.#feeds;
    const track = tracked ?? ((id, data) => ({ [TRACKED]: true, id: String(id), data }));
    // `meta` rides on every procedure: what a wrpc `onRequest` hook reads
    // as `context.procedure.meta` — a hub-wide policy (rate limits, audit)
    // stays the host's, and the unit stays a plain object.
    const procedure = (handler) => (meta === undefined ? { access, handler } : { access, handler, meta });

    // A refusal before the handler: counted by code; 428 is the normal
    // course of a wrpc reconnect (a new server-side client) and only counted.
    const refuse = (message, code, node = null) => {
      this.#otel.recordRefusal(code);
      if (code !== 428) storage.logger.warn({ event: 'sync.hello.refused', code, node });
      return coded(message, code);
    };
    const peerOf = (context) => {
      const state = context?.client?.data?.syncom;
      if (!state) throw refuse('Say hello first', 428);
      return state;
    };

    return {
      hello: procedure(async (context, args) => {
        if (!args || typeof args.node !== 'string') throw refuse('hello needs a node id', 400);
        if (args.version !== undefined && args.version !== PROTOCOL) {
          throw refuse(`Unsupported protocol ${args.version}`, 400, args.node);
        }
        if (args.node === storage.nodeId) {
          throw refuse('A node cannot sync with itself (copied data directory?)', 409, args.node);
        }
        if (authorize && !(await authorize(context, args))) throw refuse('Not authorized to sync', 403, args.node);
        const scopes = Array.isArray(args.scopes) ? args.scopes.filter((s) => typeof s === 'string') : [GLOBAL_SCOPE];
        const schema = schemaOf(args.schema);
        if (context?.client) {
          context.client.data ??= {};
          // A repeated hello keeps the rate bucket: greeting again is not a refill.
          const bucket = context.client.data.syncom?.bucket;
          const ref = { url: null, node: args.node };
          context.client.data.syncom = { node: args.node, scopes, schema, bucket, ref };
          if (typeof context.client.join === 'function') {
            for (const scope of scopes) context.client.join(`syncom:${scope}`);
          }
        }
        notify(this, storage.logger, 'hello', { node: args.node, scopes, schema });
        this.#drift(schema, { url: null, node: args.node });
        return {
          node: storage.nodeId,
          vector: storage.vector,
          epoch: storage.log.epoch,
          version: PROTOCOL,
          schema: schemaOf(storage.schemaInfo),
        };
      }),

      push: procedure(async (context, args) => {
        const state = peerOf(context);
        const { node, scopes } = state;
        const ops = unpackOps(args?.ops);
        if (limits !== null) this.#limit(state, args, ops, limits);
        // The scopes hello granted bound what a peer writes here, not only
        // what it reads: an op outside them is refused before anything
        // sees it. No stream is harmed — seqs run per scope, and a dialer
        // that honours its registry never sends one.
        const granted = [];
        let outOfScope = 0;
        for (const op of ops) {
          if (inScope(op, scopes)) granted.push(op);
          else outOfScope++;
        }
        if (outOfScope > 0) this.#refuse(node, 'scope', outOfScope);
        // `url` is null: a host does not dial, so it has no url for the peer.
        const via = state.ref ?? { url: null, node };
        const result = await storage.applyRemote(granted, { via, scopes, peer: via });
        // The vector the dialer merges in: the keys this page touched, not
        // the whole thing — a hub's has a key per client and scope.
        const whole = storage.vector;
        const vector = {};
        for (const op of granted) {
          const key = opKey(op);
          if (whole[key] !== undefined) vector[key] = whole[key];
        }
        return { vector, ...result, outOfScope };
      }),

      snapshot: procedure(async (context, args) => {
        const state = peerOf(context);
        const page = await storage.snapshot({
          cursor: args?.cursor ?? null,
          limit: pageSize,
          scopes: grant(args?.scopes, state.scopes),
        });
        // The vector rides on the first page only: the dialer adopts it as of
        // the start, and a hub's is too large to repeat.
        if (args?.cursor) page.vector = undefined;
        const client = context?.client;
        const canStream = client && client.binary !== false && typeof client.createStream === 'function';
        if (!canStream || page.records.length === 0) return page;
        // NDJSON, serialized first because a wrpc stream declares its size
        // up front; a page is bounded, so that buffer is too.
        let text = '';
        for (const record of page.records) text += `${JSON.stringify(record)}\n`;
        const bytes = new TextEncoder().encode(text);
        if (bytes.length > pageBytes) return page;
        const stream = client.createStream('syncom/snapshot', bytes.length);
        // The opening packet is already out; writing in this tick would
        // race the caller's chance to attach a consumer.
        queueMicrotask(() => {
          stream.write(bytes);
          stream.end();
        });
        return { id: stream.id, size: bytes.length, cursor: page.cursor, eventId: page.eventId, vector: page.vector };
      }),

      changes: procedure(async function* (context, args, subscription = {}) {
        const { node, scopes: granted } = peerOf(context);
        const { lastEventId, signal } = subscription;
        const scopes = grant(args?.scopes, granted);
        let cursor = lastEventId ?? undefined;
        // What hosted() lists while this feed is live.
        const feed = { node, scopes, since: Date.now(), cursor: cursor ?? null };
        feeds.add(feed);
        try {
          for (;;) {
            if (signal?.aborted) return;
            const entries = storage.log.since(cursor, { scopes, limit: pageSize });
            if (entries === null) {
              // Cannot resume: another epoch, or compacted past the cursor.
              yield { bootstrap: true };
              return;
            }
            if (entries.length === 0) {
              await waitFor(wakers, signal);
              continue;
            }
            const last = entries[entries.length - 1].seq;
            const ops = [];
            for (const { op } of entries) if (op.origin !== node && op.from !== node) ops.push(op);
            cursor = storage.log.formatId(last);
            feed.cursor = cursor;
            // Labelled even when every op was the peer's own echo: the
            // position still moves, and a resume must not replay it.
            yield track(cursor, { ops: packOps(ops), eventId: cursor });
          }
        } finally {
          feeds.delete(feed);
        }
      }),
    };
  }

  // Ops of a peer this host would not take: counted, logged and announced
  // through the `refused` event, never applied. `reason` is what the
  // `syncom.ops.rejected` metric carries.
  #refuse(node, reason, count) {
    this.#storage.logger.warn({ event: 'sync.op.refused', node, reason, count });
    for (let i = 0; i < count; i++) this.#otel.recordRejected(reason);
    notify(this, this.#storage.logger, 'refused', { node, reason, count });
  }

  // Per-peer push limits, the one place that knows the ops and the bytes:
  // a page over `opsPerPush` or `bytesPerPush` is 413, a peer over
  // `opsPerSecond` is 429 — a token bucket in its state, refilled at that
  // rate, holding one second's worth. Codes, not a hang-up: the dialer
  // reports them and recomputes from the vector at its next hello.
  #limit(state, args, ops, limits) {
    const { opsPerPush, bytesPerPush, opsPerSecond } = limits;
    if (opsPerPush !== undefined && ops.length > opsPerPush) {
      this.#otel.recordLimited('ops');
      throw coded(`Push of ${ops.length} ops exceeds opsPerPush ${opsPerPush}`, 413);
    }
    if (bytesPerPush !== undefined) {
      const bytes = new TextEncoder().encode(JSON.stringify(args?.ops ?? null)).length;
      if (bytes > bytesPerPush) {
        this.#otel.recordLimited('bytes');
        throw coded(`Push of ${bytes} bytes exceeds bytesPerPush ${bytesPerPush}`, 413);
      }
    }
    if (opsPerSecond !== undefined) {
      const at = Date.now();
      const bucket = (state.bucket ??= { tokens: opsPerSecond, at });
      bucket.tokens = Math.min(opsPerSecond, bucket.tokens + ((at - bucket.at) / 1000) * opsPerSecond);
      bucket.at = at;
      if (ops.length > bucket.tokens) {
        this.#otel.recordLimited('rate');
        throw coded(`Rate limited: ${ops.length} ops over opsPerSecond ${opsPerSecond}`, 429);
      }
      bucket.tokens -= ops.length;
    }
  }
}

module.exports = { SyncManager, isSyncLink };
