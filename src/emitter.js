'use strict';

// The event emitter every syncom object extends. No requires: this file is
// reached from the browser bundle and is shared by both halves as it is.
//
// `emit` takes `...args` rather than metautil's single `value`: Record and
// Storage both emit `('update', data, delta)`, and index.d.ts types the
// listener as `(data, delta) => void`. A single-value emit silently drops the
// delta, which is exactly the contract consumers read from the types.
// The listener cap is a leak detector, not a quota: a hundred `change`
// listeners on one storage is a bug worth a throw, ten was a bug worth
// avoiding in tests. `open({ maxListeners })` tunes the storage's.
const DEFAULT_MAX_LISTENERS = 100;

// A listener's call as a promise: a throw becomes a rejection.
const invoke = async (fn, args) => fn(...args);

class Emitter {
  #events = new Map();
  #maxListeners = DEFAULT_MAX_LISTENERS;

  constructor(options = {}) {
    this.#maxListeners = options.maxListeners ?? DEFAULT_MAX_LISTENERS;
  }

  emit(eventName, ...args) {
    const event = this.#events.get(eventName);
    if (!event) {
      if (eventName !== 'error') return Promise.resolve();
      throw new Error('Unhandled error');
    }
    const listeners = event.on.slice();
    const promises = [];
    for (let i = 0; i < listeners.length; i++) promises.push(invoke(listeners[i], args));
    if (event.once.size > 0) {
      const len = event.on.length;
      const remaining = new Array(len);
      let index = 0;
      for (let i = 0; i < len; i++) {
        const listener = event.on[i];
        if (!event.once.has(listener)) remaining[index++] = listener;
      }
      if (index === 0) {
        this.#events.delete(eventName);
      } else {
        remaining.length = index;
        this.#events.set(eventName, { on: remaining, once: new Set() });
      }
    }
    return Promise.all(promises).then(() => undefined);
  }

  // Checked before the listener is kept: one the cap refuses is not left
  // registered behind the throw.
  #addListener(eventName, listener, once) {
    let event = this.#events.get(eventName);
    if (event && event.on.includes(listener)) throw new Error('Duplicate listeners detected');
    if ((event ? event.on.length : 0) + 1 > this.#maxListeners) {
      throw new Error(
        `MaxListenersExceededWarning: Possible memory leak. Current maxListeners is ${this.#maxListeners}.`,
      );
    }
    if (!event) {
      const on = [listener];
      event = { on, once: once ? new Set(on) : new Set() };
      this.#events.set(eventName, event);
    } else {
      event.on.push(listener);
      if (once) event.once.add(listener);
    }
  }

  on(eventName, listener) {
    this.#addListener(eventName, listener, false);
  }

  once(eventName, listener) {
    this.#addListener(eventName, listener, true);
  }

  off(eventName, listener) {
    if (!listener) return void this.#events.delete(eventName);
    const event = this.#events.get(eventName);
    if (!event) return;
    const index = event.on.indexOf(listener);
    if (index > -1) event.on.splice(index, 1);
    event.once.delete(listener);
  }

  toPromise(eventName) {
    return new Promise((resolve) => {
      this.once(eventName, resolve);
    });
  }

  clear(eventName) {
    if (!eventName) return void this.#events.clear();
    this.#events.delete(eventName);
  }

  listeners(eventName) {
    if (!eventName) throw new Error('Expected eventName');
    const event = this.#events.get(eventName);
    return event ? event.on : [];
  }

  listenerCount(eventName) {
    if (!eventName) throw new Error('Expected eventName');
    const event = this.#events.get(eventName);
    return event ? event.on.length : 0;
  }

  eventNames() {
    return [...this.#events.keys()];
  }
}

module.exports = { Emitter, DEFAULT_MAX_LISTENERS };
