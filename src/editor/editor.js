'use strict';

// The editor-agnostic binding (@alexify/syncom/editor): what every editor
// adapter builds on. An editor holds its own document; syncom holds the
// field. The binding keeps the two the same through deltas — Quill's form,
// `[{ retain, attributes? }, { insert, attributes? }, { delete }]`, an embed
// slot as `{ insert: { embed: marker } }`:
//
//   editor → field   the adapter reports a local edit as a delta; the
//                    binding composes it into `pending` and sends one delta
//                    at a time through `applyDelta` with `expect`, the
//                    field's text the delta was made over. A delta the
//                    field moved under — a peer's edit landed first — is
//                    refused as STALE before any op; the binding rebases it
//                    over the peer's delta as that reaches the editor, and
//                    sends it again.
//   field → editor   `observe(id, path)` hands the field's changes a turn
//                    at a time, `toDelta` composes them into one delta over
//                    the field as it read before (the shadow). The delta of
//                    the binding's own commit moves the shadow on and frees
//                    the next send; a peer's is rebased over what the editor
//                    holds beyond the shadow (`inflight`, then `pending`)
//                    and handed to the adapter, which applies it without
//                    reporting it back.
//
// The shadow is the field's text as the storage reads it (U+FFFC for an
// embed slot) after every change the binding has processed; the editor
// holds shadow ∘ inflight ∘ pending. A rebase is the operational transform
// of two deltas from one base (`transform`): applying both ends the same
// whichever came first, with the peer's insert first at a tie — the order
// the storage holds them in. A change no delta can say (a reset, an unset,
// the record gone) reloads the editor from the field and drops what was
// not sent (`onReset`). The load reads the field and the vector in one
// turn of the queue; an event of ops the vector covers is in the load.
//
// The rest is pure: `diffSpans`/`diffBlocks`, the delta between two
// readings of a text — markers and marks included — for an editor that
// hands over a whole document; `spansToBlocks`/`blocksToSpans` and
// `spansToDelta`/`deltaToSpans`; selections as cursor tokens that survive
// the edits around them, and a presence room's cursors resolved to
// indices. Requires the text plugin's Myers diff and the vector keys only.

const { diff: myers } = require('../text/myers.js');
const { opKey } = require('../vector.js');

const EMBED = '￼';

// ---------------------------------------------------------------------------
// Deltas

const lengthOf = (op) => op.delete ?? op.retain ?? (typeof op.insert === 'string' ? op.insert.length : 1);
const typeOf = (op) =>
  op === undefined ? 'retain' : op.delete !== undefined ? 'delete' : op.retain !== undefined ? 'retain' : 'insert';
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

const isOp = (op) =>
  op !== null &&
  typeof op === 'object' &&
  ((Number.isInteger(op.retain) && op.retain > 0) ||
    (Number.isInteger(op.delete) && op.delete > 0) ||
    typeof op.insert === 'string' ||
    (op.insert !== null && typeof op.insert === 'object' && Object.hasOwn(op.insert, 'embed')));
const checkDelta = (name, delta) => {
  if (!Array.isArray(delta) || !delta.every(isOp)) throw new TypeError(`${name}() takes a delta`);
};

// Hands a delta out in pieces: `next(n)` is the next op cut to `n` units,
// `{ retain: Infinity }` once the delta is spent.
const iterate = (ops) => {
  let i = 0;
  let offset = 0;
  const peekLength = () => (i < ops.length ? lengthOf(ops[i]) - offset : Infinity);
  const next = (length = Infinity) => {
    const op = ops[i];
    if (op === undefined) return { retain: Infinity };
    const left = lengthOf(op) - offset;
    const take = Math.min(length, left);
    const start = offset;
    if (take === left) {
      i++;
      offset = 0;
    } else offset += take;
    if (op.delete !== undefined) return { delete: take };
    const out = {};
    if (op.retain !== undefined) out.retain = take;
    else if (typeof op.insert === 'string') out.insert = op.insert.slice(start, start + take);
    else out.insert = op.insert;
    if (op.attributes !== undefined) out.attributes = op.attributes;
    return out;
  };
  return { hasNext: () => i < ops.length, peekLength, peekType: () => typeOf(ops[i]), next };
};

// Appends an op, merged into the last when the two are one piece.
const push = (ops, op) => {
  if (op.retain === Infinity || lengthOf(op) === 0) return ops;
  const last = ops[ops.length - 1];
  if (last !== undefined && same(last.attributes, op.attributes)) {
    if (last.delete !== undefined && op.delete !== undefined) {
      last.delete += op.delete;
      return ops;
    }
    if (last.retain !== undefined && op.retain !== undefined) {
      last.retain += op.retain;
      return ops;
    }
    if (typeof last.insert === 'string' && typeof op.insert === 'string') {
      last.insert += op.insert;
      return ops;
    }
  }
  ops.push({ ...op });
  return ops;
};

// A trailing retain of no attributes says nothing.
const chop = (ops) => {
  const last = ops[ops.length - 1];
  if (last !== undefined && last.retain !== undefined && last.attributes === undefined) ops.pop();
  return ops;
};

const composeAttributes = (a, b, keepNull) => {
  const out = { ...(b ?? {}) };
  if (a !== undefined) for (const key of Object.keys(a)) if (out[key] === undefined) out[key] = a[key];
  if (!keepNull) for (const key of Object.keys(out)) if (out[key] === null) delete out[key];
  return Object.keys(out).length > 0 ? out : undefined;
};

/** The delta that does `a` then `b`, as one; a document (inserts alone) composed with a delta is the document after it. */
const compose = (a, b) => {
  checkDelta('compose', a);
  checkDelta('compose', b);
  const ia = iterate(a);
  const ib = iterate(b);
  const ops = [];
  while (ia.hasNext() || ib.hasNext()) {
    if (ib.peekType() === 'insert') {
      push(ops, ib.next());
    } else if (ia.peekType() === 'delete') {
      push(ops, ia.next());
    } else {
      const length = Math.min(ia.peekLength(), ib.peekLength());
      const aOp = ia.next(length);
      const bOp = ib.next(length);
      if (bOp.retain !== undefined) {
        const op = aOp.retain !== undefined ? { retain: length } : { insert: aOp.insert };
        let bAttributes = bOp.attributes;
        // A marker changed (`attributes.embed` over a slot) replaces the
        // document's embed rather than styling it.
        if (bAttributes !== undefined && bAttributes.embed !== undefined && typeof aOp.insert === 'object') {
          op.insert = { embed: bAttributes.embed };
          const { embed, ...rest } = bAttributes;
          bAttributes = Object.keys(rest).length > 0 ? rest : undefined;
        }
        const attributes = composeAttributes(aOp.attributes, bAttributes, aOp.retain !== undefined);
        if (attributes !== undefined) op.attributes = attributes;
        push(ops, op);
      } else if (bOp.delete !== undefined && aOp.retain !== undefined) {
        push(ops, bOp);
      }
    }
  }
  return chop(ops);
};

const transformAttributes = (a, b, priority) => {
  if (a === undefined || b === undefined || !priority) return b;
  const out = {};
  for (const key of Object.keys(b)) if (a[key] === undefined) out[key] = b[key];
  return Object.keys(out).length > 0 ? out : undefined;
};

/**
 * `b` rewritten to apply after `a`, the two made over one base: `a ∘
 * transform(a, b)` reads as `b ∘ transform(b, a, !priority)`. With
 * `priority`, `a`'s insert comes first where both insert at one index.
 */
const transform = (a, b, priority = false) => {
  checkDelta('transform', a);
  checkDelta('transform', b);
  const ia = iterate(a);
  const ib = iterate(b);
  const ops = [];
  while (ia.hasNext() || ib.hasNext()) {
    if (ia.peekType() === 'insert' && (priority || ib.peekType() !== 'insert')) {
      push(ops, { retain: lengthOf(ia.next()) });
    } else if (ib.peekType() === 'insert') {
      push(ops, ib.next());
    } else {
      const length = Math.min(ia.peekLength(), ib.peekLength());
      const aOp = ia.next(length);
      const bOp = ib.next(length);
      if (aOp.delete !== undefined) continue;
      if (bOp.delete !== undefined) {
        push(ops, bOp);
      } else {
        const op = { retain: length };
        const attributes = transformAttributes(aOp.attributes, bOp.attributes, priority);
        if (attributes !== undefined) op.attributes = attributes;
        push(ops, op);
      }
    }
  }
  return chop(ops);
};

/** Where `index` is once `delta` has applied; with `priority`, an insert at the index itself stays behind it. */
const transformIndex = (index, delta, priority = false) => {
  if (!Number.isInteger(index) || index < 0) throw new TypeError('transformIndex() takes a non-negative integer index');
  checkDelta('transformIndex', delta);
  const it = iterate(delta);
  let offset = 0;
  let at = index;
  while (it.hasNext() && offset <= at) {
    const length = it.peekLength();
    const type = it.peekType();
    it.next();
    if (type === 'delete') {
      at -= Math.min(length, at - offset);
      continue;
    }
    if (type === 'insert' && (offset < at || !priority)) at += length;
    offset += length;
  }
  return at;
};

/** `text` once `delta` has applied, an embed slot as U+FFFC. */
const applyToText = (text, delta) => {
  if (typeof text !== 'string') throw new TypeError('applyToText() takes a string');
  checkDelta('applyToText', delta);
  let at = 0;
  let out = text;
  for (const op of delta) {
    if (op.delete !== undefined) {
      out = out.slice(0, at) + out.slice(at + op.delete);
    } else if (op.retain !== undefined) {
      at += op.retain;
    } else {
      const inserted = typeof op.insert === 'string' ? op.insert : EMBED;
      out = out.slice(0, at) + inserted + out.slice(at);
      at += inserted.length;
    }
  }
  return out;
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
    spans.push(...block.spans);
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
  const hunks = myers(a.text, b.text).sort((x, y) => x[0] - y[0]);
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
  for (const [index, count, text] of hunks) {
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
    const selection = await tokensToSelection(storage, tokens);
    if (selection !== null) out.push({ node, state, ...selection });
  }
  return out;
};

// ---------------------------------------------------------------------------
// The binding

const textOf = (spans) =>
  spans === null ? '' : spans.map((span) => (span.type === 'text' ? span.text : EMBED)).join('');

// Whether every op of a turn is within the vector: the load holds it.
const covered = (event, vector) => event.ops.every((op) => (vector[opKey(op)] ?? 0) >= op.seq);

/**
 * Binds an editor, through `adapter`, to text field `path` of record `id`:
 * the editor's edits reach the field as one transaction each, the field's
 * changes reach the editor as deltas. `source` tells the binding's commits
 * apart in events; `onReset` hears a reload (a reset, the record gone: what
 * was not sent is dropped), `onError` a failure that reloaded it.
 */
const createTextBinding = (storage, id, path, adapter, options = {}) => {
  if (!storage || typeof storage.observe !== 'function' || typeof storage.applyDelta !== 'function') {
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
  const { source = Symbol('editor'), onError = null, onReset = null } = options;
  let shadow = '';
  let inflight = null;
  let pending = [];
  let loaded = false;
  let buffered = [];
  let stopped = false;
  let stale = false;
  let epoch = 0;
  // The number of the delta in flight: a remote event rebases `inflight`
  // into a new array, so the send's callbacks know their delta by this.
  let flight = 0;
  let scheduled = false;
  const waiting = [];

  const idle = () => inflight === null && pending.length === 0 && !stale;
  const settle = () => {
    if (!idle()) return;
    for (const resolve of waiting.splice(0)) resolve();
  };
  const fail = (error) => {
    if (onError !== null) onError(error);
    else storage.logger?.warn?.({ event: 'editor.binding', id, field: path, err: error });
  };

  const send = () => {
    if (stopped || !loaded || inflight !== null || stale || pending.length === 0) return;
    const mine = ++flight;
    const since = epoch;
    inflight = pending;
    pending = [];
    storage.applyDelta(id, path, inflight, { source, expect: shadow }).then(
      (count) => {
        // No op made (a mark already there): no event comes to free the slot.
        if (mine !== flight || inflight === null || count !== 0) return;
        inflight = null;
        settle();
        send();
      },
      (error) => {
        if (mine !== flight || inflight === null) return;
        if (error && error.code === 'STALE') {
          // A peer's delta reached the field first. Its event rebases
          // `inflight`; once it is here (it may be already), send again.
          if (epoch !== since) resend();
          else stale = true;
          return;
        }
        inflight = null;
        fail(error);
        void reload();
      },
    );
  };
  const resend = () => {
    stale = false;
    pending = compose(inflight, pending);
    inflight = null;
    send();
  };
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      send();
    });
  };

  const load = async () => {
    const { spans, vector } = await storage.transact(async (tx) => ({
      spans: await tx.spans(id, path),
      vector: { ...storage.vector },
    }));
    if (stopped) return;
    shadow = textOf(spans);
    adapter.setContents(spansToDelta(spans ?? []));
    loaded = true;
    const events = buffered;
    buffered = [];
    for (const [changes, event] of events) if (!covered(event, vector)) handle(changes, event);
    send();
  };
  const reload = async () => {
    loaded = false;
    flight++;
    inflight = null;
    pending = [];
    stale = false;
    try {
      await load();
    } catch (error) {
      fail(error);
    }
    if (onReset !== null) onReset();
    settle();
  };

  const handle = (changes, event) => {
    const delta = storage.toDelta(changes, path);
    if (delta === null) return void reload();
    shadow = applyToText(shadow, delta);
    if (event.source === source) {
      inflight = null;
      settle();
      send();
      return;
    }
    epoch++;
    let remote = delta;
    if (inflight !== null) {
      const next = transform(inflight, remote, false);
      inflight = transform(remote, inflight, true);
      remote = next;
    }
    if (pending.length > 0) {
      const next = transform(pending, remote, false);
      pending = transform(remote, pending, true);
      remote = next;
    }
    if (remote.length > 0) adapter.updateContents(remote);
    if (stale) resend();
  };

  const stopObserve = storage.observe(id, path, (changes, event) => {
    if (stopped) return;
    if (loaded) handle(changes, event);
    else buffered.push([changes, event]);
  });
  const unsubscribe = adapter.onChange((delta) => {
    if (stopped) return;
    checkDelta('onChange', delta);
    pending = compose(pending, delta);
    if (pending.length > 0) schedule();
  });
  const ready = load().catch((error) => {
    fail(error);
    throw error;
  });

  return Object.freeze({
    id,
    field: path,
    source,
    ready,
    get shadow() {
      return shadow;
    },
    get pending() {
      return !idle();
    },
    flush: () =>
      new Promise((resolve) => {
        if (idle()) resolve();
        else waiting.push(resolve);
      }),
    stop: () => {
      stopped = true;
      stopObserve();
      unsubscribe();
      for (const resolve of waiting.splice(0)) resolve();
    },
  });
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
};
