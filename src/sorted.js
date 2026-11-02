'use strict';

// A sorted index of `(keys, id)` entries over chunked sorted arrays — what the
// catalog keeps per declared index (src/catalog.js `#keyed`) and a cursor
// scans in key order. Each chunk holds `ids` and `keys` flat, `k` keys per
// entry — no object per entry (27 bytes an entry measured, against 114 for
// one). `insert`/`remove` are a binary search over the chunks' last entries,
// then within one, and one `splice` (a split past CHUNK, a merge with the
// left neighbour under CHUNK / 2): O(√n) with the constants of a memmove.
// `seek` finds the first entry not below (or above) a probe of some leading
// keys and an id; `iterate` walks from a position forward, or backward by
// GROUP of equal keys — the result's one order: keys backwards, ids forwards
// within equal keys; `build` sorts once (a load, a definition, an adoption);
// `ordinal` counts the entries before a position (an estimate). A position
// is `{ chunk, offset }`, the end `{ chunk: last, offset: its length }`.
// `compare`/`rankOf` are the one order of values the catalog, the cursor and
// the planner share: nothing, then booleans, numbers, strings, then
// everything else (equal among themselves, left where it was). No requires:
// it ships to the browser.

const CHUNK = 512;

// A total order for sorting: nothing, then booleans, numbers, strings, then
// everything else (left where it was) — the order of `order()`, of a sorted
// index, of `$gt` and the rest, which hold only between values of one of
// the three ordered kinds.
const rankOf = (value) => {
  if (value === undefined || value === null) return 0;
  const type = typeof value;
  if (type === 'boolean') return 1;
  if (type === 'number') return 2;
  if (type === 'string') return 3;
  return 4;
};

const compare = (a, b) => {
  const rank = rankOf(a);
  const other = rankOf(b);
  if (rank !== other) return rank - other;
  if (rank === 0 || rank === 4) return 0;
  return a < b ? -1 : a > b ? 1 : 0;
};

// Two entries `{ keys, id }`: by each key, then by id.
const compareEntries = (a, b) => {
  for (let i = 0; i < a.keys.length; i++) {
    const order = compare(a.keys[i], b.keys[i]);
    if (order !== 0) return order;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
};

const empty = () => ({ ids: [], keys: [] });

/** Whether position `a` lies before position `b`. */
const beforePosition = (a, b) => a.chunk < b.chunk || (a.chunk === b.chunk && a.offset < b.offset);

class SortedIndex {
  #k;
  #chunks = [empty()];
  #size = 0;

  constructor(k) {
    if (!Number.isInteger(k) || k < 1) throw new TypeError('SortedIndex takes the number of keys an entry holds');
    this.#k = k;
  }

  /** How many entries the index holds. */
  get size() {
    return this.#size;
  }

  /** How many keys an entry holds. */
  get k() {
    return this.#k;
  }

  /** How many chunks hold the entries (`stats`). */
  get chunks() {
    return this.#chunks.length;
  }

  /** The position past the last entry. */
  get end() {
    const last = this.#chunks.length - 1;
    return { chunk: last, offset: this.#chunks[last].ids.length };
  }

  /** The position of the first entry (the end, of an empty index). */
  get start() {
    return { chunk: 0, offset: 0 };
  }

  // The entry at a position against a probe: `count` leading keys, then the id (null: the keys alone).
  #compareAt(chunk, offset, keys, count, id) {
    const base = offset * this.#k;
    for (let i = 0; i < count; i++) {
      const order = compare(chunk.keys[base + i], keys[i]);
      if (order !== 0) return order;
    }
    if (id === null) return 0;
    const own = chunk.ids[offset];
    return own < id ? -1 : own > id ? 1 : 0;
  }

  /**
   * The first position whose entry is not below the probe (`orEqual`), or
   * is above it (`!orEqual`): `count` leading `keys`, then `id` (null for
   * the keys alone). Two binary searches: over the chunks by their last
   * entry, then within the chunk found.
   */
  seek(keys, count, id, orEqual) {
    const chunks = this.#chunks;
    let low = 0;
    let high = chunks.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      const chunk = chunks[mid];
      const order = chunk.ids.length === 0 ? 1 : this.#compareAt(chunk, chunk.ids.length - 1, keys, count, id);
      if (orEqual ? order < 0 : order <= 0) low = mid + 1;
      else high = mid;
    }
    if (low === chunks.length) return this.end;
    const chunk = chunks[low];
    let lo = 0;
    let hi = chunk.ids.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const order = this.#compareAt(chunk, mid, keys, count, id);
      if (orEqual ? order < 0 : order <= 0) lo = mid + 1;
      else hi = mid;
    }
    return { chunk: low, offset: lo };
  }

  /** How many entries lie before `position`. */
  ordinal(position) {
    let count = position.offset;
    for (let i = 0; i < position.chunk; i++) count += this.#chunks[i].ids.length;
    return count;
  }

  /** The id at `position`, or null at the end. */
  at(position) {
    const chunk = this.#chunks[position.chunk];
    return position.offset < chunk.ids.length ? chunk.ids[position.offset] : null;
  }

  /** The keys of the entry at `position` (a copy), or null at the end. */
  keysAt(position) {
    const chunk = this.#chunks[position.chunk];
    if (position.offset >= chunk.ids.length) return null;
    const out = [];
    const base = position.offset * this.#k;
    for (let i = 0; i < this.#k; i++) out.push(chunk.keys[base + i]);
    return out;
  }

  /** Whether the entry at `position` holds `keys` as its first `count` keys (false at the end). */
  holds(position, keys, count) {
    const chunk = this.#chunks[position.chunk];
    if (position.offset >= chunk.ids.length) return false;
    return this.#compareAt(chunk, position.offset, keys, count, null) === 0;
  }

  // Whether the entries at two positions hold the same keys.
  sameKeys(a, b) {
    const one = this.#chunks[a.chunk];
    const other = this.#chunks[b.chunk];
    const baseA = a.offset * this.#k;
    const baseB = b.offset * this.#k;
    for (let i = 0; i < this.#k; i++) if (compare(one.keys[baseA + i], other.keys[baseB + i]) !== 0) return false;
    return true;
  }

  /** Puts an entry in its place. */
  insert(keys, id) {
    const { chunk: c, offset } = this.seek(keys, this.#k, id, true);
    const chunks = this.#chunks;
    const chunk = c < chunks.length ? chunks[c] : chunks[chunks.length - 1];
    const k = this.#k;
    chunk.ids.splice(offset, 0, id);
    // The keys laid in one by one, last first, so each lands at the entry's base (a loop: no data array spread).
    for (let i = k - 1; i >= 0; i--) chunk.keys.splice(offset * k, 0, keys[i]);
    this.#size++;
    if (chunk.ids.length > CHUNK) {
      const half = chunk.ids.length >>> 1;
      const next = { ids: chunk.ids.splice(half), keys: chunk.keys.splice(half * k) };
      chunks.splice(c + 1, 0, next);
    }
  }

  /** Takes an entry out, by its keys and id; answers whether it was there. */
  remove(keys, id) {
    const { chunk: c, offset } = this.seek(keys, this.#k, id, true);
    const chunks = this.#chunks;
    if (c >= chunks.length) return false;
    const chunk = chunks[c];
    if (offset >= chunk.ids.length || chunk.ids[offset] !== id) return false;
    if (this.#compareAt(chunk, offset, keys, this.#k, null) !== 0) return false;
    const k = this.#k;
    chunk.ids.splice(offset, 1);
    chunk.keys.splice(offset * k, k);
    this.#size--;
    if (chunk.ids.length === 0) {
      if (chunks.length > 1) chunks.splice(c, 1);
      return true;
    }
    // Two small neighbours become one: the chunk pushed into the one before it.
    if (c > 0 && chunks[c - 1].ids.length + chunk.ids.length <= CHUNK >>> 1) {
      const left = chunks[c - 1];
      for (let i = 0; i < chunk.ids.length; i++) left.ids.push(chunk.ids[i]);
      for (let i = 0; i < chunk.keys.length; i++) left.keys.push(chunk.keys[i]);
      chunks.splice(c, 1);
    }
    return true;
  }

  /**
   * The index built once from `entries` (`{ keys, id }` each, in any order)
   * PLUS what it holds: one sort, the chunks filled to CHUNK. What a load, a
   * definition and an adoption use instead of an insert a row.
   */
  build(entries) {
    const all = [];
    const k = this.#k;
    for (let c = 0; c < this.#chunks.length; c++) {
      const chunk = this.#chunks[c];
      for (let i = 0; i < chunk.ids.length; i++) {
        const keys = [];
        for (let j = 0; j < k; j++) keys.push(chunk.keys[i * k + j]);
        all.push({ keys, id: chunk.ids[i] });
      }
    }
    for (let i = 0; i < entries.length; i++) all.push(entries[i]);
    all.sort(compareEntries);
    const chunks = [];
    for (let i = 0; i < all.length; i += CHUNK) {
      const chunk = empty();
      const stop = Math.min(all.length, i + CHUNK);
      for (let j = i; j < stop; j++) {
        chunk.ids.push(all[j].id);
        for (let x = 0; x < k; x++) chunk.keys.push(all[j].keys[x]);
      }
      chunks.push(chunk);
    }
    this.#chunks = chunks.length > 0 ? chunks : [empty()];
    this.#size = all.length;
  }

  // The position after `position` (the end stays the end).
  #succ(position) {
    const chunk = this.#chunks[position.chunk];
    if (position.offset + 1 < chunk.ids.length) return { chunk: position.chunk, offset: position.offset + 1 };
    if (position.chunk + 1 < this.#chunks.length) return { chunk: position.chunk + 1, offset: 0 };
    return { chunk: position.chunk, offset: chunk.ids.length };
  }

  // The position before `position`, or null before the first.
  #prev(position) {
    if (position.offset > 0) return { chunk: position.chunk, offset: position.offset - 1 };
    let c = position.chunk - 1;
    while (c >= 0 && this.#chunks[c].ids.length === 0) c--;
    if (c < 0) return null;
    return { chunk: c, offset: this.#chunks[c].ids.length - 1 };
  }

  // Whether `a` lies before `b`.
  #before(a, b) {
    return a.chunk < b.chunk || (a.chunk === b.chunk && a.offset < b.offset);
  }

  /**
   * The ids from `from` up to `to` (exclusive): `{ next() }` — an id, or null
   * past the last. Forward in key order then id; backward (`desc`) by GROUP
   * of equal keys — the groups from the last down, the ids of each forward —
   * the result's one order. `startAt`, a position inside a group, begins the
   * backward walk with the rest of that group from there on, then the groups
   * below it: a page's edge.
   */
  iterate(from, to, desc, startAt = null) {
    if (!desc) {
      let cursor = from;
      return {
        next: () => {
          if (!this.#before(cursor, to)) return null;
          const id = this.at(cursor);
          cursor = this.#succ(cursor);
          return id;
        },
      };
    }
    const pending = [];
    let end = to;
    let started = startAt === null;
    const group = () => {
      // The group before `end`, within `from`: its ids forward.
      const last = this.#prev(end);
      if (last === null || this.#before(last, from)) {
        end = from;
        return;
      }
      let first = last;
      for (;;) {
        const before = this.#prev(first);
        if (before === null || this.#before(before, from) || !this.sameKeys(before, last)) break;
        first = before;
      }
      let cursor = first;
      while (this.#before(cursor, end)) {
        pending.push(this.at(cursor));
        cursor = this.#succ(cursor);
      }
      end = first;
    };
    return {
      next: () => {
        if (!started) {
          // The rest of the edge's group from `startAt` on, then the groups below the group's start.
          started = true;
          let cursor = startAt;
          while (this.#before(cursor, to) && this.sameKeys(cursor, startAt)) {
            pending.push(this.at(cursor));
            cursor = this.#succ(cursor);
          }
          let first = startAt;
          for (;;) {
            const before = this.#prev(first);
            if (before === null || this.#before(before, from) || !this.sameKeys(before, startAt)) break;
            first = before;
          }
          end = first;
        }
        while (pending.length === 0 && this.#before(from, end)) group();
        return pending.length > 0 ? pending.shift() : null;
      },
    };
  }
}

module.exports = { SortedIndex, CHUNK, rankOf, compare, compareEntries, beforePosition };
