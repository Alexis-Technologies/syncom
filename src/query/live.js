'use strict';

// A live query (the query plugin's): the rows a cursor matches, kept as the
// collection changes without running the cursor again — event-reduce. The
// catalog says which record changed (`subscribe`); the record is read once
// (the idea is RxDB's event-reduce-js, MIT, read as a specification: nothing
// of it is copied — the rules here are the catalog's actions and the
// cursor's order);
// (the cache has it: it was just written), matched, and placed: in the
// result and matching → moved to where it sorts; in and not matching →
// taken out; not in and matching → put where it sorts; neither → nothing.
// A window (`offset + limit`) holds that many rows from the top; a row that
// leaves a full window, or moves past it, calls for a run of the cursor —
// the successor beyond the window is not known — as does a `$text` query,
// whose order is the index's ranking. Emits only when the rows changed: an
// id came, went or moved, or a row reads as another object — and delivers a
// row that stayed as the very copy it delivered before (`#delivered`), so a
// change costs one copy, not one per row, and a subscriber may tell a row
// that moved by its identity. `count` mode keeps the matching ids alone and
// emits the number when it moves. One listener of the catalog, however many
// subscribers. Requires shape.js only: it ships to the browser.

const { deepEqual } = require('../shape.js');

const noop = () => {};

// The place of `row` among `rows` by `compare`: the first index that sorts after it.
const placeOf = (rows, row, compare) => {
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (compare(rows[mid], row) <= 0) low = mid + 1;
    else high = mid;
  }
  return low;
};

class Live {
  #source;
  #spec;
  #mode;
  #logger;
  #subscribers = new Map();
  // The rows kept, in order, up to the window's length; by id, and the
  // object each was built from (the identity a change is told by).
  #rows = [];
  #index = new Map();
  #identity = new Map();
  // Count mode: the matching ids.
  #ids = new Set();
  // What was delivered of each row, by id: handed out again while the row reads the same (`#placed` drops the copy
  // of one that reads as another, `#load` the copies of what a run read anew, `#out` those of the rows that left).
  #delivered = new Map();
  #count = -1;
  #unsubscribe = null;
  #pending = new Set();
  #reducing = false;
  #rerun = false;
  #ran = false;
  #stopped = false;
  #onStop;

  /**
   * `spec`: `{ entity, wanted (offset + limit), offset, compare, covered,
   * textual, rowOf(id) → row | null (async where the record is read),
   * matches(row), project(row) → what is delivered of a row, top() → rows
   * (a run of the cursor), deliver(rows) → what the subscribers get (populated rows: read whole, every
   * time), deliverOne(row) → the copy of one row (where nothing is populated), onRows(rows) (the cache's) }`.
   */
  constructor(source, spec, mode = 'rows', onStop = noop) {
    this.#source = source;
    this.#spec = spec;
    this.#mode = mode;
    this.#logger = source.logger;
    this.#onStop = onStop;
  }

  /** The rows kept, as they are — the cache's result of the key while the run lasts. */
  get rows() {
    return this.#rows;
  }

  /** Calls `listener` with the rows (or the count) now and when they change; answers the function that takes it off. */
  subscribe(listener, onError = null) {
    if (this.#stopped) throw new TypeError('watch(): this live query was stopped');
    const entry = { listener, onError };
    this.#subscribers.set(entry, true);
    if (this.#unsubscribe === null) {
      this.#unsubscribe = this.#source.subscribe(this.#spec.entity, (changed, id) => this.#hear(changed, id));
      queueMicrotask(() => this.#run());
    } else if (this.#ran) queueMicrotask(() => this.#tell(entry));
    return () => {
      if (!this.#subscribers.delete(entry) || this.#subscribers.size > 0) return;
      this.#stop();
    };
  }

  #stop() {
    this.#stopped = true;
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    this.#onStop();
  }

  // A record of the entity changed: reduced in a turn of its own, the ids
  // that change meanwhile with it; one that leaves a covered row as it was
  // changed nothing a covered cursor reads.
  #hear(changed, id) {
    if (this.#stopped) return;
    if (changed === false && this.#spec.covered) return;
    if (this.#spec.textual) this.#rerun = true;
    else this.#pending.add(id);
    if (!this.#reducing) queueMicrotask(() => this.#reduce());
  }

  async #reduce() {
    if (this.#reducing || this.#stopped) return;
    this.#reducing = true;
    try {
      let moved = false;
      // Before the first run, nothing is kept: the run reads everything.
      if (!this.#ran) this.#rerun = true;
      while (!this.#stopped && (this.#pending.size > 0 || this.#rerun)) {
        const { otel } = this.#source;
        if (this.#rerun) {
          this.#rerun = false;
          this.#pending.clear();
          if (otel?.enabled && this.#ran) otel.recordQueryLive('rerun');
          await this.#load();
          moved = true;
          continue;
        }
        const ids = [...this.#pending];
        this.#pending.clear();
        for (let i = 0; i < ids.length && !this.#rerun; i++) {
          if (otel?.enabled) otel.recordQueryLive('reduce');
          const row = await this.#spec.rowOf(ids[i]);
          if (this.#mode === 'count') moved = this.#counted(ids[i], row) || moved;
          else moved = this.#placed(ids[i], row) || moved;
        }
      }
      if (moved && !this.#stopped) await this.#emit();
    } catch (error) {
      this.#fail(error);
    } finally {
      this.#reducing = false;
      if (!this.#stopped && (this.#pending.size > 0 || this.#rerun)) queueMicrotask(() => this.#reduce());
    }
  }

  #run() {
    if (!this.#reducing) this.#reduce();
  }

  // The cursor run whole: what is kept replaced by it.
  async #load() {
    const rows = await this.#spec.top();
    const was = this.#identity;
    this.#rows = rows;
    this.#index.clear();
    this.#identity = new Map();
    this.#ids.clear();
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const identity = this.#spec.identityOf(row);
      // Read anew: the copy of a row whose view is another goes.
      if (was.get(row.id) !== identity) this.#delivered.delete(row.id);
      this.#index.set(row.id, row);
      this.#identity.set(row.id, identity);
      this.#ids.add(row.id);
    }
    this.#ran = true;
  }

  // Count mode: the id in or out of the matching set.
  #counted(id, row) {
    const matches = row !== null && this.#spec.matches(row);
    if (matches === this.#ids.has(id)) return false;
    if (matches) this.#ids.add(id);
    else this.#ids.delete(id);
    return true;
  }

  // The record as it reads now, placed among the rows; answers whether the
  // rows changed — or marks a run where the window cannot say.
  #placed(id, row) {
    const { wanted, compare } = this.#spec;
    const rows = this.#rows;
    const matches = row !== null && this.#spec.matches(row);
    const was = this.#index.get(id);
    const full = rows.length >= wanted;
    if (was === undefined) {
      if (!matches) return false;
      const at = placeOf(rows, row, compare);
      // Beyond a full window: not among the rows kept.
      if (at >= wanted) return false;
      rows.splice(at, 0, row);
      this.#index.set(id, row);
      this.#identity.set(id, this.#spec.identityOf(row));
      if (rows.length > wanted) {
        const dropped = rows.pop();
        this.#index.delete(dropped.id);
        this.#identity.delete(dropped.id);
      }
      return true;
    }
    const from = rows.indexOf(was);
    if (!matches) {
      rows.splice(from, 1);
      this.#index.delete(id);
      this.#identity.delete(id);
      this.#delivered.delete(id);
      // A full window lost a row: its successor beyond is not known here.
      if (full && wanted !== Infinity) this.#rerun = true;
      return true;
    }
    // The same row: the object it reads as, or — a write of the value it held makes a new one, a
    // change of a field the projection drops too — what is delivered of it.
    const { project } = this.#spec;
    const same = this.#identity.get(id) === this.#spec.identityOf(row) || deepEqual(project(was), project(row));
    if (!same) this.#delivered.delete(id);
    rows.splice(from, 1);
    const at = placeOf(rows, row, compare);
    if (at >= wanted || (full && at === rows.length)) {
      // Moved past the window, or to the end of a full one where a row beyond may sort before it:
      // out, and the cursor runs again for what belongs there.
      this.#index.delete(id);
      this.#identity.delete(id);
      this.#delivered.delete(id);
      if (full) this.#rerun = true;
      return true;
    }
    rows.splice(at, 0, row);
    this.#index.set(id, row);
    this.#identity.set(id, this.#spec.identityOf(row));
    return !same || at !== from;
  }

  async #emit() {
    if (this.#mode === 'count') {
      if (this.#ids.size === this.#count) return;
      this.#count = this.#ids.size;
      for (const entry of this.#subscribers.keys()) this.#call(entry, this.#count);
      return;
    }
    this.#spec.onRows(this.#rows);
    const out = await this.#out();
    for (const entry of this.#subscribers.keys()) this.#call(entry, out);
  }

  // What the subscribers get: the rows from the offset, each the copy it was delivered as while it reads the same —
  // only a row that came, or reads as another, is copied again; populated rows are read whole.
  async #out() {
    const rows = this.#rows.slice(this.#spec.offset);
    if (this.#spec.deliverOne === null) return this.#spec.deliver(rows);
    const kept = this.#delivered;
    const fresh = new Map();
    const out = [];
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      let copy = kept.get(row.id);
      if (copy === undefined) copy = this.#spec.deliverOne(row);
      fresh.set(row.id, copy);
      out.push(copy);
    }
    this.#delivered = fresh;
    return out;
  }

  // A subscriber that came after the first run hears the rows as they are.
  async #tell(entry) {
    if (this.#stopped || !this.#subscribers.has(entry)) return;
    try {
      if (this.#mode === 'count') this.#call(entry, this.#ids.size);
      else this.#call(entry, await this.#out());
    } catch (error) {
      this.#fail(error, entry);
    }
  }

  #call(entry, value) {
    try {
      entry.listener(value);
    } catch (error) {
      this.#fail(error, entry);
    }
  }

  // A failure to the subscribers' `onError`, or to the logger; an `onError` that throws is contained the same way.
  #fail(error, only = null) {
    const entries = only === null ? [...this.#subscribers.keys()] : [only];
    for (let i = 0; i < entries.length; i++) {
      if (entries[i].onError === null) {
        this.#logger.warn({ event: 'watch.error', entity: this.#spec.entity, err: error });
        continue;
      }
      try {
        entries[i].onError(error);
      } catch (thrown) {
        this.#logger.warn({ event: 'watch.error', entity: this.#spec.entity, err: thrown, cause: error });
      }
    }
  }
}

module.exports = { Live };
