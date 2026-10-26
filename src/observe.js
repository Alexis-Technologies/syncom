'use strict';

// The observers of records (`storage.observe(id, path?, listener)`): per
// record, what to call with its changes of a turn. One `transaction`
// listener of the storage's own feeds them all, attached at the first
// observer — the event is built only while something listens, so observers
// cost nothing before. A listener is contained like an event listener: a
// throw, or a promise that rejects, is logged (`listener.error`), never the
// storage's. Requires paths.js only.

const { under } = require('./paths.js');

// Whether a change of a record concerns `path`: the field itself, what
// hangs under it, a prefix of it (a reset above), or the whole record.
const touches = (change, path) =>
  change.field === undefined || change.field === path || under(change.field, path) || under(path, change.field);

class Observers {
  #emitter;
  #logger;
  #byId = new Map();
  #feeding = null;

  // `emitter` raises the `transaction` events; `logger()` is asked when a listener fails.
  constructor(emitter, logger) {
    this.#emitter = emitter;
    this.#logger = logger;
  }

  /** Listeners registered, over every record. */
  get count() {
    let count = 0;
    for (const set of this.#byId.values()) count += set.size;
    return count;
  }

  /** Watches record `id` (`path` null: the whole record); returns the function that stops watching. */
  add(id, path, listener) {
    const watch = { path, listener };
    let set = this.#byId.get(id);
    if (set === undefined) this.#byId.set(id, (set = new Set()));
    set.add(watch);
    if (this.#feeding === null) {
      this.#feeding = (event) => this.#feed(event);
      this.#emitter.on('transaction', this.#feeding);
    }
    return () => {
      set.delete(watch);
      if (set.size === 0 && this.#byId.get(id) === set) this.#byId.delete(id);
    };
  }

  // A turn's changes handed to the observers of the records they are of.
  #feed(event) {
    const byId = new Map();
    for (const change of event.changes) {
      if (!this.#byId.has(change.id)) continue;
      let list = byId.get(change.id);
      if (list === undefined) byId.set(change.id, (list = []));
      list.push(change);
    }
    for (const [id, list] of byId) {
      for (const { path, listener } of [...this.#byId.get(id)]) {
        let mine = list;
        if (path !== null) {
          mine = [];
          for (let i = 0; i < list.length; i++) if (touches(list[i], path)) mine.push(list[i]);
        }
        if (mine.length === 0) continue;
        try {
          const out = listener(mine, event);
          if (out && typeof out.then === 'function') out.catch((err) => this.#warn(id, err));
        } catch (err) {
          this.#warn(id, err);
        }
      }
    }
  }

  #warn(id, err) {
    this.#logger().warn({ event: 'listener.error', name: 'observe', id, err });
  }
}

module.exports = { Observers, touches };
