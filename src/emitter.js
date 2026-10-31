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

const isThenable = (value) => value !== null && typeof value === 'object' && typeof value.then === 'function';

// The listeners of an event are a list never changed in place — `on` and
// `off` make a new one — so an emit walks the list it found without a copy,
// and a listener added or taken off meanwhile counts from the next emit.

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
    const listeners = event.on;
    const promises = [];
    for (let i = 0; i < listeners.length; i++) promises.push(invoke(listeners[i], args));
    if (event.once.size > 0) this.#dropOnce(eventName, event, listeners);
    return Promise.all(promises).then(() => undefined);
  }

  /**
   * The contained emit (src/hooks.js `notify`): every listener called at
   * once, in order, with `args`; a throw, or the rejection of a promise one
   * returns, goes to `onError(error)` — one call per listener that failed —
   * and nothing is returned or awaited. No promise is made unless a listener
   * makes one, which is what keeps an event off a write's path.
   */
  dispatch(eventName, args, onError) {
    const event = this.#events.get(eventName);
    if (event === undefined) return;
    const listeners = event.on;
    for (let i = 0; i < listeners.length; i++) {
      try {
        const result = listeners[i](...args);
        if (isThenable(result)) result.then(undefined, onError);
      } catch (error) {
        onError(error);
      }
    }
    if (event.once.size > 0) this.#dropOnce(eventName, event, listeners);
  }

  // The `once` listeners the emit CALLED leave; one added during it (by a
  // listener: `toPromise` inside a `change` listener) was not called and
  // stays for the next emit.
  #dropOnce(eventName, event, called) {
    const remaining = [];
    for (let i = 0; i < event.on.length; i++) {
      const listener = event.on[i];
      if (event.once.has(listener) && called.includes(listener)) {
        event.once.delete(listener);
        continue;
      }
      remaining.push(listener);
    }
    if (remaining.length === 0) this.#events.delete(eventName);
    else event.on = remaining;
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
      const on = event.on.slice();
      on.push(listener);
      event.on = on;
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
    if (index > -1) {
      const on = event.on.slice(0, index);
      for (let i = index + 1; i < event.on.length; i++) on.push(event.on[i]);
      event.on = on;
    }
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
    // A copy: the list handed out is the one an emit walks without copying.
    return event ? event.on.slice() : [];
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
