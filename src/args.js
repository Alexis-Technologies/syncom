'use strict';

// What the write API takes, checked where it enters — the public methods of
// Storage and the patches applyPatches() realizes (src/patch.js) — so a patch
// never reaches the engine with a shape a method call could not have.
// Requires ./paths.js alone (no requires itself): patch.js and the undo
// subpath ship with both, without the op model.

const { isPath, MAX_PATH_DEPTH, MAX_PATH } = require('./paths.js');

const MAX_NODE_ID = 128;
const EXPANDS = ['before', 'after', 'both', 'none'];

const hasControl = (value) => {
  for (let i = 0; i < value.length; i++) if (value.charCodeAt(i) < 32) return true;
  return false;
};

// A tree node id: a non-empty string of at most 128 characters — never
// `__proto__` (a key) or `$trash` (the removal parent), no control characters.
const isNodeId = (value) =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= MAX_NODE_ID &&
  value !== '__proto__' &&
  value !== '$trash' &&
  !hasControl(value);

// A value JSON can carry — anything but undefined, a function or a symbol —
// which is what a record field, a set element and a list element are.
const isJsonValue = (value) => value !== undefined && typeof value !== 'function' && typeof value !== 'symbol';

// A field name, or a path of them (`profile/city`): the segments non-empty,
// never `__proto__`, at most MAX_PATH_DEPTH deep and MAX_PATH long.
const fieldName = (method, key) => {
  if (typeof key !== 'string') throw new TypeError(`${method}() takes a field name`);
  if (!isPath(key)) {
    const shown = JSON.stringify(key.length > 40 ? `${key.slice(0, 40)}…` : key);
    throw new TypeError(
      `${method}() takes a field name or a path of them (${shown}): segments of at most ${MAX_PATH_DEPTH}, ${MAX_PATH} characters in all, none empty or __proto__`,
    );
  }
};

// What unset() takes: a field name, or a non-empty array of them, each a
// key of the record (never `__proto__`). Returns the names, each once.
const fieldNames = (method, fields) => {
  const list = typeof fields === 'string' ? [fields] : fields;
  if (!Array.isArray(list) || list.length === 0) {
    throw new TypeError(`${method}() takes a field name or a non-empty array of them`);
  }
  for (const field of list) fieldName(method, field);
  return [...new Set(list)];
};

/** `value` when JSON can carry it; a TypeError naming the method otherwise. */
const jsonValue = (method, value) => {
  if (!isJsonValue(value)) throw new TypeError(`${method}() takes a JSON value; got ${typeof value}`);
  return value;
};

// What splice()/push() take: a field name, an index (null: the end) and a
// count, and content — a string for a text, an array of JSON values for a
// list, absent when the call only cuts. Returns the payload. A text's embed
// slot (U+FFFC) enters with its value, through insertEmbed() or a patch
// that carries `vals`, never as plain content.
const EMBED = '\uFFFC';
const spliceArgs = (method, key, index, count, content, { embeds = false } = {}) => {
  fieldName(method, key);
  if (index !== null && !(Number.isInteger(index) && index >= 0)) {
    throw new TypeError(`${method}() takes a non-negative integer index`);
  }
  if (!Number.isInteger(count) || count < 0) throw new TypeError(`${method}() takes a non-negative integer count`);
  if (content !== undefined && typeof content !== 'string' && !Array.isArray(content)) {
    throw new TypeError(`${method}() takes a string for a text or an array for a list`);
  }
  // A lone surrogate half would leave the text malformed for every reader.
  if (typeof content === 'string' && !content.isWellFormed()) {
    throw new TypeError(`${method}() takes well-formed text; the content holds a lone surrogate half`);
  }
  if (!embeds && typeof content === 'string' && content.includes(EMBED)) {
    throw new TypeError(`${method}() takes text; an embed (U+FFFC) is inserted with insertEmbed() or splitBlock()`);
  }
  if (Array.isArray(content)) {
    for (const element of content) {
      if (!isJsonValue(element)) throw new TypeError(`${method}() takes JSON values; got ${typeof element}`);
    }
  }
  if (count === 0 && (content === undefined || content.length === 0)) {
    throw new TypeError(`${method}() takes a count to remove or content to insert`);
  }
  const payload = { key, index, count };
  if (content !== undefined) payload.content = content;
  return payload;
};

// What treeMove()/treeRemove() take: a field name, a node id, a parent (a
// node id or null) and at most one sibling to land after or before.
const treeArgs = (method, key, node, parent, { after, before } = {}) => {
  fieldName(method, key);
  if (!isNodeId(node)) throw new TypeError(`${method}() takes a node id: a non-empty string of at most 128 characters`);
  if (parent !== null && !isNodeId(parent)) throw new TypeError(`${method}() takes a parent: a node id or null`);
  if (parent === node) throw new TypeError(`${method}() cannot put a node under itself`);
  if (after !== undefined && before !== undefined) throw new TypeError(`${method}() takes after or before, not both`);
  const siblings = [
    ['after', after],
    ['before', before],
  ];
  for (const [name, value] of siblings) {
    if (value === undefined) continue;
    if (!isNodeId(value)) throw new TypeError(`${method}() takes ${name}: a node id`);
    if (value === node) throw new TypeError(`${method}() cannot place a node ${name} itself`);
  }
};

// What mark()/unmark() take over a range: a field name, a visible range
// start ≤ end, a style name and an expand rule.
const markArgs = (method, key, start, end, name, expand) => {
  fieldName(method, key);
  if (!Number.isInteger(start) || start < 0 || !Number.isInteger(end) || end < start) {
    throw new TypeError(`${method}() takes a range: 0 <= start <= end`);
  }
  if (typeof name !== 'string' || name.length === 0) throw new TypeError(`${method}() takes a style name`);
  if (!EXPANDS.includes(expand)) throw new TypeError(`${method}() takes expand: before, after, both or none`);
};

// What add()/remove() take: a field name and a non-empty array of JSON
// values — an element JSON cannot carry has no text to be told apart by.
const setElements = (method, key, elements) => {
  fieldName(method, key);
  if (!Array.isArray(elements) || elements.length === 0) {
    throw new TypeError(`${method}() takes a non-empty array of elements`);
  }
  for (const element of elements) {
    if (!isJsonValue(element)) throw new TypeError(`${method}() takes JSON values; got ${typeof element}`);
  }
  return elements;
};

module.exports = {
  EMBED,
  isNodeId,
  isJsonValue,
  jsonValue,
  fieldName,
  fieldNames,
  spliceArgs,
  treeArgs,
  markArgs,
  setElements,
};
