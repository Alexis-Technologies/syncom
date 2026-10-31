'use strict';

// A frozen copy of the v1 engine: the oracle of tests/sequence.differential.test.js — do not fix.
// Copied from src/text/ at 5ebfb35 as it was; only the requires of modules outside src/text/ point back at
// src/. Removed with the differential test at the end of E2.

// A persistent sorted list in chunks — the segments of a placed run and
// the children hung at its offsets (./sequence.js): entries with a numeric
// `off`, ascending, in chunks of at most CHUNK. A change copies the chunk
// it lands in and the list of chunks, O(√n) for the sizes a run reaches,
// and shares every other chunk; an older version reads as it was. A find
// is two binary searches. No requires.

const CHUNK = 64;

/** The empty list. */
const EMPTY = Object.freeze({ chunks: Object.freeze([]), size: 0 });

/** A list of `entries`, already ascending by `off`. */
const fromArray = (entries) => {
  if (entries.length === 0) return EMPTY;
  const chunks = [];
  for (let i = 0; i < entries.length; i += CHUNK) chunks.push(entries.slice(i, i + CHUNK));
  return { chunks, size: entries.length };
};

/** The entries in order. */
function* iterate(list) {
  for (const chunk of list.chunks) yield* chunk;
}

/** The entries from position (`c`, `i`) down to the first. */
function* backward(list, c, i) {
  for (; c >= 0; c--, i = c >= 0 ? list.chunks[c].length - 1 : 0) {
    const chunk = list.chunks[c];
    for (; i >= 0; i--) yield chunk[i];
  }
}

/** The last entry, or undefined. */
const last = (list) => {
  if (list.size === 0) return undefined;
  const chunk = list.chunks[list.chunks.length - 1];
  return chunk[chunk.length - 1];
};

/**
 * The last entry whose `off` is at or before `key`, with its position:
 * `{ c, i, entry }`. Null when every entry is past `key`, or none is held.
 */
const find = (list, key) => {
  const { chunks } = list;
  // The last chunk starting at or before `key`…
  let lo = 0;
  let hi = chunks.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (chunks[mid][0].off <= key) lo = mid;
    else hi = mid - 1;
  }
  if (chunks.length === 0 || chunks[lo][0].off > key) return null;
  // …and its last entry at or before `key`.
  const chunk = chunks[lo];
  let a = 0;
  let b = chunk.length - 1;
  while (a < b) {
    const mid = (a + b + 1) >> 1;
    if (chunk[mid].off <= key) a = mid;
    else b = mid - 1;
  }
  return { c: lo, i: a, entry: chunk[a] };
};

/** The entry whose `off` is `key`, or undefined. */
const get = (list, key) => {
  const found = find(list, key);
  return found !== null && found.entry.off === key ? found.entry : undefined;
};

// `held` as chunks of at most CHUNK, as even as they come.
const chunked = (held) => {
  if (held.length <= CHUNK) return held.length > 0 ? [held] : [];
  const count = Math.ceil(held.length / CHUNK);
  const size = Math.ceil(held.length / count);
  const pieces = [];
  for (let k = 0; k < held.length; k += size) pieces.push(held.slice(k, k + size));
  return pieces;
};

/**
 * The list with `remove` entries from position (`c`, `i`) replaced by
 * `entries` (in order, keeping the list ascending): the chunks touched
 * copied into one — split when it overflows, dropped when nothing is
 * left — the rest shared. The removal may run on into the chunks after.
 * An empty list takes (0, 0).
 */
const splice = (list, c, i, remove, entries) => {
  const { chunks } = list;
  if (chunks.length === 0) return { chunks: chunked(entries.slice()), size: entries.length };
  // The position right after what is removed: (k, j), k past the end when
  // the removal reaches it.
  let k = c;
  let j = i;
  let left = remove;
  while (left > 0 && k < chunks.length) {
    const available = chunks[k].length - j;
    if (left < available) {
      j += left;
      left = 0;
    } else {
      left -= available;
      k++;
      j = 0;
    }
  }
  const held = chunks[c].slice(0, i);
  for (const entry of entries) held.push(entry);
  const last = Math.min(k, chunks.length - 1);
  if (k < chunks.length) for (let m = j; m < chunks[k].length; m++) held.push(chunks[k][m]);
  // Chunks c..last give way to the pieces of `held`, the rest shared (native
  // copies: a list's chunks can be many).
  const out = chunks.slice(0, c).concat(chunked(held), chunks.slice(last + 1));
  return { chunks: out, size: list.size - (remove - left) + entries.length };
};

/** The list with `entries` (ascending, past the last held) appended. */
const append = (list, entries) => {
  if (entries.length === 0) return list;
  if (list.size === 0) return fromArray(entries);
  const c = list.chunks.length - 1;
  return splice(list, c, list.chunks[c].length, 0, entries);
};

module.exports = { CHUNK, EMPTY, fromArray, iterate, backward, last, find, get, splice, append };
