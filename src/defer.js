'use strict';

// The deferred window of `open({ defer })`: a local write's entry is held —
// the cache and the catalog read it, the file and the chain block wait — in
// a slot per record with the log positions it covers, and the slots land
// together after `window` ms, as a step of the storage's landings (after
// every write in flight before it, so the cache never goes back to an older
// entry and two landings never run at once). The log is durable already; a
// crash before the landing replays the batch at the next open. While a
// landing is queued or running a write arms no timer — the landing arms the
// next window once done, at least as long as it took, so the files of a
// large record never land back to back while the writer waits behind them.
// The window is a count too: past DEFER_RECORDS records or DEFER_POSITIONS
// positions it lands at once (an await loop over memory() never lets a
// timer fire). No requires: the storage hands in what it does.

const DEFER_RECORDS = 1024;
const DEFER_POSITIONS = 8192;

class DeferredWindow {
  #window;
  #host;
  #slots = new Map();
  #positions = 0;
  #timer = null;
  #flushing = false;
  #cost = 0;

  /**
   * `window` in ms; `host`: `hold(id, entry)` (the cache and the catalog),
   * `landing(task)` (a step of the landings, in log order), `land(touched,
   * from, to)` (the files and one block; true when they landed),
   * `applied(position)` (the log told), `saveCatalog()`, `recordFlush(ms,
   * records)` (telemetry).
   */
  constructor(window, host) {
    this.#window = window;
    this.#host = host;
  }

  /** The records waiting, the positions waiting, what the last landing took (ms). */
  get size() {
    return this.#slots.size;
  }

  get positions() {
    return this.#positions;
  }

  get cost() {
    return this.#cost;
  }

  /**
   * A local write of `id` waits for the window: `positions` the op's, or a
   * transaction's ops of the record. Done at once — a promise only where the
   * host's hold waits (a lens over the catalog row).
   */
  write(id, entry, positions) {
    const held = this.#host.hold(id, entry);
    if (held !== null && typeof held === 'object' && typeof held.then === 'function') {
      return held.then(() => this.#enter(id, entry, positions));
    }
    this.#enter(id, entry, positions);
    return undefined;
  }

  #enter(id, entry, positions) {
    let slot = this.#slots.get(id);
    if (slot === undefined) this.#slots.set(id, (slot = { entry, positions: [] }));
    else slot.entry = entry;
    if (typeof positions === 'number') slot.positions.push(positions);
    else for (let i = 0; i < positions.length; i++) slot.positions.push(positions[i]);
    this.#positions += typeof positions === 'number' ? 1 : positions.length;
    if (this.#flushing) return;
    if (this.#slots.size >= DEFER_RECORDS || this.#positions >= DEFER_POSITIONS) {
      void this.flush().catch(() => {});
      return;
    }
    this.#arm();
  }

  /** Lands every slot now, as a step of the landings. */
  flush() {
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    this.#flushing = true;
    return this.#host.landing(() => this.#land());
  }

  /**
   * Another landing wrote record `id` as of `toSeq` (a peer's page, a
   * replay): its slot is settled when that covers every position of it — an
   * older deferred entry is never laid over a newer file.
   */
  settle(id, toSeq) {
    const slot = this.#slots.get(id);
    if (slot === undefined) return;
    for (let i = 0; i < slot.positions.length; i++) if (!(slot.positions[i] <= toSeq)) return;
    this.#slots.delete(id);
    // Its positions wait no more: the count the overflow flush reads goes down with them.
    this.#positions -= slot.positions.length;
    for (const position of slot.positions) this.#host.applied(position);
  }

  // The next window: `window` ms, or as long as the last landing took.
  #arm() {
    if (this.#timer !== null) return;
    this.#timer = setTimeout(
      () => {
        this.#timer = null;
        this.flush().catch(() => {});
      },
      Math.max(this.#window, this.#cost),
    );
    this.#timer.unref?.();
  }

  async #land() {
    try {
      if (this.#slots.size > 0) {
        const started = Date.now();
        const records = this.#slots.size;
        await this.#landSlots();
        this.#cost = Date.now() - started;
        this.#host.recordFlush(this.#cost, records);
      }
    } finally {
      this.#flushing = false;
      if (this.#slots.size > 0) this.#arm();
    }
  }

  // The slots taken when the step runs: a write landing meanwhile is in the
  // next window.
  async #landSlots() {
    const pending = this.#slots;
    this.#slots = new Map();
    this.#positions = 0;
    const touched = new Map();
    const positions = [];
    let from = Infinity;
    let to = -Infinity;
    for (const [id, slot] of pending) {
      touched.set(id, slot.entry);
      for (const position of slot.positions) {
        positions.push(position);
        if (position < from) from = position;
        if (position > to) to = position;
      }
    }
    if (await this.#host.land(touched, from, to)) {
      for (const position of positions) this.#host.applied(position);
    }
    this.#host.saveCatalog();
  }
}

module.exports = { DeferredWindow, DEFER_RECORDS, DEFER_POSITIONS };
