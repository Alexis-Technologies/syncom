'use strict';

// Whether a regular expression's source is safe to run over a peer's rows: no quantified group with a quantifier
// inside it (`(a+)+`, `(a|aa)*`, `(\w+\s?)+` — the backtracking that takes minutes), no backreference (`\1`,
// `\k<name>`), no lookaround (`(?=`, `(?!`, `(?<=`, `(?<!`). What a host serving `query` under `regex: 'safe'` asks
// of a `$regex` before it compiles it (src/sync/hosting.js); the rest of a pattern is the engine's to judge. A
// scan of the source, never a compile: a character class is skipped whole, an escape with the character it escapes.
// No requires: shared by both halves.

const QUANTIFIER = new Set(['*', '+', '?', '{']);

/** True where `source` has no nested quantifier, no backreference and no lookaround. */
const safeRegex = (source) => {
  if (typeof source !== 'string') return false;
  // One frame per open group: whether a quantifier was seen inside it.
  const groups = [];
  // Whether the last token closed a group that held a quantifier: a quantifier right after it nests.
  let closedQuantified = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === '\\') {
      const next = source[i + 1];
      if (next === undefined) return false;
      if ((next >= '1' && next <= '9') || next === 'k') return false;
      i++;
      closedQuantified = false;
      continue;
    }
    if (c === '[') {
      // A class: to its closing bracket, an escape taken with its character.
      for (i++; i < source.length && source[i] !== ']'; i++) if (source[i] === '\\') i++;
      closedQuantified = false;
      continue;
    }
    if (c === '(') {
      if (source[i + 1] === '?') {
        const kind = source[i + 2];
        if (kind === '=' || kind === '!') return false;
        if (kind === '<' && (source[i + 3] === '=' || source[i + 3] === '!')) return false;
        // `(?:` and `(?<name>`: the group's opening, not a quantifier.
        i += 2;
      }
      groups.push(false);
      closedQuantified = false;
      continue;
    }
    if (c === ')') {
      const quantified = groups.pop() ?? false;
      closedQuantified = quantified;
      continue;
    }
    if (QUANTIFIER.has(c)) {
      // `{` is a quantifier only as `{n}`, `{n,}`, `{n,m}`.
      if (c === '{' && !/^\{\d+(,\d*)?\}/.test(source.slice(i))) {
        closedQuantified = false;
        continue;
      }
      if (closedQuantified) return false;
      for (let g = 0; g < groups.length; g++) groups[g] = true;
      // A lazy `?` after a quantifier is the same quantifier.
      if (source[i + 1] === '?') i++;
      if (c === '{') i = source.indexOf('}', i);
      continue;
    }
    closedQuantified = false;
  }
  return true;
};

module.exports = { safeRegex };
