'use strict';

// The in-process doubles of what several tabs share: `createLeaderPort()` is
// the port the leader mounts its procedures on and every follower dials —
// JSON across, the leader's handlers run with a bare context, a call with no
// leader mounted a transport failure (the follower tries again) — and
// `createBroadcastChannels()` a BroadcastChannel per name over one bus
// (`postMessage` reaches every other channel of the name on a microtask), the
// constructor an engine takes as `channel` and an election as its channel.

const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

const createLeaderPort = () => {
  let mounted = null;
  const port = {
    calls: [],
    /** The leader's `serve()` mounted; `null` unmounts (the leader went). */
    mount(procedures) {
      mounted = procedures;
    },
    get mounted() {
      return mounted !== null;
    },
    /** A follower's channel: `openShared({ channel: port.dial })`. */
    dial: async () => ({
      async call(method, args) {
        port.calls.push(method);
        const procedure = mounted?.[method];
        if (procedure === undefined) {
          const error = new Error(`no leader answers ${method}`);
          error.code = 'ECONNREFUSED';
          throw error;
        }
        return clone(await procedure.handler({ client: null }, clone(args)));
      },
      close() {},
    }),
  };
  return port;
};

const createBroadcastChannels = () => {
  const buses = new Map();
  class FakeBroadcastChannel {
    #name;
    #listeners = new Set();
    #closed = false;
    onmessage = null;
    constructor(name) {
      this.#name = name;
      let bus = buses.get(name);
      if (bus === undefined) buses.set(name, (bus = new Set()));
      bus.add(this);
    }
    get name() {
      return this.#name;
    }
    postMessage(message) {
      if (this.#closed) throw new Error('closed');
      const copy = clone(message);
      for (const other of buses.get(this.#name)) {
        if (other === this || other.#closed) continue;
        queueMicrotask(() => other.#deliver(copy));
      }
    }
    #deliver(data) {
      if (this.#closed) return;
      const event = { data };
      this.onmessage?.(event);
      for (const listener of this.#listeners) listener(event);
    }
    addEventListener(type, listener) {
      if (type === 'message') this.#listeners.add(listener);
    }
    removeEventListener(type, listener) {
      if (type === 'message') this.#listeners.delete(listener);
    }
    close() {
      this.#closed = true;
      buses.get(this.#name)?.delete(this);
    }
  }
  return FakeBroadcastChannel;
};

module.exports = { createLeaderPort, createBroadcastChannels };
