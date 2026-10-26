'use strict';

// Presence — the `@alexify/syncom/presence` subpath: who is here, what they
// are doing, where their cursor is. Ephemeral state per node, never logged,
// never replicated as ops: `createPresence(storage, { scope, timeout })` is
// an emitter that holds this node's state (`set`, `delete`) and the states
// it heard of (`states`, `get`, `nodes`), hands out what a transport
// carries (`update` events, `encode()`) and takes what one brings
// (`apply()`). A state is a JSON object (at most MAX_STATE_BYTES as JSON,
// MAX_KEYS keys, MAX_DEPTH deep); per node the newest wins by its own
// clock, and a state not renewed within `timeout` is gone — this node's is
// renewed on its own, a third of the timeout at a time. A node with the
// signing plugin signs each state it sends (`[1, node, clock, ts, state]`
// in canonical JSON, Ed25519) and checks the ones it takes: a signature
// that does not verify is forged, and under `sync.signatures: 'require'`
// an unsigned state is refused. The sync plugin carries updates to and
// from a host (`storage.sync.presence(instance)`); any transport of the
// application's own can carry `encode()` and feed `apply()` instead. No
// requires beyond the emitter, the shapes, the symbols and the errors.

const { Emitter } = require('../emitter.js');
const { isPlainObject, isStreamName, isKeyId, canonical } = require('../shape.js');
const { SIGNER } = require('../symbols.js');
const { typed } = require('../errors.js');
const { GLOBAL_SCOPE } = require('../scope.js');

const FORMAT = 1;
const MAX_STATE_BYTES = 16 * 1024;
const MAX_KEYS = 64;
const MAX_DEPTH = 8;
const MAX_STATES = 1024;
const DEFAULT_TIMEOUT = 30_000;
const SIGNATURE = /^[A-Za-z0-9_-]{86}$/;

const depthOf = (value, depth = 1) => {
  if (value === null || typeof value !== 'object') return depth;
  let deepest = depth;
  for (const key of Object.keys(value)) deepest = Math.max(deepest, depthOf(value[key], depth + 1));
  return deepest;
};

// A state's JSON when its size, keys and depth are within the bounds, else null.
const boundedJson = (state) => {
  if (!isPlainObject(state) || Object.keys(state).length > MAX_KEYS) return null;
  if (depthOf(state) > MAX_DEPTH) return null;
  const text = JSON.stringify(state);
  return typeof text === 'string' && text.length <= MAX_STATE_BYTES ? text : null;
};

// A state's size, keys and depth within the bounds; null is a leave.
const sized = (state) => state === null || boundedJson(state) !== null;

// What a signature covers: the format, the node, its clock and stamp, the
// state in canonical JSON — positional, so key order plays no part.
const message = (node, clock, ts, state) => JSON.stringify([FORMAT, node, clock, ts, canonical(state) ?? null]);

const isUpdate = (update) =>
  isPlainObject(update) &&
  update.p === FORMAT &&
  typeof update.scope === 'string' &&
  Array.isArray(update.s) &&
  update.s.length <= MAX_STATES;

const isEntry = (entry) =>
  Array.isArray(entry) &&
  (entry.length === 4 || entry.length === 5) &&
  isStreamName(entry[0]) &&
  Number.isSafeInteger(entry[1]) &&
  entry[1] >= 1 &&
  Number.isSafeInteger(entry[2]) &&
  entry[2] > 0 &&
  (entry[3] === null || isPlainObject(entry[3])) &&
  (entry.length === 4 || (typeof entry[4] === 'string' && SIGNATURE.test(entry[4])));

class Presence extends Emitter {
  #node;
  #scope;
  #timeout;
  #signer;
  #require;
  #clock = 0;
  // Per node: `{ clock, ts, state, sig? }`; this node's among them while it is set.
  #states = new Map();
  #renew = null;
  #sweep = null;
  #destroyed = false;

  constructor(storage, { scope, timeout }) {
    super();
    this.#node = storage.nodeId;
    this.#scope = scope;
    this.#timeout = timeout;
    this.#signer = storage[SIGNER] ?? null;
    this.#require = storage.signatures === 'require';
    this.#sweep = setInterval(() => this.#expire(), Math.max(50, Math.floor(timeout / 2)));
    if (typeof this.#sweep.unref === 'function') this.#sweep.unref();
  }

  /** This node's id. */
  get node() {
    return this.#node;
  }

  /** The scope the states are of. */
  get scope() {
    return this.#scope;
  }

  /** How long a state lives without a renewal, in ms. */
  get timeout() {
    return this.#timeout;
  }

  /** This node's state, or null. */
  get local() {
    return this.#states.get(this.#node)?.state ?? null;
  }

  /** The state of `node`, or undefined. */
  get(node) {
    return this.#states.get(node)?.state ?? undefined;
  }

  /** Every state by node, this node's included. */
  states() {
    const out = new Map();
    for (const [node, held] of this.#states) if (held.state !== null) out.set(node, held.state);
    return out;
  }

  /** The nodes with a state, this one included. */
  nodes() {
    const out = [];
    for (const [node, held] of this.#states) if (held.state !== null) out.push(node);
    return out;
  }

  /**
   * Sets this node's state (a JSON object; `null` leaves): newer than the
   * last by this node's clock, signed when the node can sign, announced as
   * an `update` event for the transport, and renewed on its own until
   * `delete()` or `destroy()`. Resolves to the update sent.
   */
  async set(state) {
    if (this.#destroyed) throw new TypeError('presence was destroyed');
    const text = state === null ? null : boundedJson(state);
    if (state !== null && text === null) {
      throw typed(
        'PRESENCE_SIZE',
        `A presence state is a JSON object of at most ${MAX_KEYS} keys, ${MAX_DEPTH} deep, ${MAX_STATE_BYTES} bytes`,
      );
    }
    const copy = text === null ? null : JSON.parse(text);
    const update = await this.#announce(copy);
    if (copy === null) this.#stopRenewing();
    else if (this.#renew === null) {
      this.#renew = setInterval(() => this.#renewLocal(), Math.max(50, Math.floor(this.#timeout / 3)));
      if (typeof this.#renew.unref === 'function') this.#renew.unref();
    }
    return update;
  }

  /** Leaves: this node's state is null for everyone. */
  delete() {
    return this.set(null);
  }

  async #announce(state) {
    const clock = ++this.#clock;
    const ts = Date.now();
    const entry = [this.#node, clock, ts, state];
    if (this.#signer !== null) entry.push(await this.#signer.signMessage(message(this.#node, clock, ts, state)));
    const was = this.#states.get(this.#node)?.state ?? null;
    // A leave stays as a tombstone until it expires: an older state of
    // this node arriving late cannot bring it back.
    this.#states.set(this.#node, { clock, ts, state, sig: entry[4] });
    const update = { p: FORMAT, scope: this.#scope, s: [entry] };
    this.#changed(
      was === null && state !== null ? [this.#node] : [],
      was !== null && state !== null ? [this.#node] : [],
      was !== null && state === null ? [this.#node] : [],
    );
    await this.emit('update', update);
    return update;
  }

  async #renewLocal() {
    const held = this.#states.get(this.#node);
    if (held === undefined || held.state === null || this.#destroyed) return;
    await this.#announce(held.state);
  }

  #stopRenewing() {
    if (this.#renew !== null) clearInterval(this.#renew);
    this.#renew = null;
  }

  #changed(added, updated, removed) {
    if (added.length + updated.length + removed.length === 0) return;
    void this.emit('change', { added, updated, removed });
  }

  // A state not renewed within the timeout is gone — not this node's,
  // which renews itself.
  #expire() {
    const floor = Date.now() - this.#timeout;
    const removed = [];
    for (const [node, held] of this.#states) {
      if (held.ts >= floor || (node === this.#node && held.state !== null)) continue;
      this.#states.delete(node);
      if (held.state !== null) removed.push(node);
    }
    this.#changed([], [], removed);
  }

  /**
   * Every state known here, this node's included, as one update — what a
   * newcomer is handed; `nodes` narrows it.
   */
  encode(nodes = null) {
    const wanted = nodes === null ? null : new Set(nodes);
    const s = [];
    for (const [node, held] of this.#states) {
      if (held.state === null || (wanted !== null && !wanted.has(node))) continue;
      const entry = [node, held.clock, held.ts, held.state];
      if (held.sig !== undefined) entry.push(held.sig);
      s.push(entry);
    }
    return { p: FORMAT, scope: this.#scope, s };
  }

  /**
   * Takes an update a transport brought: per node the newest by clock
   * wins, a state older than the timeout is stale, one past the bounds is
   * refused, a signature that does not verify is forged, an unsigned one
   * under 'require' refused — this node's own entries, and another scope's
   * update, are ignored. `from`, when given, must be the node of every
   * entry: a peer speaks for itself. Resolves to the counts.
   */
  async apply(update, { from = null } = {}) {
    const out = { applied: 0, stale: 0, forged: 0, unsigned: 0, refused: 0 };
    if (this.#destroyed || !isUpdate(update) || update.scope !== this.#scope) return out;
    const added = [];
    const updated = [];
    const removed = [];
    const floor = Date.now() - this.#timeout;
    for (const entry of update.s) {
      if (!isEntry(entry) || !sized(entry[3]) || (from !== null && entry[0] !== from)) {
        out.refused++;
        continue;
      }
      const [node, clock, ts, state, sig] = entry;
      if (node === this.#node) continue;
      if (sig === undefined) {
        if (this.#require) {
          out.unsigned++;
          continue;
        }
      } else if (
        !isKeyId(node) ||
        this.#signer === null ||
        !(await this.#signer.verifyMessage(message(node, clock, ts, state), sig, node))
      ) {
        out.forged++;
        continue;
      }
      const held = this.#states.get(node);
      if (held !== undefined && (held.clock > clock || (held.clock === clock && held.ts >= ts))) {
        out.stale++;
        continue;
      }
      if (ts < floor) {
        out.stale++;
        continue;
      }
      if (state === null) {
        // A leave: kept as a tombstone until it expires.
        this.#states.set(node, { clock, ts, state: null, sig });
        if (held !== undefined && held.state !== null) removed.push(node);
      } else if (held === undefined && this.#states.size >= MAX_STATES) {
        out.refused++;
        continue;
      } else {
        this.#states.set(node, { clock, ts, state, sig });
        (held === undefined || held.state === null ? added : updated).push(node);
      }
      out.applied++;
    }
    this.#changed(added, updated, removed);
    return out;
  }

  /** Leaves and stops: the timers cleared, every state forgotten; a last `update` says this node is gone. */
  async destroy() {
    if (this.#destroyed) return;
    if (this.local !== null) await this.#announce(null);
    this.#destroyed = true;
    this.#stopRenewing();
    clearInterval(this.#sweep);
    const removed = this.nodes();
    this.#states.clear();
    this.#changed([], [], removed);
  }
}

/**
 * Presence over `storage`'s identity: `scope` (the global one by default)
 * is the sync scope the states are of — a host relays them to the peers
 * of that scope — and `timeout` (30 000 ms) how long a state lives without
 * a renewal.
 */
const createPresence = (storage, { scope = GLOBAL_SCOPE, timeout = DEFAULT_TIMEOUT } = {}) => {
  if (!storage || typeof storage.nodeId !== 'string') throw new TypeError('createPresence() takes a storage');
  if (typeof scope !== 'string' || !isStreamName(scope)) {
    throw new TypeError('createPresence(): scope is a stream name');
  }
  if (!Number.isFinite(timeout) || timeout <= 0) throw new TypeError('createPresence(): timeout is ms > 0');
  return new Presence(storage, { scope, timeout });
};

module.exports = { createPresence, Presence, isUpdate, MAX_STATE_BYTES, MAX_KEYS, MAX_DEPTH, MAX_STATES };
