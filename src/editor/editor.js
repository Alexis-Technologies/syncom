'use strict';

// The editor-agnostic binding (@alexify/syncom/editor): what every editor
// adapter builds on. An editor holds its own document; syncom holds the
// field. The binding keeps the two the same through deltas — Quill's form,
// `[{ retain, attributes? }, { insert, attributes? }, { delete }]`, an embed
// slot as `{ insert: { embed: marker } }` — over the text plugin's handle on
// the field (`storage.openText`, src/text/handle.js), whose reading is what
// the editor shows:
//
//   editor → field   the adapter reports a local edit as a delta; the
//                    binding applies it to the handle at once — resolved
//                    and stamped over the handle's reading, which is the
//                    editor's, so nothing is ever STALE — and the handle
//                    logs the edits a window later as one transaction,
//                    keystrokes that continue each other as one op.
//   field → editor   every other writer's change reaches the handle once, as
//                    a delta in the handle's indices — the editor's — and
//                    the binding hands it to the adapter, which applies it
//                    without reporting it back.
//
// A change no delta can say (a reset, an unset, the record gone) and a flush
// that could not be logged (UNLOGGED: what was not logged is dropped) reload
// the editor from the handle's reading (`onReset`); an editor that throws on
// a change, or a delta the handle refuses, the same. Failures in a row stop
// the binding at MAX_FAILURES.
//
// The rest is pure: `diffSpans`/`diffBlocks`, the delta between two
// readings of a text — markers and marks included — for an editor that
// hands over a whole document; `spansToBlocks`/`blocksToSpans` and
// `spansToDelta`/`deltaToSpans`; selections as cursor tokens that survive
// the edits around them, and a presence room's cursors resolved to
// indices. For an adapter: `createFit` (what its document differs from the
// field by), `undoSteps` (its undo commands), `failureReporter`.
// Requires the text plugin's Myers diff and src/text/quill.js only.
// The delta algebra is src/text/quill.js's (quill-delta's rules, BSD-3-Clause;
// THIRD_PARTY_NOTICES.md); what is exported here checks what it is handed.

const { diff: myers } = require('../text/myers.js');
const D = require('../text/quill.js');
const { push, chop } = D;

// Two values alike as JSON (a marker, an attribute's value).
const same = (a, b) => a === b || JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

const EMBED = '￼';
// A failure — a flush not logged, an editor or a handle that refused — reloads
// the editor; this many in a row and the binding stops (`onError` hears why).
const MAX_FAILURES = 5;
const NOOP = () => {};

// ---------------------------------------------------------------------------
// Deltas

const isOp = (op) =>
  op !== null &&
  typeof op === 'object' &&
  ((Number.isInteger(op.retain) && op.retain > 0) ||
    (Number.isInteger(op.delete) && op.delete > 0) ||
    typeof op.insert === 'string' ||
    (op.insert !== null && typeof op.insert === 'object' && Object.hasOwn(op.insert, 'embed')));
const checkDelta = (name, delta) => {
  let ok = Array.isArray(delta);
  for (let i = 0; ok && i < delta.length; i++) ok = isOp(delta[i]);
  if (!ok) throw new TypeError(`${name}() takes a delta`);
};

/** The delta that does `a` then `b`, as one; a document (inserts alone) composed with a delta is the document after it. */
const compose = (a, b) => {
  checkDelta('compose', a);
  checkDelta('compose', b);
  return D.compose(a, b);
};

/**
 * `b` rewritten to apply after `a`, the two made over one base: `a ∘
 * transform(a, b)` reads as `b ∘ transform(b, a, !priority)`. With
 * `priority`, `a`'s insert comes first where both insert at one index.
 */
const transform = (a, b, priority = false) => {
  checkDelta('transform', a);
  checkDelta('transform', b);
  return D.transform(a, b, priority);
};

/** Where `index` is once `delta` has applied; with `priority`, an insert at the index itself stays behind it. */
const transformIndex = (index, delta, priority = false) => {
  if (!Number.isInteger(index) || index < 0) throw new TypeError('transformIndex() takes a non-negative integer index');
  checkDelta('transformIndex', delta);
  return D.transformIndex(index, delta, priority);
};

/** `text` once `delta` has applied, an embed slot as U+FFFC. */
const applyToText = (text, delta) => {
  if (typeof text !== 'string') throw new TypeError('applyToText() takes a string');
  checkDelta('applyToText', delta);
  // One pass: `at` is where the delta stands in `text`, `out` what it made before there.
  let at = 0;
  let out = '';
  for (const op of delta) {
    if (op.delete !== undefined) {
      at += op.delete;
    } else if (op.retain !== undefined) {
      out += text.slice(at, at + op.retain);
      at += op.retain;
    } else {
      out += typeof op.insert === 'string' ? op.insert : EMBED;
    }
  }
  return out + text.slice(at);
};

// ---------------------------------------------------------------------------
// Spans and blocks

const marksOf = (span) => (span.marks !== undefined && Object.keys(span.marks).length > 0 ? span.marks : undefined);

/** A reading's typed spans as a document delta: text with its marks as attributes, a slot as `{ insert: { embed } }`. */
const spansToDelta = (spans) => {
  if (!Array.isArray(spans)) throw new TypeError('spansToDelta() takes spans');
  const ops = [];
  for (const span of spans) {
    const op = span.type === 'text' ? { insert: span.text } : { insert: { embed: span.value } };
    const attributes = span.type === 'block' ? undefined : marksOf(span);
    if (attributes !== undefined) op.attributes = attributes;
    push(ops, op);
  }
  return ops;
};

/** A document delta (inserts alone) as typed spans. */
const deltaToSpans = (ops) => {
  checkDelta('deltaToSpans', ops);
  const spans = [];
  for (const op of ops) {
    if (op.insert === undefined) throw new TypeError('deltaToSpans() takes a document: inserts alone');
    const marks = op.attributes ?? {};
    if (typeof op.insert === 'string') spans.push({ type: 'text', text: op.insert, marks });
    else if (op.insert.embed !== null && op.insert.embed.isEmbed === false) {
      spans.push({ type: 'block', value: op.insert.embed });
    } else spans.push({ type: 'embed', value: op.insert.embed, marks });
  }
  return spans;
};

/** Typed spans cut at the block markers: `{ index, type, parents, attrs, spans }` per block, a leading block of type `null` for text before the first marker. */
const spansToBlocks = (spans) => {
  if (!Array.isArray(spans)) throw new TypeError('spansToBlocks() takes spans');
  const blocks = [];
  let block = null;
  let index = 0;
  for (const span of spans) {
    if (span.type === 'block') {
      const { type, parents, attrs } = span.value;
      block = { index, type, parents: [...parents], attrs: { ...attrs }, spans: [] };
      blocks.push(block);
      index += 1;
      continue;
    }
    if (block === null) {
      block = { index: null, type: null, parents: [], attrs: {}, spans: [] };
      blocks.push(block);
    }
    block.spans.push(span);
    index += span.type === 'text' ? span.text.length : 1;
  }
  return blocks;
};

/** Blocks back to typed spans: a marker per block of a type, then its spans. */
const blocksToSpans = (blocks) => {
  if (!Array.isArray(blocks)) throw new TypeError('blocksToSpans() takes blocks');
  const spans = [];
  for (const block of blocks) {
    if (block.type !== null) {
      const value = {
        type: block.type,
        parents: [...(block.parents ?? [])],
        attrs: { ...(block.attrs ?? {}) },
        isEmbed: false,
      };
      spans.push({ type: 'block', value });
    }
    for (let i = 0; i < block.spans.length; i++) spans.push(block.spans[i]);
  }
  return spans;
};

// A reading flattened: its text, and per unit the marks and the marker.
const flatten = (spans) => {
  let text = '';
  const attrs = [];
  const markers = [];
  for (const span of spans) {
    if (span.type === 'text') {
      text += span.text;
      const marks = marksOf(span);
      for (let i = 0; i < span.text.length; i++) {
        attrs.push(marks);
        markers.push(undefined);
      }
    } else {
      text += EMBED;
      attrs.push(span.type === 'embed' ? marksOf(span) : undefined);
      markers.push(span.value);
    }
  }
  return { text, attrs, markers };
};

// The attributes that take `a`'s marks to `b`'s: a value changed or added, null for one gone.
const attributesBetween = (a, b) => {
  const out = {};
  if (b !== undefined) for (const key of Object.keys(b)) if (!same(a?.[key], b[key])) out[key] = b[key];
  if (a !== undefined) for (const key of Object.keys(a)) if (b === undefined || b[key] === undefined) out[key] = null;
  return Object.keys(out).length > 0 ? out : undefined;
};

/**
 * The delta that takes the reading `before` to the reading `after`: the
 * text's difference (Myers) as cuts and inserts, a slot's marker changed as
 * `{ retain: 1, attributes: { embed } }`, the marks changed over what
 * stays as attributes.
 */
const diffSpans = (before, after) => {
  if (!Array.isArray(before) || !Array.isArray(after)) throw new TypeError('diffSpans() takes two readings');
  const a = flatten(before);
  const b = flatten(after);
  // Myers hands its hunks back last first: read from the end, they come in order.
  const hunks = myers(a.text, b.text);
  const ops = [];
  let ai = 0;
  let bi = 0;
  const retain = (count) => {
    for (let i = 0; i < count; i++) {
      const attributes = attributesBetween(a.attrs[ai + i], b.attrs[bi + i]);
      const marker = a.markers[ai + i];
      const changed = marker !== undefined && !same(marker, b.markers[bi + i]);
      const op = { retain: 1 };
      if (attributes !== undefined || changed) {
        op.attributes = { ...(attributes ?? {}), ...(changed ? { embed: b.markers[bi + i] } : {}) };
      }
      push(ops, op);
    }
    ai += count;
    bi += count;
  };
  for (let h = hunks.length - 1; h >= 0; h--) {
    const [index, count, text] = hunks[h];
    retain(index - ai);
    if (count > 0) {
      push(ops, { delete: count });
      ai += count;
    }
    for (let j = 0; j < text.length; j++) {
      const at = bi + j;
      const op = b.text[at] === EMBED ? { insert: { embed: b.markers[at] ?? null } } : { insert: b.text[at] };
      if (b.attrs[at] !== undefined) op.attributes = b.attrs[at];
      push(ops, op);
    }
    bi += text.length;
  }
  retain(a.text.length - ai);
  return chop(ops);
};

/** `diffSpans` over two block lists (what `blocks()` reads, or `spansToBlocks` makes). */
const diffBlocks = (before, after) => diffSpans(blocksToSpans(before), blocksToSpans(after));

// ---------------------------------------------------------------------------
// Selections and presence

const checkStorage = (name, storage) => {
  if (!storage || typeof storage.cursor !== 'function' || typeof storage.positions !== 'function') {
    throw new TypeError(`${name}() takes a storage with the text plugin`);
  }
};

/** A selection as cursor tokens that survive the edits around them: `{ id, field, anchor, head }`, or null for a field not there. */
const selectionToTokens = async (storage, id, path, selection) => {
  checkStorage('selectionToTokens', storage);
  if (!selection || !Number.isInteger(selection.anchor)) {
    throw new TypeError('selectionToTokens() takes { anchor, head? }');
  }
  const { anchor, head = anchor } = selection;
  const a = await storage.cursor(id, path, anchor);
  if (a === null) return null;
  const h = head === anchor ? a : await storage.cursor(id, path, head);
  return h === null ? null : { id, field: path, anchor: a, head: h };
};

/** The indices the tokens stand at now, or null once either place is gone. */
const tokensToSelection = async (storage, tokens) => {
  checkStorage('tokensToSelection', storage);
  if (!tokens || typeof tokens.anchor !== 'string') {
    throw new TypeError('tokensToSelection() takes { id, field, anchor, head }');
  }
  const head = tokens.head ?? tokens.anchor;
  const [a, h] = await storage.positions(tokens.id, tokens.field, [tokens.anchor, head]);
  return a === null || h === null ? null : { anchor: a.index, head: h.index };
};

/** The cursors a presence room holds on `path` of `id` — each state's `key` (`cursor`) as tokens — resolved to indices now. */
const presenceCursors = async (presence, storage, id, path, { key = 'cursor' } = {}) => {
  if (!presence || typeof presence.states !== 'function') throw new TypeError('presenceCursors() takes a presence');
  const out = [];
  for (const [node, state] of presence.states()) {
    const tokens = state?.[key];
    if (!tokens || tokens.id !== id || tokens.field !== path || typeof tokens.anchor !== 'string') continue;
    if (tokens.head !== undefined && typeof tokens.head !== 'string') continue;
    // A peer's state is the peer's word: a token this field cannot read is
    // that peer's cursor left out, never every cursor of the room.
    let selection = null;
    try {
      selection = await tokensToSelection(storage, tokens);
    } catch {
      continue;
    }
    if (selection !== null) out.push({ node, state, ...selection });
  }
  return out;
};

// ---------------------------------------------------------------------------
// The binding

/**
 * Binds an editor, through `adapter`, to text field `path` of record `id`,
 * over the text plugin's handle on it: the editor's edits are made at once
 * and logged a window later (`window`, the storage's `defer` by default) as
 * one transaction; every other writer's change reaches the editor as a
 * delta in its indices. `source` tells the binding's commits apart in
 * events; `onReset` hears a reload (a reset, the record gone, a flush not
 * logged: what was not logged is dropped), `onError` a failure, `onStop`
 * the stop.
 */
const createTextBinding = (storage, id, path, adapter, options = {}) => {
  if (!storage || typeof storage.openText !== 'function') {
    throw new TypeError('createTextBinding() takes a storage with the text plugin');
  }
  if (typeof id !== 'string' || typeof path !== 'string') {
    throw new TypeError('createTextBinding() takes an id and a field');
  }
  if (
    !adapter ||
    typeof adapter.setContents !== 'function' ||
    typeof adapter.updateContents !== 'function' ||
    typeof adapter.onChange !== 'function'
  ) {
    throw new TypeError('createTextBinding() takes an adapter: setContents, updateContents, onChange');
  }
  const { source = Symbol('editor'), window, onError = null, onReset = null, onStop = null } = options;
  let handle = null;
  let stopped = false;
  let failures = 0;
  let stopObserve = NOOP;
  const fail = (error) => {
    if (onError !== null) onError(error);
    else storage.logger?.warn?.({ event: 'editor.binding', id, field: path, err: error });
  };
  // A failure in a row more: the editor read again from the handle, or the binding stopped.
  const broken = (error) => {
    failures++;
    fail(error);
    if (failures >= MAX_FAILURES) return void halt(error);
    reload();
  };
  const reload = () => {
    try {
      adapter.setContents(spansToDelta(handle.spans()));
    } catch (error) {
      // The editor would not take the field: a failure like any other.
      return void broken(error);
    }
    if (onReset !== null) onReset();
  };
  // Every change the handle hears but the editor's own: a delta in the
  // editor's indices, or a reset — the field read again.
  const heard = (delta, event) => {
    if (stopped || event.local) return;
    if (event.reset === true) return void reload();
    try {
      adapter.updateContents(delta);
    } catch (error) {
      // The editor did not take the change: it is loaded from the handle again.
      broken(error);
    }
  };
  const unsubscribe = adapter.onChange((delta) => {
    // Typed before the field was read: over contents the load replaces.
    if (stopped || handle === null) return;
    checkDelta('onChange', delta);
    try {
      handle.applyDelta(delta);
    } catch (error) {
      // The handle refused what the editor shows: the two part ways — read again.
      return void broken(error);
    }
    // After a failure, the next flush that is logged ends the run of them.
    if (failures > 0) handle.flushed.then(() => void (failures = 0), NOOP);
  });
  // Stopped — by `stop()`, or after MAX_FAILURES in a row (`reason` the last
  // failure): nothing more is taken; what the editor typed is logged as the
  // handle closes.
  const halt = (reason = null) => {
    if (stopped) return;
    stopped = true;
    stopObserve();
    unsubscribe();
    if (handle !== null) void handle.close().catch(NOOP);
    if (onStop !== null) {
      try {
        onStop(reason);
      } catch (error) {
        storage.logger?.warn?.({ event: 'listener.error', name: 'editor', err: error });
      }
    }
  };
  // A first load that fails stops the binding: nothing would ever be taken from the editor.
  const ready = (async () => {
    const opened = await storage.openText(id, path, { source, window });
    if (stopped) return void (await opened.close().catch(NOOP));
    handle = opened;
    stopObserve = handle.observe(heard);
    // A flush not logged: the handle reads the field as announced and tells a reset (`heard`).
    handle.on('error', (error) => {
      // A stopped binding hears nothing more — the close's own flush included.
      if (stopped) return;
      failures++;
      fail(error);
      if (failures >= MAX_FAILURES) halt(error);
    });
    adapter.setContents(spansToDelta(handle.spans()));
  })().catch((error) => {
    fail(error);
    halt(error);
    throw error;
  });

  return Object.freeze({
    id,
    field: path,
    source,
    ready,
    /** The field as the editor holds it: the handle's reading. */
    get shadow() {
      return handle === null ? '' : handle.toString();
    },
    /** Whether edits wait for the log. */
    get pending() {
      return !stopped && handle !== null && handle.pending;
    },
    /** Whether the binding stopped — `stop()`, or failures in a row. */
    get stopped() {
      return stopped;
    },
    /** Settles once what the editor typed so far is logged (or could not be). */
    flush: () => (stopped || handle === null ? Promise.resolve() : handle.flush().catch(NOOP)),
    stop: () => halt(),
  });
};

// ---------------------------------------------------------------------------
// For adapters

// What an adapter's document differs from the field by, for an editor whose
// schema cannot hold all a field does (ProseMirror) or that reads its text
// otherwise (CodeMirror's line breaks). `unfit` is the delta from the field
// as the binding sees it (`base`) to the document: held — never sent for
// itself, so a peer's change is never answered with an edit — and composed
// in front of the editor's next edit (`send`). `toDoc`/`toField` map an
// index across it; the way back is `diff(read(), base)`, made when asked.
class Fit {
  #read;
  #diff;
  #back = null;
  unfit = [];
  base = null;

  constructor(read, diff) {
    this.#read = read;
    this.#diff = diff;
  }

  /** The field reads as `base`, the document differs from it by `unfit` (`back` the other way, when known). */
  hold(base, unfit = [], back = null) {
    this.base = base;
    this.unfit = unfit;
    this.#back = unfit.length === 0 ? null : back;
  }

  /** The delta to send for the editor's edit `local`: what the field lacked of the document, then the edit. */
  send(local, base) {
    const delta = this.unfit.length === 0 ? local : compose(this.unfit, local);
    this.hold(base);
    return delta;
  }

  /** A field index as the document's. */
  toDoc(index) {
    return this.unfit.length === 0 ? index : transformIndex(index, this.unfit, true);
  }

  /** A document index as the field's. */
  toField(index) {
    if (this.unfit.length === 0) return index;
    this.#back ??= this.#diff(this.#read(), this.base);
    return transformIndex(index, this.#back, true);
  }
}

/** A fit over the document `read()` reads, `diff(from, to)` the delta between two of its readings. */
const createFit = (read, diff) => {
  if (typeof read !== 'function' || typeof diff !== 'function') throw new TypeError('createFit() takes read and diff');
  return new Fit(read, diff);
};

/**
 * Undo and redo over an undo manager of the storage's (`createUndo()` of
 * @alexify/syncom/undo) for an adapter's commands: `undo(run)`/`redo(run)`
 * answer whether there is a step to take and, when `run`, take it once
 * every edit the binding (`binding()`, null before it is made) sent has
 * landed; a failure goes to `report`.
 */
const undoSteps = (manager, binding, report) => {
  if (!manager || typeof manager.undo !== 'function' || typeof manager.redo !== 'function') {
    throw new TypeError('commands() takes an undo manager: createUndo() from @alexify/syncom/undo');
  }
  const step = (name, can) => (run) => {
    if (!manager[can]) return false;
    if (run) {
      const text = binding();
      const settled = text === null ? Promise.resolve() : text.flush();
      void settled.then(() => manager[name]()).catch(report);
    }
    return true;
  };
  return { undo: step('undo', 'canUndo'), redo: step('redo', 'canRedo') };
};

/** How an adapter reports a failure of its own work (cursors, undo): to `onError`, or a warn `event` on the storage's logger. */
const failureReporter = (storage, id, path) => (event, onError) => (error) => {
  if (typeof onError === 'function') onError(error);
  else storage.logger?.warn?.({ event, id, field: path, err: error });
};

module.exports = {
  EMBED,
  compose,
  transform,
  transformIndex,
  applyToText,
  spansToDelta,
  deltaToSpans,
  spansToBlocks,
  blocksToSpans,
  diffSpans,
  diffBlocks,
  selectionToTokens,
  tokensToSelection,
  presenceCursors,
  createTextBinding,
  createFit,
  undoSteps,
  failureReporter,
};
