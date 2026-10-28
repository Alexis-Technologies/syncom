'use strict';

// An in-process SyncLink over a host's `unit()` — what the engine tests run
// on instead of a socket. It mimics what wrpc does at the boundary: arguments
// and results cross as JSON (no shared references, the tracked symbol
// stripped), `changes` is driven as an async generator with `{ lastEventId,
// signal }`, a dropped connection aborts the generator, and a reconnect
// re-opens every subscription from the last event id it delivered — exactly
// wrpc's restore — before announcing `reconnect`.

const { Emitter } = require('../../src/utils.js');

const TRACKED = Symbol.for('wrpc.tracked');
const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

let nextClientId = 1;

class MemoryLink extends Emitter {
  #unit;
  #subscriptions = new Set();
  #down = false;
  #options;
  calls = [];
  sent = [];

  constructor(unit, options = {}) {
    super();
    this.#unit = unit;
    this.#options = options;
    // What wrpc's `context.client` looks like from a handler's point of view.
    this.client = {
      id: `c${nextClientId++}`,
      data: {},
      binary: false,
      rooms: new Set(),
      join: (room) => void this.client.rooms.add(room),
    };
    // The host's server (tests/utils/mesh.js): rooms and `sendTo` over the
    // links of one host, so a handler's relay reaches the other links.
    this.context = { client: this.client, server: options.server ?? null };
    options.server?.links.add(this);
  }

  /** Whether the socket is down. */
  get down() {
    return this.#down;
  }

  /** A fire-and-forget event to the host: the unit's `on` handler, as wrpc would call it. */
  send(event, data) {
    if (this.#down) throw Object.assign(new Error('Connection closed'), { code: 503 });
    const name = event.split('/')[1];
    const handler = this.#unit.on?.[name]?.handler;
    if (!handler) throw Object.assign(new Error(`Unknown event ${event}`), { code: 404 });
    this.sent.push(event);
    const delay = this.#options.latency ? new Promise((resolve) => setTimeout(resolve, this.#options.latency)) : null;
    Promise.resolve(delay)
      .then(() => handler(this.context, clone(data)))
      .catch(() => {});
  }

  /** The host's event to this client — what wrpc's `client.api.syncom.on` hears. */
  deliver(event, data) {
    if (this.#down) return;
    void this.emit(event, clone(data));
  }

  async call(method, args) {
    if (this.#down) throw Object.assign(new Error('Connection closed'), { code: 503 });
    const name = method.split('/')[1];
    const procedure = this.#unit[name];
    if (!procedure) throw Object.assign(new Error(`Unknown method ${method}`), { code: 404 });
    this.calls.push(method);
    if (this.#options.latency) await new Promise((resolve) => setTimeout(resolve, this.#options.latency));
    return clone(await procedure.handler(this.context, clone(args)));
  }

  subscribe(method, args, handlers) {
    const record = { method, args: clone(args), handlers, lastEventId: handlers.lastEventId, controller: null };
    this.#subscriptions.add(record);
    this.#open(record);
    return {
      get lastEventId() {
        return record.lastEventId;
      },
      unsubscribe: () => {
        this.#subscriptions.delete(record);
        record.controller?.abort();
      },
    };
  }

  #open(record) {
    const controller = new AbortController();
    record.controller = controller;
    const name = record.method.split('/')[1];
    const procedure = this.#unit[name];
    const { onData, onError, onEnd } = record.handlers;
    const run = async () => {
      const iterator = procedure.handler(this.context, clone(record.args), {
        lastEventId: record.lastEventId,
        signal: controller.signal,
      });
      for await (const value of iterator) {
        if (controller.signal.aborted) break;
        const isTracked = value && typeof value === 'object' && value[TRACKED] === true;
        const eventId = isTracked ? value.id : undefined;
        const data = clone(isTracked ? value.data : value);
        if (eventId !== undefined) record.lastEventId = eventId;
        if (this.#options.drop?.(data)) continue;
        await onData?.(data, eventId);
        // A page delivered twice, as a flaky transport might: the engine
        // must take the second as the duplicate it is.
        if (this.#options.duplicate?.(data)) await onData?.(clone(data), eventId);
      }
      if (!controller.signal.aborted) {
        this.#subscriptions.delete(record);
        onEnd?.();
      }
    };
    run().catch((error) => {
      if (controller.signal.aborted) return;
      this.#subscriptions.delete(record);
      onError?.(error);
    });
  }

  // --- test hooks -------------------------------------------------------

  /** The socket died: live feeds stop, calls fail, `close` is announced. */
  disconnect() {
    this.#down = true;
    for (const record of this.#subscriptions) record.controller?.abort();
    void this.emit('close');
  }

  /**
   * wrpc's reconnect: a NEW server-side client (its `data` bag is empty, so
   * the host has to be greeted again), every subscription re-opened from the
   * last event id it delivered, then `reconnect` announced.
   */
  async reconnect({ freshClient = true } = {}) {
    this.#down = false;
    if (freshClient) this.client.data = {};
    for (const record of Array.from(this.#subscriptions)) this.#open(record);
    await this.emit('open');
    await this.emit('reconnect');
  }

  close() {
    this.#down = true;
    for (const record of this.#subscriptions) record.controller?.abort();
    this.#subscriptions.clear();
  }
}

module.exports = { MemoryLink };
