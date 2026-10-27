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
//                    field's text the delta was made over, and `revision`,
//                    what the last answer handed back for it — a field
//                    still there is not compared at all. A delta the
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
// indices. For an adapter: `createFit` (what its document differs from the
// field by), `undoSteps` (its undo commands), `failureReporter`.
// Requires the text plugin's Myers diff, the vector keys and src/delta.js only.
// The delta algebra is src/delta.js's (quill-delta's rules, BSD-3-Clause;
// THIRD_PARTY_NOTICES.md); what is exported here checks what it is handed.

const { diff: myers } = require('../text/myers.js');
const { opKey } = require('../vector.js');
const D = require('../delta.js');
const { push, chop } = D;

// Two values alike as JSON (a marker, an attribute's value).
const same = (a, b) => a === b || JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

const EMBED = '￼';
// A send that fails other than STALE reloads the editor, later each time;
// this many in a row and the binding stops (`onError` hears why).
const MAX_FAILURES = 5;

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

const textOf = (spans) => {
  if (spans === null) return '';
  let text = '';
  for (let i = 0; i < spans.length; i++) text += spans[i].type === 'text' ? spans[i].text : EMBED;
  return text;
};

// Whether every op of a turn is within the vector: the load holds it.
const covered = (event, vector) => {
  const { ops } = event;
  for (let i = 0; i < ops.length; i++) if (!((vector[opKey(ops[i])] ?? 0) >= ops[i].seq)) return false;
  return true;
};

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
  const { source = Symbol('editor'), onError = null, onReset = null, onStop = null } = options;
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
  let failures = 0;
  let scheduled = false;
  // A reload is due (a send failed): nothing goes out until it is done — a
  // send in between would build on the delta the failure dropped.
  let reloading = false;
  // A peer's change came in while the delta in flight was unanswered, and
  // the delta was rebased over it.
  let rebased = false;
  // The shadow's version — moved by every change it takes — and the field's
  // revision when the shadow was at `revisionAt`: sent beside `expect` while
  // the two still match, it spares the storage comparing the text. A peer's
  // change leaves it behind; the next send compares and hands a new one back.
  let version = 0;
  let revision = 0;
  let revisionAt = -1;
  // The shadow's version the event of the delta in flight left it at: the
  // send's answer — the revision after it, a few microtasks behind the
  // event — is kept for it while nothing moved the shadow since, and the
  // next send waits for that answer (`holding`) so it can go with it.
  let answered = -1;
  let holding = false;
  const waiting = [];

  const idle = () => inflight === null && pending.length === 0 && !stale && !reloading;
  const settle = () => {
    if (!idle()) return;
    for (const resolve of waiting.splice(0)) resolve();
  };
  const fail = (error) => {
    if (onError !== null) onError(error);
    else storage.logger?.warn?.({ event: 'editor.binding', id, field: path, err: error });
  };

  const send = () => {
    if (stopped || !loaded || inflight !== null || holding || stale || reloading || pending.length === 0) return;
    const mine = ++flight;
    const since = epoch;
    inflight = pending;
    pending = [];
    rebased = false;
    const known = revisionAt === version ? revision : undefined;
    const sentAt = version;
    storage.applyDelta(id, path, inflight, { source, expect: shadow, revision: known }).then(
      (result) => {
        if (mine !== flight) return;
        if (holding) {
          // Its event is in: the shadow is the field after the delta, unless
          // a peer's change moved it since.
          holding = false;
          if (answered === version) {
            revision = result.revision;
            revisionAt = version;
          }
          send();
          return;
        }
        // No op made (a mark already there): no event comes to free the slot,
        // and the field is where the shadow is.
        if (inflight === null || result.ops !== 0) return;
        if (sentAt === version) {
          revision = result.revision;
          revisionAt = version;
        }
        inflight = null;
        settle();
        send();
      },
      (error) => {
        if (mine !== flight) return;
        if (holding) {
          holding = false;
          return void send();
        }
        if (inflight === null) return;
        if (error && error.code === 'STALE') {
          // A peer's delta reached the field first. Its event rebases
          // `inflight`; once it is here (it may be already), send again.
          if (epoch !== since) return void resend();
          stale = true;
          // Every landing announced and still no event: the shadow is not
          // the field's. Reload rather than wait for an event that will not come.
          void Promise.resolve(storage.flush?.()).then(() => {
            if (stale && mine === flight && epoch === since && !stopped) broken(error);
          });
          return;
        }
        broken(error);
      },
    );
  };
  // A send that failed: reload — after a pause that grows, so a failure that
  // repeats never holds the event loop — and stop after MAX_FAILURES in a row.
  const broken = (error) => {
    inflight = null;
    holding = false;
    stale = false;
    failures++;
    fail(error);
    if (failures >= MAX_FAILURES) return void halt(error);
    reloading = true;
    const mine = ++flight;
    setTimeout(
      () => {
        if (mine === flight && !stopped) void reload();
      },
      2 ** failures * 10,
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
    const {
      spans,
      vector,
      revision: read,
    } = await storage.transact(async (tx) => ({
      spans: await tx.spans(id, path),
      revision: await tx.revision(id, path),
      vector: { ...storage.vector },
    }));
    if (stopped) return;
    shadow = textOf(spans);
    version++;
    revision = read;
    revisionAt = version;
    // What was typed into the editor while the field was read is over the
    // contents the field replaces: it goes with them, never sent over these.
    pending = [];
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
    holding = false;
    pending = [];
    stale = false;
    reloading = false;
    try {
      await load();
    } catch (error) {
      // The editor would not take the field (setContents threw), or the
      // field would not read: a failure like a send's — another try after a
      // pause, and a stop after MAX_FAILURES in a row.
      return void broken(error);
    }
    if (onReset !== null) onReset();
    settle();
  };

  const handle = (changes, event) => {
    const delta = storage.toDelta(changes, path);
    if (delta === null) return void reload();
    const before = shadow;
    shadow = applyToText(shadow, delta);
    version++;
    if (event.source === source) {
      // `expect` compares text: a peer's change made of the characters it
      // replaced — a letter cut and typed again — passes it, and the delta
      // lands by index over the new ones, not as it was rebased over the
      // peer's. What landed says so; the editor is read again.
      if (rebased && inflight !== null && applyToText(before, inflight) !== shadow) return void reload();
      failures = 0;
      answered = version;
      holding = true;
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
      rebased = true;
    }
    if (pending.length > 0) {
      const next = transform(pending, remote, false);
      pending = transform(remote, pending, true);
      remote = next;
    }
    if (remote.length > 0) {
      try {
        adapter.updateContents(remote);
      } catch (error) {
        // The editor did not take the peer's change: the shadow did, so the
        // two part ways — the editor is loaded from the field again.
        fail(error);
        return void reload();
      }
    }
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
  // Stopped — by `stop()`, or after MAX_FAILURES in a row (`reason` the last
  // failure): nothing more is sent or taken, and `flush()` answers at once.
  const halt = (reason = null) => {
    if (stopped) return;
    stopped = true;
    stopObserve();
    unsubscribe();
    for (const resolve of waiting.splice(0)) resolve();
    if (onStop !== null) {
      try {
        onStop(reason);
      } catch (error) {
        storage.logger?.warn?.({ event: 'listener.error', name: 'editor', err: error });
      }
    }
  };
  // A first load that fails stops the binding: nothing would ever be taken
  // from the editor, and the field's events would only pile up.
  const ready = load().catch((error) => {
    fail(error);
    halt(error);
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
      return !stopped && !idle();
    },
    /** Whether the binding stopped — `stop()`, or failures in a row; what was not sent stays unsent. */
    get stopped() {
      return stopped;
    },
    flush: () =>
      new Promise((resolve) => {
        if (stopped || idle()) resolve();
        else waiting.push(resolve);
      }),
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
