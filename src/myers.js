'use strict';

// The difference between two strings as splices: what `updateText` sends
// when an editor hands over a whole new text. Myers' O(ND) algorithm (E. W.
// Myers, "An O(ND) Difference Algorithm and Its Variations", 1986) over
// UTF-16 code units — the units `splice()` counts — after the common prefix
// and suffix are set aside, which is most of a keystroke's diff. Written
// from the paper; no requires, so it ships to the browser as it is.
//
// The result is a list of hunks `[index, count, text]` in the BEFORE
// string's coordinates, last first, so applying them one after another
// leaves every earlier index as it was. A difference deeper than `max`
// edit steps (a paste that replaces most of the text) is one hunk that
// replaces the middle: exact, just not minimal.

const common = (a, b) => {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  return [start, endA, endB];
};

// The shortest edit script from x to y as a list of `[kind, i, j]` steps in
// order — 'd' deletes x[i], 'i' inserts y[j] before x[i] — or null past max.
const shortestEdit = (x, y, max) => {
  const n = x.length;
  const m = y.length;
  const limit = Math.min(n + m, max);
  const offset = limit + 1;
  const width = 2 * offset + 1;
  let v = new Int32Array(width);
  const trace = [];
  for (let d = 0; d <= limit; d++) {
    const snapshot = Int32Array.from(v);
    trace.push(snapshot);
    for (let k = -d; k <= d; k += 2) {
      let i;
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) i = v[offset + k + 1];
      else i = v[offset + k - 1] + 1;
      let j = i - k;
      while (i < n && j < m && x[i] === y[j]) {
        i++;
        j++;
      }
      v[offset + k] = i;
      if (i >= n && j >= m) return backtrack(trace, offset, n, m);
    }
    v = Int32Array.from(v);
  }
  return null;
};

const backtrack = (trace, offset, n, m) => {
  const steps = [];
  let i = n;
  let j = m;
  for (let d = trace.length - 1; d > 0; d--) {
    const v = trace[d];
    const k = i - j;
    let prevK;
    if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) prevK = k + 1;
    else prevK = k - 1;
    const prevI = v[offset + prevK];
    const prevJ = prevI - prevK;
    while (i > prevI && j > prevJ) {
      i--;
      j--;
    }
    if (i === prevI) steps.push(['i', i, j - 1]);
    else steps.push(['d', i - 1, j]);
    i = prevI;
    j = prevJ;
  }
  return steps.reverse();
};

// Steps into hunks: deletions and insertions at one place join into one
// `[index, count, text]`, text taken from y.
const hunksOf = (steps, x, y, start) => {
  const hunks = [];
  let current = null;
  for (const [kind, i, j] of steps) {
    const at = i;
    if (current !== null && current.end === at) {
      if (kind === 'd') current.end = i + 1;
      current.count += kind === 'd' ? 1 : 0;
      current.text += kind === 'i' ? y[j] : '';
      continue;
    }
    if (current !== null) hunks.push([start + current.index, current.count, current.text]);
    current = {
      index: at,
      end: kind === 'd' ? i + 1 : at,
      count: kind === 'd' ? 1 : 0,
      text: kind === 'i' ? y[j] : '',
    };
  }
  if (current !== null) hunks.push([start + current.index, current.count, current.text]);
  return hunks.reverse();
};

const diff = (a, b, { max = 1000 } = {}) => {
  if (typeof a !== 'string' || typeof b !== 'string') throw new TypeError('diff() takes two strings');
  const [start, endA, endB] = common(a, b);
  const x = a.slice(start, endA);
  const y = b.slice(start, endB);
  if (x.length === 0 && y.length === 0) return [];
  if (x.length === 0 || y.length === 0) return [[start, x.length, y]];
  const steps = shortestEdit(x, y, max);
  if (steps === null) return [[start, x.length, y]];
  return hunksOf(steps, x, y, start);
};

// Applies hunks (last first) to `a`: what the diff promises to produce.
const patch = (a, hunks) => {
  let out = a;
  for (const [index, count, text] of hunks) out = out.slice(0, index) + text + out.slice(index + count);
  return out;
};

module.exports = { diff, patch };
