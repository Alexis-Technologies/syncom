'use strict';

// Undo and redo for one node's own writes — the `@alexify/syncom/undo`
// subpath. The manager listens to the storage's `commit` events and keeps,
// per commit, the patches that lead back (src/patch.js: the record after
// turned into the record before, by kind); commits close together merge
// into one step, `mark()` closes a step by hand. An undo applies a step's
// patches through `applyPatches()` — new ops of this node's own, so the
// undo merges like any write and a peer sees it as one — and what those
// ops commit becomes the redo step. Refuse-to-overwrite, Yjs's rule: a
// field anything but the step's own ops changed since the step was made
// is left alone, and a whole-record step with such a conflict is skipped
// unless forced; the manager's own ops, and the ops of steps already
// taken back, never count. A set element an undo removes goes as this
// node's adds alone, so a peer's concurrent add of it survives. The stack
// is this process's: nothing of it is written, a peer's ops are never
// undone from here, and a purge forgets its record.
//
// A transaction's commits are one step whatever the interval (`txn`), and
// `group(fn)` makes one of everything committed while `fn` runs. A step
// carries `meta`, the application's — a selection as cursor tokens, say,
// put there on `push` and read back on `pop`, where `position()` restores
// it — and the meta of a step taken back travels to its redo step and
// back. `trackedSources`, `records` and `paths` keep the stack to the
// commits they name: the `source` of a transaction, the records, the
// fields (and what hangs under them; a whole-record change is then none
// of the manager's business).

const { diffViews } = require('../patch.js');
const { Emitter } = require('../emitter.js');
const { PLUGINS } = require('../symbols.js');
const { under } = require('../paths.js');

const WHOLE = new Set(['write', 'delete', 'merge', 'purge']);
const GLOBAL = '*';

// The fields an op touched, or null for every field.
const touchedBy = (op) => {
  if (WHOLE.has(op.type)) return null;
  if (op.type === 'set') return Object.keys(op.data ?? {});
  return typeof op.key === 'string' ? [op.key] : [];
};

// The kinds of the fields a side of a commit has — a field only on one side
// is a reset for diffViews, since no op removes one field.
const kindsIn = (data, kinds) => {
  const out = {};
  if (data !== null) for (const field of Object.keys(data)) out[field] = kinds[field];
  return out;
};

// The types of the ops others made since on a field, on what hangs under
// it and on a prefix of it (a write at `profile` is a change of
// `profile/city`): what a patch of the field runs into.
const typesAround = (conflicts, field) => {
  let out;
  for (const [other, types] of conflicts) {
    if (other !== field && !under(other, field) && !under(field, other)) continue;
    out ??= new Set();
    for (const type of types) out.add(type);
  }
  return out;
};

// Whether a patch runs into what others did to its field since: anything
// for a register, a list, a text or a tree (an index is stale once the
// field moved); for a counter only what is not an increment, for a set
// only what is not an add or a remove — those commute with the patch.
const conflicting = (patch, types) => {
  if (types === undefined) return false;
  if (patch.action === 'inc') {
    for (const type of types) if (type !== 'inc') return true;
    return false;
  }
  if (patch.action === 'add' || (patch.action === 'remove' && patch.own === true)) {
    for (const type of types) if (type !== 'add' && type !== 'remove') return true;
    return false;
  }
  return true;
};

// Whether a field is one of the tracked `paths`, or hangs under one.
const tracked = (field, paths) => {
  for (let i = 0; i < paths.length; i++) if (field === paths[i] || under(field, paths[i])) return true;
  return false;
};

// The patches that take a record of a step back: from how the step left it
// to how it found it. Exact, a field the step created is gone again (a
// reset, when no op removes it); loose, a counter, a set, a list, a text or
// a tree it created is emptied instead — what to fall back on when the
// reset would run into a peer's change. A set element goes as this node's
// adds alone (`own`), so a concurrent add of it elsewhere survives. Under
// `paths`, the tracked fields alone: a whole-record way back is none of
// the manager's business.
const invert = ({ before, after, kinds, embeds }, exact, plugins, paths) => {
  const context = { from: { embeds: embeds?.after ?? null }, to: { embeds: embeds?.before ?? null } };
  const patches = diffViews(after, kindsIn(after, kinds), before, kindsIn(before, kinds), { exact, plugins, context });
  const out = [];
  for (let i = 0; i < patches.length; i++) {
    const patch = patches[i];
    if (paths !== null && (patch.field === undefined || !tracked(patch.field, paths))) continue;
    out.push(patch.action === 'remove' ? { ...patch, own: true } : patch);
  }
  return out;
};

const isWhole = (patches) => {
  for (let i = 0; i < patches.length; i++) {
    if (patches[i].action === 'write' || patches[i].action === 'delete') return true;
  }
  return false;
};

// Whether a commit's changes reach a tracked path: the field, what hangs
// under it, or a prefix of it; a whole-record change reaches none.
const reaches = (changes, paths) => {
  for (let i = 0; i < changes.length; i++) {
    const { field } = changes[i];
    if (field === undefined) continue;
    for (let j = 0; j < paths.length; j++) {
      const path = paths[j];
      if (field === path || under(field, path) || under(path, field)) return true;
    }
  }
  return false;
};

// A non-empty list of strings.
const isPathList = (paths) => {
  if (!Array.isArray(paths) || paths.length === 0) return false;
  for (let i = 0; i < paths.length; i++) if (typeof paths[i] !== 'string') return false;
  return true;
};

// What a step shows of itself: its meta — the application's object, the
// same one every time, so what a `push` listener puts there a `pop`
// listener finds — and what it is of.
const stepView = (step) => ({
  id: step.id,
  meta: step.meta,
  records: [...step.records.keys()],
  at: step.at,
  source: step.source,
  message: step.message,
  txn: step.txn,
});

// What a step keeps of one record: how the first commit found it, how the
// last left it, the kinds of every field seen, its own seqs. The commits'
// events hold the copies, taken when the step is inverted — never one per
// keystroke (a large record was copied twice for every commit).
class Kept {
  constructor(event) {
    this.first = event;
    this.last = event;
    this.kinds = { ...event.kinds };
    this.seqs = new Set([event.seq]);
  }

  get before() {
    return this.first.before;
  }

  get after() {
    return this.last.after;
  }

  // A text's embed markers, each side: the inverse of a cut lays them again.
  get embeds() {
    return { before: this.first.embeds?.before ?? null, after: this.last.embeds?.after ?? null };
  }
}

class UndoManager extends Emitter {
  #storage;
  #options;
  #token = Symbol('undo');
  #undo = [];
  #redo = [];
  #nextId = 1;
  // `group()`: how deep, and the step everything committed meanwhile joins.
  #grouping = 0;
  #grouped = null;
  // The seqs of the manager's own ops: an undo's ops never stand in the way
  // of an older step (undoing two steps in a row), only everyone else's do.
  // Those below the oldest step stand in nobody's way and are forgotten.
  #own = new Set();
  // The oldest seq a step on either stack was made at — what the log is
  // asked to keep; read by the pin on every entry, so kept, not recomputed.
  #oldestSeq = Infinity;
  #collecting = null;
  #unpin;
  #stopped = false;
  #onCommit = (event) => this.#commit(event);
  #onClose = () => this.stop();

  constructor(storage, options) {
    super();
    this.#storage = storage;
    this.#options = options;
    storage.on('commit', this.#onCommit);
    storage.on('close', this.#onClose);
    if (options.onPush) this.on('push', options.onPush);
    if (options.onPop) this.on('pop', options.onPop);
    // What a step's conflicts are read from must stay in the log.
    this.#unpin = storage.log.pin((entry) => entry.seq >= this.#oldestSeq);
  }

  // After the stacks changed: the oldest seq they hold, and the own seqs
  // that no step can consult any more.
  #refreshOldest() {
    let seq = Infinity;
    for (const step of this.#undo) seq = Math.min(seq, step.lastSeq);
    for (const step of this.#redo) seq = Math.min(seq, step.lastSeq);
    this.#oldestSeq = seq;
    for (const own of this.#own) if (own <= seq) this.#own.delete(own);
  }

  get canUndo() {
    return this.#undo.length > 0;
  }

  get canRedo() {
    return this.#redo.length > 0;
  }

  /** How many steps each way. */
  get size() {
    return { undo: this.#undo.length, redo: this.#redo.length };
  }

  #commit(event) {
    if (this.#stopped) return;
    const { op, seq } = event;
    // The manager's own ops: what an undo or a redo commits is the step
    // of the other stack.
    if (event.source === this.#token) {
      this.#own.add(seq);
      if (this.#collecting !== null) this.#record(this.#collecting, event);
      return;
    }
    const { scope, exclude, trackedSources, records, paths } = this.#options;
    if (op.type === 'purge') return this.#forget(op.id);
    if (scope !== undefined && (op.scope ?? GLOBAL) !== scope) return;
    if (exclude !== null && exclude(op)) return;
    if (trackedSources !== null && !trackedSources.has(event.source)) return;
    if (records !== null && !(typeof records === 'function' ? records(op.id) : records.has(op.id))) return;
    if (paths !== null && !reaches(event.changes ?? [], paths)) return;
    const top = this.#undo[this.#undo.length - 1];
    let step = top;
    // The oldest seq a step holds moves only when a step leaves: a commit
    // adds the newest seq there is — no walk of the stacks per keystroke.
    let left = this.#redo.length > 0;
    // The open group takes everything; a transaction's commits are one
    // step; else commits within the interval of the step's first join it.
    if (this.#grouping > 0 && this.#grouped !== null) step = this.#grouped;
    else if (
      top === undefined ||
      top.closed ||
      (top.txn !== event.txn && op.ts - top.at > this.#options.mergeInterval)
    ) {
      step = this.#newStep(op.ts, event);
      this.#undo.push(step);
      while (this.#undo.length > this.#options.limit) {
        this.#undo.shift();
        left = true;
      }
      if (this.#grouping > 0) this.#grouped = step;
    }
    this.#record(step, event);
    if (this.#redo.length > 0) this.#redo = [];
    if (left || this.#oldestSeq === Infinity) this.#refreshOldest();
    if (this.listenerCount('push') > 0) {
      this.emit('push', { direction: 'undo', records: step.records.size, step: stepView(step) });
    }
    this.emit('change');
  }

  #newStep(at, event = null) {
    return {
      id: this.#nextId++,
      at,
      lastSeq: event === null ? 0 : event.seq,
      txn: event === null ? null : event.txn,
      seqs: new Set(),
      taken: new Set(),
      records: new Map(),
      closed: false,
      meta: {},
      source: event === null ? null : event.source,
      message: event === null ? null : (event.op.msg ?? null),
    };
  }

  // One commit into a step: per record the step keeps how it found the
  // record (the first commit's before), how it left it (the last commit's
  // after), the kinds of every field seen — the inverse is made of those
  // when the step is taken back — and the seqs of its own ops on it.
  #record(step, event) {
    const { op, seq, kinds } = event;
    step.lastSeq = Math.max(step.lastSeq, seq);
    step.seqs.add(seq);
    const record = step.records.get(op.id);
    if (record === undefined) step.records.set(op.id, new Kept(event));
    else {
      record.last = event;
      record.seqs.add(seq);
      Object.assign(record.kinds, kinds);
    }
  }

  // A purged record is gone for good: nothing of it stays here.
  #forget(id) {
    for (const stack of [this.#undo, this.#redo]) {
      let kept = 0;
      for (let i = 0; i < stack.length; i++) {
        const step = stack[i];
        step.records.delete(id);
        if (step.records.size > 0) stack[kept++] = step;
      }
      stack.length = kept;
    }
    this.#refreshOldest();
    this.emit('change');
  }

  // Per field of `id`, the types of the ops other than the step's own that
  // touched it since the step was made — null when a whole-record op (a
  // reset, a merge) landed. The manager's own ops do not count, nor do the
  // ops of steps already taken back (they sit on the redo stack): undoing
  // step after step is not a conflict with oneself.
  #conflicts(step, id) {
    const fields = new Map();
    const undone = new Set();
    for (const taken of this.#redo) for (const seq of taken.taken) undone.add(seq);
    for (const entry of this.#storage.log.entriesOf(id)) {
      const { seq, op } = entry;
      if (seq <= step.lastSeq || step.seqs.has(seq) || this.#own.has(seq) || undone.has(seq) || entry.skipped) continue;
      const touched = touchedBy(op);
      if (touched === null) return null;
      for (const field of touched) {
        const types = fields.get(field);
        if (types) types.add(op.type);
        else fields.set(field, new Set([op.type]));
      }
    }
    return fields;
  }

  async #apply(from, to, direction, { force = false } = {}) {
    const step = from.pop();
    if (step === undefined) return { applied: 0, skipped: 0 };
    const result = { applied: 0, skipped: 0 };
    // The step of the other stack: what this one's ops commit, and the seqs
    // of the records it took back (they no longer stand in an older step's
    // way) — record by record, so a step taken back in part is accounted in
    // part. Its meta is this step's: what the application put on the step
    // comes back with its redo, and with the undo of that.
    const collected = this.#newStep(step.at);
    collected.closed = true;
    collected.meta = step.meta;
    collected.source = step.source;
    collected.message = step.message;
    this.#collecting = collected;
    const { paths } = this.#options;
    const left = new Map(step.records);
    const took = (id, record) => {
      left.delete(id);
      for (const seq of record.seqs) collected.taken.add(seq);
    };
    let current = null;
    try {
      for (const [id, record] of step.records) {
        current = id;
        const conflicts = this.#conflicts(step, id);
        const plugins = this.#storage[PLUGINS];
        const patches = invert(record, true, plugins, paths);
        let kept = patches;
        let skipped = 0;
        if (!force && (conflicts === null || (isWhole(patches) && conflicts.size > 0))) {
          // A whole-record patch (the record made again after a delete, or
          // deleted again) with a change by others since: left alone whole.
          kept = [];
          skipped = patches.length;
        } else if (!force) {
          // Field by field: the exact way back where nothing else touched
          // the field; where something did, the loose one — a counter taken
          // down, this node's adds removed — when it commutes with what the
          // others did, else the field is left alone.
          const loose = invert(record, false, plugins, paths);
          const byField = new Map();
          for (let i = 0; i < loose.length; i++) {
            const alt = loose[i];
            const list = byField.get(alt.field);
            if (list === undefined) byField.set(alt.field, [alt]);
            else list.push(alt);
          }
          kept = [];
          for (const patch of patches) {
            const types = typesAround(conflicts, patch.field);
            if (!conflicting(patch, types)) {
              kept.push(patch);
              continue;
            }
            const alternatives = byField.get(patch.field);
            let taken = 0;
            if (alternatives !== undefined) {
              for (let i = 0; i < alternatives.length; i++) {
                if (conflicting(alternatives[i], types)) continue;
                kept.push(alternatives[i]);
                taken++;
              }
            }
            if (taken === 0) skipped++;
          }
        }
        result.skipped += skipped;
        if (kept.length > 0) {
          result.applied += await this.#storage.applyPatches(id, kept, {
            source: this.#token,
            actor: this.#options.actor,
          });
        }
        took(id, record);
      }
    } catch (error) {
      // What was taken back stays taken back: the records already inverted
      // leave the step, their way back on the other stack; the rest wait on
      // this one for another try. A record is never inverted twice — nor in
      // part: where the failure stopped inside a record, the ops that landed
      // are on the other stack, and what they left is where its inverse
      // starts next time.
      const partial = current === null ? undefined : collected.records.get(current);
      if (partial !== undefined && left.has(current)) {
        const record = left.get(current);
        left.set(current, {
          before: record.before,
          after: partial.after,
          embeds: { before: record.embeds.before, after: partial.embeds.after },
          kinds: { ...record.kinds, ...partial.kinds },
          seqs: record.seqs,
        });
      }
      if (left.size > 0) from.push({ ...step, records: left });
      if (collected.records.size > 0) to.push(collected);
      this.#refreshOldest();
      this.emit('change');
      throw error;
    } finally {
      this.#collecting = null;
    }
    if (collected.records.size > 0) to.push(collected);
    this.#refreshOldest();
    if (this.listenerCount('pop') > 0) this.emit('pop', { direction, ...result, step: stepView(step) });
    this.emit('change');
    return result;
  }

  /**
   * Everything committed while `fn` runs is one step, whatever the
   * interval; resolves to what `fn` returned. Nests: the outermost group
   * is the step.
   */
  async group(fn) {
    if (typeof fn !== 'function') throw new TypeError('group() takes a function');
    this.groupStart();
    try {
      return await fn();
    } finally {
      this.groupEnd();
    }
  }

  /** Opens a group: the next commits are one step until `groupEnd()`. */
  groupStart() {
    this.#grouping++;
  }

  /** Closes the group opened by `groupStart()`; the outermost close ends the step. */
  groupEnd() {
    if (this.#grouping === 0) return;
    this.#grouping--;
    if (this.#grouping === 0) {
      if (this.#grouped !== null) this.#grouped.closed = true;
      this.#grouped = null;
    }
  }

  /** Takes the newest step back; `{ applied, skipped }` ops. A field changed since by anyone else is left alone; `force` overrides. */
  undo(options) {
    return this.#apply(this.#undo, this.#redo, 'undo', options);
  }

  /** Does the last undone step again. */
  redo(options) {
    return this.#apply(this.#redo, this.#undo, 'redo', options);
  }

  /** Closes the current step: the next commit starts a new one. */
  mark() {
    const top = this.#undo[this.#undo.length - 1];
    if (top !== undefined) top.closed = true;
    if (this.#grouping > 0) this.#grouped = null;
  }

  /** The steps each way, newest last: `{ id, meta, records, at, source, message, txn }` per step. */
  get steps() {
    const undo = [];
    for (let i = 0; i < this.#undo.length; i++) undo.push(stepView(this.#undo[i]));
    const redo = [];
    for (let i = 0; i < this.#redo.length; i++) redo.push(stepView(this.#redo[i]));
    return { undo, redo };
  }

  clear() {
    this.#undo = [];
    this.#redo = [];
    this.#own.clear();
    this.#refreshOldest();
    this.emit('change');
  }

  /** Stops listening and lets the log compact; the stacks are dropped. */
  stop() {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#storage.off('commit', this.#onCommit);
    this.#storage.off('close', this.#onClose);
    this.#unpin();
    this.#undo = [];
    this.#redo = [];
  }
}

/**
 * An undo manager over `storage`'s own writes. `mergeInterval` (ms, 500 by
 * default) merges commits close together into one step, `limit` (100) is
 * how many steps are kept, `scope` keeps to ops of one scope, `exclude(op)`
 * leaves ops out, `actor` is who the undo's ops say made them;
 * `trackedSources` (the `source` of a transaction or a Record's save),
 * `records` (ids, or a predicate) and `paths` (fields, with what hangs
 * under them) keep the stack to the commits they name; `onPush(event)` and
 * `onPop(event)` are the `push` and `pop` listeners.
 */
const createUndo = (storage, options = {}) => {
  const { mergeInterval = 500, limit = 100, scope, exclude = null, actor, onPush, onPop } = options;
  const { trackedSources = null, records = null, paths = null } = options;
  if (!Number.isFinite(mergeInterval) || mergeInterval < 0) {
    throw new TypeError('createUndo(): mergeInterval is ms ≥ 0');
  }
  if (!Number.isInteger(limit) || limit < 1) throw new TypeError('createUndo(): limit is a positive integer');
  if (exclude !== null && typeof exclude !== 'function') throw new TypeError('createUndo(): exclude is a function');
  if (scope !== undefined && typeof scope !== 'string') throw new TypeError('createUndo(): scope is a string');
  if (trackedSources !== null && typeof trackedSources?.[Symbol.iterator] !== 'function') {
    throw new TypeError('createUndo(): trackedSources is a list of sources');
  }
  if (records !== null && typeof records !== 'function' && typeof records?.[Symbol.iterator] !== 'function') {
    throw new TypeError('createUndo(): records is a list of ids, or a predicate');
  }
  if (paths !== null && !isPathList(paths)) throw new TypeError('createUndo(): paths is a list of field paths');
  for (const [name, fn] of [
    ['onPush', onPush],
    ['onPop', onPop],
  ]) {
    if (fn !== undefined && typeof fn !== 'function') throw new TypeError(`createUndo(): ${name} is a function`);
  }
  if (!storage || typeof storage.on !== 'function' || !storage.log) throw new TypeError('createUndo() takes a storage');
  return new UndoManager(storage, {
    mergeInterval,
    limit,
    scope,
    exclude,
    actor,
    onPush,
    onPop,
    trackedSources: trackedSources === null ? null : new Set(trackedSources),
    records: records === null || typeof records === 'function' ? records : new Set(records),
    paths,
  });
};

module.exports = { createUndo, UndoManager };
