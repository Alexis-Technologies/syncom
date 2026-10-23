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

class MemoryLink extends Emitter {
  #unit;
  #subscriptions = new Set();
  #down = false;
  #options;
  calls = [];

  constructor(unit, options = {}) {
    super();
    this.#unit = unit;
    this.#options = options;
    // What wrpc's `context.client` looks like from a handler's point of view.
    this.client = {
      data: {},
      binary: false,
      rooms: new Set(),
      join: (room) => void this.client.rooms.add(room),
    };
    this.context = { client: this.client };
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
