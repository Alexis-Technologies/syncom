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

const fsi = require('./fsi.js');
const { Emitter } = require('./utils.js');
const { packOps, unpackOps } = require('./ops.js');
const { vectorHas, keyScope } = require('./vector.js');
const { isSyncLink } = require('./link.js');
const { createTelemetry, traced } = require('./telemetry.js');
const { notify, runHook, normalizeHooks } = require('./hooks.js');

const REMOTE = 'remote';
const PROTOCOL = 1;
const GLOBAL_SCOPE = '*';
const DEFAULT_PAGE_SIZE = 500;
const DEFAULT_PAGE_BYTES = 4 << 20;
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
  #onChange = null;
  #started = false;
  #saving = new Map();
  #otel;
  #hooks;

  constructor(storage, options = {}) {
    super();
    this.#storage = storage;
    this.#options = options ?? {};
    this.#hooks = normalizeHooks(this.#options.hooks, SYNC_HOOKS, 'SyncManager');
    this.#otel = createTelemetry(storage.telemetry);
    this.#path = `${storage.path}/${REMOTE}`;
    return this.#init();
  }

  async #init() {
    const files = await fsi.list(this.#path);
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const raw = await fsi.read(this.#path, file);
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
    await fsi.write(this.#path, fileName(url), JSON.stringify(node));
    notify(this, this.#storage.logger, 'node', { url, action: 'add' });
    if (this.#started) this.#connect(node);
  }

  async removeNode(url) {
    const node = this.#nodes.get(url);
    if (!node) throw new Error(`Node with URL ${url} not found`);
    this.#nodes.delete(url);
    this.#disconnect(url);
    await fsi.remove(this.#path, fileName(url));
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
      await fsi.write(this.#path, fileName(url), JSON.stringify(node));
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
      results.push({ url: peer.node.url, pushed: await this.#push(peer, 'manual') });
    }
    return results;
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
      pending: peer.outbox.length + (peer.pushing ? 1 : 0),
    }));
  }

  #connect(node) {
    if (this.#peers.has(node.url)) return;
    const peer = {
      node,
      link: null,
      remote: null,
      connected: false,
      subscription: null,
      outbox: [],
      pushing: null,
      bootstrapping: false,
      handshaking: null,
      closed: false,
      handlers: null,
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
      // The host already dials us; one link is enough.
      this.#disconnect(node.url);
      return;
    }
    // A host reinstalled since we last spoke: its log speaks another epoch,
    // so our cursor is void and the subscription will say `bootstrap`.
    if (node.remote && node.remote.epoch !== answer.epoch) node.cursor = null;
    const schema = schemaOf(answer.schema);
    peer.remote = { id: answer.node, vector: answer.vector ?? {}, epoch: answer.epoch };
    node.remote = { id: answer.node, epoch: answer.epoch, schema };
    await this.#saveNode(node);
    notify(this, this.#storage.logger, 'peer', { url: node.url, connected: true, node: answer.node, schema });
    this.#drift(schema, { url: node.url, node: answer.node });
    await this.#push(peer, 'handshake');
    if (resubscribe && !peer.subscription) this.#subscribe(peer);
  }

  // Everything in our log the host has not seen, by its vector — ops of its
  // own origin excluded (it has those by definition). A host that is behind
  // what we still retain cannot be caught up from here; it will bootstrap
  // from a node that dials it, or we from it.
  async #push(peer, reason) {
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
      if (answer?.vector) peer.remote.vector = answer.vector;
      sent += page.length;
    }
    if (sent > 0 && !peer.closed) {
      peer.node.lastSync = Date.now();
      await this.#saveNode(peer.node);
      notify(this, this.#storage.logger, 'sync', { url: peer.node.url, pushed: sent });
    }
    return sent;
  }

  #subscribe(peer) {
    const { node, link } = peer;
    peer.subscription = link.subscribe(
      'syncom/changes',
      { scopes: node.scopes },
      {
        lastEventId: node.cursor ?? undefined,
        onData: (value, eventId) => void this.#receive(peer, value, eventId).catch((error) => this.#fail(peer, error)),
        onError: (error) => {
          peer.subscription = null;
          if (peer.closed) return;
          // 428 "say hello first": the host forgot us — on wrpc a reconnect
          // is a new server-side client, and its restored subscription
          // arrives before our hello does. Greet again, then subscribe.
          if (error?.code === 428 && peer.connected) {
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

  async #receive(peer, value, eventId) {
    if (peer.closed || !value) return;
    if (value.bootstrap) return void (await this.#bootstrap(peer));
    const ops = unpackOps(value.ops);
    const result = await this.#storage.applyRemote(ops, {
      via: peer,
      scopes: peer.node.scopes,
      peer: { url: peer.node.url, node: peer.remote.id },
    });
    // Hung up while applying: the cursor is not saved, so a restart replays
    // this page as duplicates — better than a registry write racing whoever
    // reopens the directory next.
    if (peer.closed) return;
    if (eventId) peer.node.cursor = eventId;
    peer.node.lastSync = Date.now();
    await this.#saveNode(peer.node);
    notify(this, this.#storage.logger, 'sync', { url: peer.node.url, received: ops.length, ...result });
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
      await this.#storage.mergeSnapshot(records, { via: peer, from: peer.remote.id });
      total += records.length;
      cursor = page.cursor ?? null;
    } while (cursor !== null);
    // Everything up to the host's vector at the FIRST page is inside what
    // was joined; adopting it (for the scopes asked for) means nobody
    // offers those ops again. Later ops replay from the cursor.
    if (startVector) {
      await this.#storage.adoptVector(scopedVector(startVector, node.scopes), { via: peer, from: peer.remote.id });
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
      if (peer === via || !peer.remote || !peer.connected) continue;
      if (op.origin === peer.remote.id || op.from === peer.remote.id) continue;
      if (vectorHas(peer.remote.vector, op)) continue;
      if (!inScope(op, peer.node.scopes)) continue;
      peer.outbox.push(op);
      this.#scheduleFlush(peer);
    }
  }

  // Ops that land in one tick travel as one push; pushes to a peer never
  // overlap, so its vector answer is always the latest.
  #scheduleFlush(peer) {
    if (peer.pushing) return;
    peer.pushing = Promise.resolve()
      .then(async () => {
        while (peer.outbox.length > 0 && !peer.closed && peer.connected) {
          const ops = peer.outbox;
          peer.outbox = [];
          await this.#send(peer, ops, 'relay');
        }
      })
      .catch((error) => {
        // Dropped on purpose: the next hello/push recomputes from the vector.
        peer.outbox = [];
        this.#fail(peer, error);
      })
      .finally(() => {
        peer.pushing = null;
        if (peer.outbox.length > 0 && !peer.closed && peer.connected) this.#scheduleFlush(peer);
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
    } = options;
    const storage = this.#storage;
    const wakers = this.#wakers;
    const track = tracked ?? ((id, data) => ({ [TRACKED]: true, id: String(id), data }));

    const peerOf = (context) => {
      const state = context?.client?.data?.syncom;
      if (!state) throw coded('Say hello first', 428);
      return state;
    };

    return {
      hello: {
        access,
        handler: async (context, args) => {
          if (!args || typeof args.node !== 'string') throw coded('hello needs a node id', 400);
          if (args.version !== undefined && args.version !== PROTOCOL) {
            throw coded(`Unsupported protocol ${args.version}`, 400);
          }
          if (args.node === storage.nodeId) throw coded('A node cannot sync with itself (copied data directory?)', 409);
          if (authorize && !(await authorize(context, args))) throw coded('Not authorized to sync', 403);
          const scopes = Array.isArray(args.scopes) ? args.scopes.filter((s) => typeof s === 'string') : [GLOBAL_SCOPE];
          const schema = schemaOf(args.schema);
          if (context?.client) {
            context.client.data ??= {};
            context.client.data.syncom = { node: args.node, scopes, vector: args.vector ?? {}, schema };
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
        },
      },

      push: {
        access,
        handler: async (context, args) => {
          const { node, scopes } = peerOf(context);
          const ops = unpackOps(args?.ops);
          // `url` is null: a host does not dial, so it has no url for the peer.
          const result = await storage.applyRemote(ops, { via: context.client, scopes, peer: { url: null, node } });
          return { vector: storage.vector, ...result };
        },
      },

      snapshot: {
        access,
        handler: async (context, args) => {
          peerOf(context);
          const page = await storage.snapshot({
            cursor: args?.cursor ?? null,
            limit: pageSize,
            scopes: args?.scopes ?? null,
          });
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
        },
      },

      changes: {
        access,
        handler: async function* (context, args, subscription = {}) {
          const { node } = peerOf(context);
          const { lastEventId, signal } = subscription;
          const scopes = Array.isArray(args?.scopes) ? args.scopes : null;
          let cursor = lastEventId ?? undefined;
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
            // Labelled even when every op was the peer's own echo: the
            // position still moves, and a resume must not replay it.
            yield track(cursor, { ops: packOps(ops), eventId: cursor });
          }
        },
      },
    };
  }
}

module.exports = { SyncManager, isSyncLink };
