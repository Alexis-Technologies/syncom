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
const { spliceArgs, markArgs, jsonValue, fieldName } = require('../args.js');
const { isRecordId, invalidId, isPlainObject, asJson } = require('../shape.js');
const { floorOf } = require('../vector.js');
const S = require('./sequence.js');
const { coalesce, render, blockOf, marksAt } = require('./kind.js');
const { toDelta } = require('./deltas.js');

// What a handle holds at most before it flushes whatever the window says.
const PENDING_MAX = 1024;

const RESOLVED = Promise.resolve();

class TextHandle extends Emitter {
  #core;
  #source;
  #actor;
  #window;
  #base;
  #overlay;
  #pending = [];
  #flushing = RESOLVED;
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
    this.#off = core.on('transaction', (event) => this.#heard(event));
    core.editing.handles.add(this);
  }

  /** The field as the handle reads it: the storage's, with every edit made here on top. */
  toString() {
    const text =
      this.#overlay !== null && blockOf(this.#overlay, this.field) !== undefined ? this.#overlay.data[this.field] : '';
    return typeof text === 'string' ? text : '';
  }

  get length() {
    return this.toString().length;
  }

  slice(start, end) {
    return this.toString().slice(start, end);
  }

  /** Whether edits wait for the log. */
  get pending() {
    return this.#pending.length > 0;
  }

  /** Settles once every edit made so far is logged and landed; rejects with UNLOGGED when it could not be. */
  get flushed() {
    if (this.#pending.length === 0) return this.#flushing;
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

  /** Marks `[index, index + count)` with `attributes`; a null value takes the style off. */
  format(index, count, attributes) {
    if (!Number.isInteger(count) || count < 0) throw new TypeError('format() takes a count');
    if (!isPlainObject(attributes)) throw new TypeError('format() takes attributes');
    for (const name of Object.keys(attributes)) this.#mark(index, index + count, name, attributes[name]);
  }

  /**
   * Makes `delta` (Quill's form: retain, insert, delete — attributes as
   * marks) the edits of the field, at once.
   */
  applyDelta(delta) {
    if (!Array.isArray(delta)) throw new TypeError('applyDelta() takes a delta');
    let at = 0;
    for (const op of delta) {
      if (!isPlainObject(op)) throw new TypeError('applyDelta() takes a delta');
      if (op.delete !== undefined) this.delete(at, op.delete);
      else if (op.retain !== undefined) {
        if (op.attributes !== undefined) this.format(at, op.retain, op.attributes);
        at += op.retain;
      } else if (typeof op.insert === 'string') {
        this.insert(at, op.insert, op.attributes);
        at += op.insert.length;
      } else throw new TypeError('applyDelta() on a handle takes text: an embed goes through storage.insertEmbed()');
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
    if (this.#pending.length === 0) return this.#flushing;
    const batch = this.#pending;
    const waiting = this.#waiting;
    this.#pending = [];
    this.#waiting = null;
    const core = this.#core;
    const run = async () => {
      const { done } = await core.transact(
        async (tx) => {
          for (let i = 0; i < batch.length; i++) await tx.commitResolved(batch[i]);
        },
        { source: this.#source },
      );
      if (done !== null) await done;
    };
    const flushing = this.#flushing.then(run, run).then(
      () => waiting?.resolve(),
      (error) => {
        const unlogged = this.#unlogged(batch, error);
        waiting?.reject(unlogged);
        throw unlogged;
      },
    );
    this.#flushing = flushing.catch(() => {});
    return flushing;
  }

  /** Logs what waits, then stops following the field. */
  async close() {
    if (this.#closed) return;
    try {
      await this.flush();
    } finally {
      this.#closed = true;
      this.#off();
      this.#core.editing.handles.delete(this);
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
    const op = editing.makeOp(type, this.id, payload, this.#overlay, this.#actor);
    if (op.value === null) return;
    const applied = editing.applyLocal(op, this.#overlay);
    if (applied === null) return;
    this.#overlay = applied.entry;
    const last = this.#pending.length > 0 ? this.#pending[this.#pending.length - 1] : null;
    const grown = last === null || last.key !== op.key ? null : coalesce(last, op);
    if (grown !== null) last.value = grown;
    else this.#pending.push(op);
    this.#tell(applied.changes, true);
    if (this.#pending.length >= PENDING_MAX) void this.flush().catch(() => {});
    else this.#arm();
  }

  // The marks an inserted run reads with — the ones it landed in, the ones
  // that grew over it — replaced by `attributes`, a name at a time.
  #styled(start, length, attributes) {
    const entry = this.#overlay;
    const idx = S.indexOf(entry, this.field);
    const have = idx === null ? {} : marksAt(idx, start, floorOf(entry.meta, this.field));
    const want = { ...attributes };
    for (const name of Object.keys(have)) if (want[name] === undefined) want[name] = null;
    for (const name of Object.keys(want)) {
      if (JSON.stringify(have[name] ?? null) !== JSON.stringify(want[name])) {
        this.#mark(start, start + length, name, want[name]);
      }
    }
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
    const own = event.source === this.#source;
    const { editing } = this.#core;
    const changes = [];
    let reset = false;
    for (const op of event.ops) {
      if (op.id !== this.id) continue;
      this.#base = editing.applyTo(this.#base, op).entry;
      if (own) continue;
      const applied = editing.applyTo(this.#overlay, op);
      if (!applied.changed) continue;
      this.#overlay = applied.entry;
      for (const change of applied.changes) {
        if (change.field !== this.field && change.action !== 'delete' && change.action !== 'purge') continue;
        changes.push(change);
      }
    }
    if (changes.length === 0) return;
    if (toDelta(this.#core, changes, this.field) === null) reset = true;
    if (reset) this.#tellReset(event.source);
    else this.#tell(changes, false, event.source);
  }

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

  // A flush that did not land: what was not logged is gone — the batch and
  // what was typed on top of it, which may anchor in it — the overlay is the
  // field as announced again, and the observers read it again.
  #unlogged(batch, cause) {
    const edits = batch.length + this.#pending.length;
    this.#pending = [];
    this.#overlay = this.#base;
    this.#tellReset(this.#source);
    const error = new SyncomError('UNLOGGED', `Edits of ${this.field} of ${this.id} could not be logged`, {
      id: this.id,
      field: this.field,
      edits,
      cause,
    });
    if (this.listenerCount('error') > 0) this.emit('error', error).catch(() => {});
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

// For the tests: the field as it reads, rendered from an entry.
const readingOf = (entry, key) => (entry === null ? '' : render(entry, key));

module.exports = { openText, TextHandle, readingOf };
