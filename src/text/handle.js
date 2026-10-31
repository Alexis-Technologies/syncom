'use strict';

// A synchronous editor's handle on one text field of one record
// (`storage.openText(id, key)`): what an editor types is made at once — an
// op resolved and stamped over the handle's own reading, the OVERLAY: the
// field as the storage announced it (the BASE) with the edits not logged
// yet on top — and read back at once; keystrokes that continue each other
// are one op (the kind's `coalesce`); the edits go to the log as one
// transaction a window later (`flush`, the storage's `defer` by default),
// where they take their stream and seq, the hooks and the validator. Until
// then they are the handle's alone: nothing reaches a file, another write
// path or a peer before it is logged.
//
// The base follows the storage's `transaction` events — every op of the
// record, the handle's own flushed ones included — so the overlay takes a
// peer's op (or another writer's) once, in its own indices, and hands it to
// the observers as a delta. A write through the storage to the field
// resolves its indices against the storage's reading: flush first to write
// by the handle's. A failed flush drops what was not logged: the observers
// are told to read the field again (`reset`), and `flushed` rejects with
// UNLOGGED.

const { Emitter } = require('../emitter.js');
const { SyncomError } = require('../errors.js');
const { spliceArgs, markArgs, jsonValue, fieldName, EMBED } = require('../args.js');
const { isRecordId, invalidId, isPlainObject, asJson, deepEqual } = require('../shape.js');
const { floorOf } = require('../vector.js');
const S = require('./sequence.js');
const { coalesce, prepends, render, blockOf, marksAt, markerArgs, extentKey } = require('./kind.js');
const { toDelta, isDeltaOp } = require('./deltas.js');
const { typedSpans } = require('./methods.js');
const { assignData } = require('../lazy.js');

// What a handle holds at most before it flushes whatever the window says.
const PENDING_MAX = 1024;

const RESOLVED = Promise.resolve();
const NOOP = () => {};
const NONE = Object.freeze([]);

class TextHandle extends Emitter {
  #core;
  #source;
  #actor;
  #window;
  #base;
  #overlay;
  #pending = [];
  // Beside each pending op, what it made: the reading it was applied over
  // (`from`), the one it left, its delta and changes — what the flush hands
  // the transaction, which then applies it again only where its reading of
  // the record is another (src/commit.js commitResolved).
  #made = [];
  #flushing = RESOLVED;
  // Flushes taken and not settled yet: their edits still wait for the log.
  #unsettled = 0;
  // Per flush taken and not heard yet, in order: its ops, the overlay as it
  // was taken (the base and every edit up to it), how many other writers'
  // turns the handle had heard by then, and where it stands — started,
  // logged, or cancelled behind a flush that could not be logged.
  #landings = [];
  #heardTurns = 0;
  #timer = null;
  #waiting = null;
  #observers = new Set();
  #off;
  #closed = false;

  constructor(core, id, field, base, { window, actor, source }) {
    super();
    this.id = id;
    this.field = field;
    this.#core = core;
    this.#source = source;
    this.#actor = actor;
    this.#window = window;
    this.#base = base;
    this.#overlay = base;
    // One listener of the storage's `transaction` events serves every handle (core.editing.follow).
    this.#off = core.editing.follow(id, (event) => this.#heard(event));
    core.editing.handles.add(this);
  }

  /** The field as the handle reads it: the storage's, with every edit made here on top; empty once the record is gone. */
  toString() {
    const entry = this.#overlay;
    if (entry === null || !this.#core.alive(entry) || blockOf(entry, this.field) === undefined) return '';
    const text = entry.data[this.field];
    return typeof text === 'string' ? text : '';
  }

  get length() {
    return this.toString().length;
  }

  slice(start, end) {
    return this.toString().slice(start, end);
  }

  /** The field as runs of equal style, as `storage.spans()` reads it: the handle's reading. */
  spans() {
    const entry = this.#overlay;
    const seq = entry === null || entry.encrypted ? undefined : blockOf(entry, this.field);
    if (seq === undefined || seq.k !== 't' || !this.#core.alive(entry)) return [];
    return typedSpans({ entry, seq, base: floorOf(entry.meta, this.field) }, this.field);
  }

  /** Whether edits wait for the log: made and not flushed yet, or in a flush not settled. */
  get pending() {
    return this.#pending.length > 0 || this.#unsettled > 0;
  }

  /** Settles once every edit made so far is logged and landed; rejects with UNLOGGED when it could not be. */
  get flushed() {
    // Nothing waiting: the flush in flight, if one is — it rejects when its edits could not be logged.
    if (this.#pending.length === 0) return this.#unsettled > 0 ? this.#flushing : RESOLVED;
    if (this.#waiting === null) {
      const waiting = { promise: null, resolve: null, reject: null };
      waiting.promise = new Promise((resolve, reject) => {
        waiting.resolve = resolve;
        waiting.reject = reject;
      });
      waiting.promise.catch(() => {});
      this.#waiting = waiting;
    }
    return this.#waiting.promise;
  }

  /** Inserts `text` at `index`, marked with `attributes` (Quill's: a name, a value; null takes a style off). */
  insert(index, text, attributes) {
    if (typeof text !== 'string') throw new TypeError('insert() takes a string');
    if (text.length === 0) return;
    this.#edit('splice', spliceArgs('insert', this.field, index, 0, text));
    if (attributes !== undefined) this.#styled(index, text.length, attributes);
  }

  /** Cuts `count` characters at `index`. */
  delete(index, count) {
    if (count === 0) return;
    this.#edit('splice', spliceArgs('delete', this.field, index, count));
  }

  /** Inserts an embed slot at `index` holding `marker` (`{ type, parents?, attrs?, isEmbed? }`; an embed unless it says). */
  insertEmbed(index, marker, attributes) {
    const value = marker === null ? null : markerArgs('insertEmbed', marker, marker.isEmbed ?? true);
    const payload = spliceArgs('insertEmbed', this.field, index, 0, EMBED, { embeds: true });
    payload.vals = [[0, value]];
    this.#edit('splice', payload);
    if (attributes !== undefined) this.#styled(index, 1, attributes);
  }

  /**
   * Marks `[index, index + count)` with `attributes`; a null value takes the
   * style off, and `embed` sets the marker of every embed slot there.
   */
  format(index, count, attributes) {
    if (!Number.isInteger(count) || count < 0) throw new TypeError('format() takes a count');
    if (!isPlainObject(attributes)) throw new TypeError('format() takes attributes');
    for (const name of Object.keys(attributes)) {
      if (name === 'embed') this.#embed(index, index + count, attributes.embed);
      else this.#mark(index, index + count, name, attributes[name]);
    }
  }

  /**
   * Makes `delta` (Quill's form: retain, insert, delete — attributes as
   * marks, `{ insert: { embed } }` an embed slot, an `embed` attribute its
   * marker) the edits of the field, at once — as `storage.applyDelta()` does.
   */
  applyDelta(delta) {
    const shape = 'applyDelta() takes a delta: [{ retain, attributes? } | { insert, attributes? } | { delete }]';
    if (!Array.isArray(delta)) throw new TypeError(shape);
    // Checked whole before anything is made — its shape, its markers, and that it fits the text — so a delta
    // refused leaves nothing of itself behind, as the storage's applyDelta() does.
    let end = 0;
    for (let i = 0; i < delta.length; i++) {
      const op = delta[i];
      if (!isDeltaOp(op)) throw new TypeError(shape);
      if (op.retain !== undefined) {
        if (op.attributes !== undefined && !isPlainObject(op.attributes)) throw new TypeError(shape);
        end += op.retain;
      } else if (op.delete !== undefined) end += op.delete;
      else if (isPlainObject(op.insert)) {
        const marker = op.insert.embed;
        if (marker !== null) markerArgs('applyDelta', marker, marker.isEmbed ?? true);
      }
    }
    const length = this.length;
    if (end > length) {
      const message = `Index ${end} is out of range for field ${this.field} of record ${this.id} (length ${length})`;
      throw new SyncomError('OUT_OF_RANGE', message, { id: this.id, field: this.field, index: end, count: 0, length });
    }
    let at = 0;
    for (const op of delta) {
      if (op.delete !== undefined) this.delete(at, op.delete);
      else if (op.retain !== undefined) {
        if (op.attributes !== undefined) this.format(at, op.retain, op.attributes);
        at += op.retain;
      } else if (typeof op.insert === 'string') {
        // A delta says every insert's attributes itself: none is plain, never a mark it landed inside.
        this.insert(at, op.insert, op.attributes ?? {});
        at += op.insert.length;
      } else {
        this.insertEmbed(at, op.insert.embed, op.attributes ?? {});
        at += 1;
      }
    }
  }

  /**
   * `listener(delta, { local, reset?, source })` after every change of the
   * field the handle reads: its own edits as they are made (`local`), the
   * others as they are announced, in the handle's indices; `reset` — and no
   * delta — when the field is to be read again. Answers the function that
   * stops it.
   */
  observe(listener) {
    if (typeof listener !== 'function') throw new TypeError('observe() takes a function');
    this.#observers.add(listener);
    return () => this.#observers.delete(listener);
  }

  /** Logs every edit made so far, as one transaction; settles once it has landed. */
  flush() {
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    if (this.#pending.length === 0) return this.#unsettled > 0 ? this.#flushing : RESOLVED;
    const batch = this.#pending;
    const made = this.#made;
    const waiting = this.#waiting;
    this.#pending = [];
    this.#made = [];
    this.#waiting = null;
    const core = this.#core;
    this.#unsettled++;
    const landing = {
      ops: new Set(batch),
      batch,
      overlay: this.#overlay,
      heard: this.#heardTurns,
      started: false,
      logged: false,
      cancelled: false,
      error: null,
    };
    this.#landings.push(landing);
    const run = async () => {
      landing.started = true;
      // Taken behind a flush that could not be logged: its edits may anchor in what was dropped.
      if (landing.cancelled) throw landing.error;
      const { done } = await core.transact(
        async (tx) => {
          for (let i = 0; i < batch.length; i++) await tx.commitResolved(batch[i], made[i]);
        },
        { source: this.#source },
      );
      landing.logged = true;
      // Nothing logged (every edit moot): no turn comes for it.
      if (done === null) this.#landings.splice(this.#landings.indexOf(landing), 1);
      else await done;
    };
    const flushing = this.#flushing.then(run, run).then(
      () => {
        this.#unsettled--;
        waiting?.resolve();
      },
      (error) => {
        this.#unsettled--;
        // Logged, and a step after the append failed (an afterWrite hook): the
        // edits stand, their turn comes, the error is the caller's. Cancelled:
        // dropped with the flush before it, which said so.
        const unlogged = landing.logged || landing.cancelled ? error : this.#unlogged(landing, error);
        waiting?.reject(unlogged);
        throw unlogged;
      },
    );
    // Kept as it is — `flushed` hands it out while it is in flight — and never unhandled.
    this.#flushing = flushing;
    flushing.catch(NOOP);
    return flushing;
  }

  /** Logs what waits, then stops following the field. */
  async close() {
    if (this.#closed) return;
    // Refused from here on: an edit made while the flush is out would be logged with nothing reserved.
    this.#closed = true;
    try {
      await this.flush();
    } finally {
      this.#off();
      const { editing } = this.#core;
      editing.handles.delete(this);
      // The field's last handle gone: nothing to reserve its runs against; the last handle of all: nothing at all.
      let others = false;
      for (const handle of editing.handles) {
        if (handle.id === this.id && handle.field === this.field) others = true;
      }
      if (!others) editing.extents.delete(extentKey(this.id, this.field));
      if (editing.handles.size === 0) editing.extents.clear();
      this.#observers.clear();
    }
  }

  // An edit made at once: the op resolved and stamped over the overlay
  // (what the editor shows), applied to it — a refusal thrown, nothing
  // changed — and kept to log, grown into the one before where the two are
  // one; the observers told.
  #edit(type, payload) {
    if (this.#closed) throw new SyncomError('CLOSED', `The handle on ${this.field} of ${this.id} is closed`);
    const { editing } = this.#core;
    const from = this.#overlay;
    const op = editing.makeOp(type, this.id, payload, from, this.#actor);
    if (op.value === null || this.#prepended(op)) return;
    const applied = editing.applyLocal(op, from);
    if (applied === null) {
      // Nothing to edit: the record is gone (a delete or a purge heard) — said, never a keystroke that vanishes.
      if (from !== null && !this.#core.alive(from)) {
        throw new SyncomError('NOT_FOUND', `Record ${this.id} is gone: nothing to edit`, { id: this.id });
      }
      return;
    }
    this.#overlay = applied.entry;
    const at = this.#pending.length - 1;
    const last = at >= 0 ? this.#pending[at] : null;
    const grown = last === null || last.key !== op.key ? null : coalesce(last, op);
    if (grown !== null) {
      last.value = grown;
      const made = this.#made[at];
      made.entry = applied.entry;
      made.delta = assignData(made.delta ?? {}, applied.delta);
      for (let i = 0; i < applied.changes.length; i++) pushChange(made.changes, applied.changes[i]);
    } else {
      this.#pending.push(op);
      // `heard`: how many other writers' turns the handle had taken when the edit was made — what tells a
      // prepend (HANDLE-5) that none came since, whatever the overlay holds.
      const heard = this.#heardTurns;
      this.#made.push({ from, entry: applied.entry, delta: applied.delta, changes: applied.changes.slice(), heard });
    }
    this.#tell(applied.changes, true);
    if (this.#pending.length >= PENDING_MAX) void this.flush().catch(() => {});
    else this.#arm();
  }

  // A keystroke typed right before what the last edit inserted — a word
  // typed backward — is that edit, its content grown at the start (the kind's
  // `prepends`), applied again over the reading it was made over: nothing has
  // read its elements, it is not flushed. The observers are told the keystroke.
  #prepended(op) {
    const at = this.#pending.length - 1;
    if (at < 0) return false;
    const last = this.#pending[at];
    const made = this.#made[at];
    // Never once another writer's turn reached the overlay: the edit grown would be laid over the reading
    // before that turn, and the turn lost (a keystroke typed on sets `made.entry` to the overlay, so the
    // entry alone cannot tell).
    if (last.key !== op.key || made.heard !== this.#heardTurns || made.entry !== this.#overlay) return false;
    const grown = prepends(last, op);
    if (grown === null) return false;
    const was = last.value;
    last.value = grown;
    const { editing } = this.#core;
    let applied = null;
    try {
      applied = editing.applyLocal(last, made.from);
    } catch {
      applied = null;
    }
    const change = applied === null ? null : soleInsert(applied.changes, grown.content);
    if (change === null) {
      last.value = was;
      return false;
    }
    this.#overlay = applied.entry;
    made.entry = applied.entry;
    made.delta = applied.delta;
    made.changes = applied.changes.slice();
    // The run's next offset, where a writer reserved it, moves by what came before (HANDLE-4).
    const run = S.runKey(last.ts, last.origin);
    const runs = editing.extents.get(extentKey(this.id, this.field));
    const end = runs === undefined ? undefined : runs.get(run);
    if (end !== undefined) runs.set(run, end + op.value.content.length);
    this.#tell([{ ...change, content: op.value.content }], true);
    this.#arm();
    return true;
  }

  // The marks an inserted run reads with — the ones it landed in, the ones
  // that grew over it — replaced by `attributes`, a name at a time.
  #styled(start, length, attributes) {
    const entry = this.#overlay;
    const idx = S.indexOf(entry, this.field);
    const have = idx === null ? {} : marksAt(idx, start, floorOf(entry.meta, this.field));
    const want = { ...attributes };
    for (const name of Object.keys(have)) if (want[name] === undefined && name !== 'embed') want[name] = null;
    for (const name of Object.keys(want)) {
      if (name === 'embed') this.#embed(start, start + length, want.embed);
      else if (!deepEqual(have[name] ?? null, want[name])) this.#mark(start, start + length, name, want[name]);
    }
  }

  // The marker of every embed slot of [start, end): a setAt each.
  #embed(start, end, value) {
    const marker = value === null ? null : markerArgs('format', value, value.isEmbed ?? true);
    for (let index = start; index < end; index++) this.#edit('assign', { key: this.field, index, value: marker });
  }

  #mark(start, end, name, value) {
    markArgs('format', this.field, start, end, name, 'none');
    const marked = value === null ? null : asJson(jsonValue('format', value));
    this.#edit('mark', { key: this.field, start, end, name, value: marked, expand: 'none' });
  }

  #arm() {
    if (this.#timer !== null) return;
    if (this.#window === 0) {
      this.#timer = true;
      queueMicrotask(() => {
        this.#timer = null;
        void this.flush().catch(() => {});
      });
      return;
    }
    // Not unref'd: what waits for `flushed` must see it, the window is short.
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.flush().catch(() => {});
    }, this.#window);
  }

  // A turn the storage announced: the record's ops laid on the base — the
  // handle's own flushed ones there alone, the overlay has them — and every
  // other one on the overlay too, its changes told in the handle's indices.
  #heard(event) {
    const { editing } = this.#core;
    // The record made again from the log (`repair(id)`): the handle reads it as
    // the storage does, and what was typed over the old reading is dropped.
    if (event.repaired !== undefined) {
      if (event.repaired !== this.id) return;
      this.#heardTurns++;
      this.#base = event.entry;
      this.#overlay = event.entry;
      this.#unlogged(null, new Error(`Record ${this.id} was made again from the log (repair)`));
      return;
    }
    // The turn of the oldest flush still out — its ops are that flush's
    // (grown, or fewer: a moot one is not logged). The base it leaves is the
    // overlay the flush was taken from where no other writer's turn came in
    // between: ops commute, and an op again changes nothing.
    const landing = this.#landings.length > 0 ? this.#landings[0] : null;
    if (landing !== null && event.ops.length > 0 && landing.ops.has(event.ops[0])) {
      this.#landings.shift();
      if (landing.heard === this.#heardTurns) this.#base = landing.overlay;
      else for (const op of event.ops) this.#base = editing.applyTo(this.#base, op).entry;
      return;
    }
    const changes = [];
    let touched = false;
    for (const op of event.ops) {
      if (op.id !== this.id) continue;
      touched = true;
      // Nothing of the handle's on top: the base and the overlay are one reading, the op applied once.
      const idle = this.#overlay === this.#base;
      const onBase = editing.applyTo(this.#base, op);
      this.#base = onBase.entry;
      const applied = idle ? onBase : editing.applyTo(this.#overlay, op);
      if (idle) this.#overlay = this.#base;
      if (!applied.changed) continue;
      if (!idle) this.#overlay = applied.entry;
      for (const change of applied.changes) {
        if (change.field !== this.field && change.action !== 'delete' && change.action !== 'purge') continue;
        changes.push(change);
      }
    }
    if (touched) this.#heardTurns++;
    if (changes.length === 0 || this.#observers.size === 0) return;
    this.#tell(changes, false, event.source);
  }

  // The changes as a delta in the handle's indices, told once; what no delta says is a reset.
  #tell(changes, local, source = this.#source) {
    if (this.#observers.size === 0) return;
    const delta = toDelta(this.#core, changes, this.field);
    if (delta === null) return this.#tellReset(source);
    if (delta.length === 0) return;
    for (const listener of this.#observers) this.#call(listener, delta, { local, source });
  }

  #tellReset(source) {
    for (const listener of this.#observers) this.#call(listener, null, { local: false, reset: true, source });
  }

  #call(listener, delta, event) {
    try {
      listener(delta, event);
    } catch (error) {
      this.#core.logger.warn({ event: 'listener.error', name: 'handle', err: error });
    }
  }

  // A flush that logged nothing: what was not logged is gone — its batch,
  // the flushes taken behind it (cancelled before they log anything: their
  // edits may anchor in the batch) and what still waits — the overlay is the
  // field as announced again, whoever waits for `flushed` is told, the
  // observers read the field again, and the warning is written whether or
  // not anything listens.
  #unlogged(landing, cause) {
    // No landing: the record was made again from the log (a repair) — what waits is dropped, the flushes out stand.
    let edits = (landing === null ? 0 : landing.batch.length) + this.#pending.length;
    const cancelled = [];
    const landings = landing === null ? NONE : this.#landings;
    for (let i = 0; i < landings.length; i++) {
      const later = landings[i];
      if (later === landing || later.started) continue;
      later.cancelled = true;
      edits += later.batch.length;
      cancelled.push(later);
    }
    const error = new SyncomError('UNLOGGED', `Edits of ${this.field} of ${this.id} could not be logged`, {
      id: this.id,
      field: this.field,
      edits,
      cause,
    });
    for (let i = 0; i < cancelled.length; i++) cancelled[i].error = error;
    this.#pending = [];
    this.#made = [];
    this.#overlay = this.#base;
    if (landing !== null) this.#landings = [];
    if (this.#waiting !== null) {
      this.#waiting.reject(error);
      this.#waiting = null;
    }
    this.#tellReset(this.#source);
    this.#core.logger.warn({ event: 'handle.unlogged', id: this.id, field: this.field, edits, err: cause });
    if (this.listenerCount('error') > 0) this.emit('error', error).catch(NOOP);
    return error;
  }
}

/**
 * Opens a synchronous handle on text field `key` of record `id`: edits made
 * and read at once, logged a window later (`window` in ms — the storage's
 * `defer` by default, 0 for the end of the turn). `actor` is who the edits
 * say made them, `source` what their commit and transaction events carry.
 */
const openText = async (core, id, key, { window, actor, source } = {}) => {
  // A transaction's core makes its ops in one turn of the queue; a handle logs its own.
  if (core.commitResolved !== undefined) {
    throw new TypeError('openText() opens on the storage, not inside a transaction');
  }
  fieldName('openText', key);
  if (!isRecordId(id)) throw invalidId(id);
  if (window !== undefined && (!Number.isFinite(window) || window < 0)) {
    throw new TypeError('openText() takes window as a number of milliseconds');
  }
  let who = core.actorOf(actor);
  if (who !== null && typeof who === 'object') who = await who;
  // The base: the record as announced, read in a turn of the queue once what
  // was in flight has landed, so no op reaches the handle twice.
  const base = await core.run(async () => {
    await core.drain();
    const entry = await core.current(id);
    if (entry?.encrypted === true) throw new SyncomError('ENCRYPTED', `Record ${id} is encrypted`, { id });
    return entry;
  });
  // A field of another kind would refuse every edit: refused here, once.
  const kind = base === null || !core.alive(base) ? undefined : core.kindOf(base, key);
  if (kind !== undefined && kind !== 'text') {
    throw new SyncomError('FIELD_KIND', `Field ${key} of record ${id} is a ${kind}, not a text`, { field: key, kind });
  }
  return new TextHandle(core, id, key, base, {
    window: window ?? core.defer,
    actor: who,
    source: source ?? Symbol('syncom.handle'),
  });
};

// `change` onto `changes`: an insert that continues the one reported last is
// that change, grown — N keystrokes typed on are one change, as they are one
// op — never the last change edited in place (the observers were handed it).
const pushChange = (changes, change) => {
  const at = changes.length - 1;
  const last = at >= 0 ? changes[at] : null;
  if (
    last !== null &&
    last.action === 'splice' &&
    change.action === 'splice' &&
    last.count === 0 &&
    change.count === 0 &&
    typeof last.content === 'string' &&
    typeof change.content === 'string' &&
    last.index + last.content.length === change.index
  ) {
    changes[at] = { ...last, content: last.content + change.content };
    return;
  }
  changes.push(change);
};

// The one insert of `content` a grown edit reads as, or null for anything else.
const soleInsert = (changes, content) => {
  if (changes.length !== 1) return null;
  const change = changes[0];
  return change.action === 'splice' && change.count === 0 && change.content === content ? change : null;
};

// For the tests: the field as it reads, rendered from an entry.
const readingOf = (entry, key) => (entry === null ? '' : render(entry, key));

module.exports = { openText, TextHandle, readingOf };
