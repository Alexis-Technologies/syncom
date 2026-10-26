'use strict';

// Fractional indexes as strings that sort with `<`: a position for a record
// among its siblings — tasks in a column, blocks of a document — kept in an
// ordinary register field and ordered by `order()`. `between(a, b)` gives a
// key that sorts between two others (either side open), `spread(a, b, n)`
// gives n of them evenly, and a key is never exhausted: there is always
// room between two. Adapted from Loro's fractional index (loro-js
// fractional-index.ts, MIT; see THIRD_PARTY_NOTICES.md): a key is a string
// of digits over a 62-letter alphabet ending in the terminator — the middle
// digit — so that a shorter key sorts where its continuation would.
//
// Two nodes that insert between the same two keys at once mint the same key;
// `{ jitter: n }` appends n random digits, which makes that unlikely and
// keeps the order (the digits before them already decide it). A clash is
// still only an equal sort key — the records keep their ids.

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const BASE = ALPHABET.length;
const TERMINATOR = 31;
const MAX = BASE - 1;

// The digit of each character code of the alphabet, -1 for any other below 128.
const DIGITS = new Int8Array(128).fill(-1);
for (let i = 0; i < BASE; i++) DIGITS[ALPHABET.charCodeAt(i)] = i;

const digitsOf = (key) => {
  if (typeof key !== 'string' || key.length === 0) throw new TypeError('a fractional index is a non-empty string');
  const digits = [];
  for (let i = 0; i < key.length; i++) {
    const code = key.charCodeAt(i);
    const digit = code < 128 ? DIGITS[code] : -1;
    if (digit === -1) throw new TypeError(`not a fractional index: ${JSON.stringify(key)}`);
    digits.push(digit);
  }
  if (digits[digits.length - 1] !== TERMINATOR) throw new TypeError(`not a fractional index: ${JSON.stringify(key)}`);
  return digits;
};
const keyOf = (digits) => {
  let out = '';
  for (let i = 0; i < digits.length; i++) out += ALPHABET[digits[i]];
  return out;
};
const isKey = (key) => {
  try {
    digitsOf(key);
    return true;
  } catch {
    return false;
  }
};

const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const before = (digits) => {
  for (let i = 0; i < digits.length; i++) {
    if (digits[i] > TERMINATOR) return digits.slice(0, i);
    if (digits[i] > 0) {
      const out = digits.slice(0, i + 1);
      out[i]--;
      return out;
    }
  }
  throw new RangeError('invalid fractional index');
};

const after = (digits) => {
  for (let i = 0; i < digits.length; i++) {
    if (digits[i] < TERMINATOR) return digits.slice(0, i);
    if (digits[i] < MAX) {
      const out = digits.slice(0, i + 1);
      out[i]++;
      return out;
    }
  }
  throw new RangeError('invalid fractional index');
};

const middle = (left, right) => {
  const shorter = Math.min(left.length, right.length) - 1;
  for (let i = 0; i < shorter; i++) {
    const difference = right[i] - left[i];
    if (difference > 1) {
      const out = left.slice(0, i + 1);
      out[i] += Math.floor(difference / 2);
      return out;
    }
    if (difference === 1) return [...left.slice(0, i + 1), ...after(left.slice(i + 1))];
    if (difference < 0) return null;
  }
  if (left.length < right.length) {
    const split = shorter + 1;
    if (right[split - 1] < TERMINATOR) return null;
    return [...right.slice(0, split), ...before(right.slice(split))];
  }
  if (left.length > right.length) {
    const split = shorter + 1;
    if (left[split - 1] >= TERMINATOR) return null;
    return [...left.slice(0, split), ...after(left.slice(split))];
  }
  return null;
};

const finish = (digits, jitter) => {
  const out = [...digits];
  for (let i = 0; i < jitter; i++) out.push(Math.floor(Math.random() * BASE));
  out.push(TERMINATOR);
  return keyOf(out);
};

/**
 * A key between `lower` and `upper` — `null`/`undefined` for an open side.
 * Throws RangeError when the bounds are not in order.
 */
const between = (lower, upper, { jitter = 0 } = {}) => {
  if (!Number.isInteger(jitter) || jitter < 0) throw new TypeError('between() takes jitter: a non-negative integer');
  const lo = lower == null ? null : digitsOf(lower);
  const hi = upper == null ? null : digitsOf(upper);
  if (lo === null && hi === null) return finish([], jitter);
  if (lo === null) return finish(before(hi), jitter);
  if (hi === null) return finish(after(lo), jitter);
  if (compare(lower, upper) >= 0) throw new RangeError('between(): the bounds are not in order');
  const digits = middle(lo, hi);
  if (digits === null) throw new RangeError('between(): no key fits between the bounds');
  return finish(digits, jitter);
};

/** `n` increasing keys between the bounds, spread by bisection. */
const spread = (lower, upper, n, options = {}) => {
  if (!Number.isInteger(n) || n < 0) throw new TypeError('spread() takes a non-negative integer count');
  const out = [];
  const fill = (lo, hi, count) => {
    if (count === 0) return;
    const mid = between(lo, hi, options);
    if (count === 1) return void out.push(mid);
    const half = Math.floor(count / 2);
    fill(lo, mid, half);
    out.push(mid);
    fill(mid, hi, count - half - 1);
  };
  fill(lower ?? null, upper ?? null, n);
  return out;
};

module.exports = { between, spread, compare, isKey };
