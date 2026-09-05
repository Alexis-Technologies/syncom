'use strict';

// Browser twin of ./utils.js, wired in through package.json#browser. The
// filesystem predicates (fileExists / directoryExists) have no counterpart
// here: the browser storage layer goes through OPFS in ./fsi.browser.js.
// `emit` takes `...args` rather than metautil's single `value`: Record and
// Storage both emit `('update', data, delta)`, and index.d.ts types the
// listener as `(data, delta) => void`. A single-value emit silently drops the
// delta, which is exactly the contract consumers read from the types.
class Emitter {
  #events = new Map();
  #maxListeners = 10;

  constructor(options = {}) {
    this.#maxListeners = options.maxListeners ?? 10;
  }

  emit(eventName, ...args) {
    const event = this.#events.get(eventName);
    if (!event) {
      if (eventName !== 'error') return Promise.resolve();
      throw new Error('Unhandled error');
    }
    const listeners = event.on.slice();
    const promises = listeners.map(async (fn) => fn(...args));
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

  #addListener(eventName, listener, once) {
    let event = this.#events.get(eventName);
    if (!event) {
      const on = [listener];
      event = { on, once: once ? new Set(on) : new Set() };
      this.#events.set(eventName, event);
    } else {
      if (event.on.includes(listener)) {
        throw new Error('Duplicate listeners detected');
      }
      event.on.push(listener);
      if (once) event.once.add(listener);
    }
    if (event.on.length > this.#maxListeners) {
      throw new Error(
        `MaxListenersExceededWarning: Possible memory leak. ` + `Current maxListeners is ${this.#maxListeners}.`,
      );
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
    return Array.from(this.#events.keys());
  }
}

const generateUUID = () => crypto.randomUUID();

// A duck-typed logger writer: a Console, a pino-shaped logger, or `false` to
// go silent. Every level is a function, so callers never guard.
const NOOP = () => {};
const createLogger = (logger) => {
  if (logger === false || logger === null) return { debug: NOOP, info: NOOP, warn: NOOP, error: NOOP };
  const target = logger ?? globalThis.console;
  const bind = (level) => (typeof target[level] === 'function' ? target[level].bind(target) : NOOP);
  return { debug: bind('debug'), info: bind('info'), warn: bind('warn'), error: bind('error') };
};

const between = (s, prefix, suffix) => {
  let i = s.indexOf(prefix);
  if (i === -1) return '';
  s = s.substring(i + prefix.length);
  if (suffix) {
    i = s.indexOf(suffix);
    if (i === -1) return '';
    s = s.substring(0, i);
  }
  return s;
};

module.exports = { Emitter, createLogger, generateUUID, between };
