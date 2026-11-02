'use strict';

// What a database hands the application: a Document (a live view of one record
// that saves through the database) and a Reference (a record named by
// another's field). They use the database's public API and the module-private
// symbols — nothing below them. The Collection lives in src/collection.js.

const { Emitter } = require('./emitter.js');
const { notify } = require('./hooks.js');
const { isPlainObject } = require('./shape.js');
const { COMMIT, REFRESH, SOURCE } = require('./symbols.js');

// A field of a declared reference, as a Document holds it: a string made a
// Reference, an array of them where the reference is to many; anything else
// as it is (a reference not yet set, a value of another shape).
const referenced = (value, many, storage) => {
  if (!many) return typeof value === 'string' ? new Reference(value, storage) : value;
  if (!Array.isArray(value)) return value;
  const out = [];
  for (let i = 0; i < value.length; i++) {
    out.push(typeof value[i] === 'string' ? new Reference(value[i], storage) : value[i]);
  }
  return out;
};

class Reference {
  #id;
  #storage = null;

  constructor(id, storage) {
    this.#id = id;
    this.#storage = storage;
  }

  /** The id the reference names. */
  get id() {
    return this.#id;
  }

  /** The live Document the reference names, or null when the record is not there (gone, or never was). */
  async document() {
    if (!this.#storage.hasRecord(this.#id)) return null;
    return await this.#storage.document(this.#id);
  }

  toJSON() {
    return this.#id;
  }

  /** @deprecated `document()` — the name before the rename. */
  record() {
    return this.document();
  }
}

class Document extends Emitter {
  #id;
  #storage = null;
  #data = null;
  #changes = {};
  #shadowed = new Set();

  constructor(id, storage) {
    super();
    this.#id = id;
    this.#storage = storage;
    return this.#load();
  }

  async #load() {
    if (this.#data !== null) return this;
    const rawData = await this.#storage.get(this.#id);
    if (rawData) this.#adopt(rawData);
    return this;
  }

  #adopt(rawData) {
    this.#data = JSON.parse(JSON.stringify(rawData));
    this.#convertToReferences(this.#data);
    this.#defineProperties();
  }

  // The references the record's collection declares (`refs`), by field; null for none.
  #refs() {
    const type = this.#data?.$type;
    if (typeof type !== 'string') return null;
    return this.#storage[SOURCE].definition(type)?.refs ?? null;
  }

  // A field's value as the Record holds it: a copy, a declared reference's
  // id made a Reference.
  #own(key, value) {
    const refs = this.#refs();
    if (refs !== null && Object.hasOwn(refs, key)) return referenced(value, refs[key].many, this.#storage);
    if (!value || typeof value !== 'object') return value;
    return JSON.parse(JSON.stringify(value));
  }

  /**
   * The record(s) a declared reference field names, as live Documents: one
   * (or null when the record is not there), or an array of them where the
   * reference is to many. A field that is no declared reference is a TypeError.
   */
  async populate(field) {
    const refs = this.#refs();
    if (refs === null || !Object.hasOwn(refs, field)) {
      throw new TypeError(`populate(): ${field} is not a declared reference (refs)`);
    }
    const value = this.#data[field];
    if (!refs[field].many) return value instanceof Reference ? value.document() : null;
    const out = [];
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) out.push(value[i] instanceof Reference ? await value[i].document() : null);
    }
    return out;
  }

  // The fields a write changed laid over what the Record holds, from the
  // reading — never the whole record copied again (a 400 KB text made every
  // keystroke cost the record). False when the delta cannot say it: a path
  // (`profile/city` is a field of `profile`'s), or nothing to lay it on.
  #patch(data, delta) {
    if (this.#data === null || !isPlainObject(delta)) return false;
    const keys = Object.keys(delta);
    for (let i = 0; i < keys.length; i++) if (keys[i].includes('/')) return false;
    let added = false;
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      if (!Object.hasOwn(data, key)) {
        delete this.#data[key];
        continue;
      }
      if (!Object.hasOwn(this.#data, key)) added = true;
      this.#data[key] = this.#own(key, data[key]);
    }
    if (added) this.#defineProperties();
    return true;
  }

  // The declared references of the record's collection, made References: a
  // field named in `refs` alone — never a string that happens to equal an id.
  #convertToReferences(data) {
    const refs = this.#refs();
    if (refs === null) return;
    for (const key of Object.keys(refs)) {
      if (Object.hasOwn(data, key)) data[key] = referenced(data[key], refs[key].many, this.#storage);
    }
  }

  get id() {
    return this.#id;
  }

  #defineProperties() {
    const keys = Object.keys(this.#data);
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      if (key === 'id') continue;
      if (key in this) {
        // An accessor from an earlier adopt reads #data live. A field named
        // like a member of the class (`save`, `delete`, `data`) stays
        // reachable through data() and never shadows the method.
        if (!Object.hasOwn(this, key) && !this.#shadowed.has(key)) {
          this.#shadowed.add(key);
          this.#storage.logger.warn({ event: 'record.shadowed', id: this.#id, key });
        }
        continue;
      }
      Object.defineProperty(this, key, {
        get() {
          return this.#data?.[key];
        },
        set(newValue) {
          const oldValue = this.#data?.[key];
          if (oldValue === newValue) return;
          this.#data[key] = newValue;
          this.#changes[key] = newValue;
          const delta = { [key]: newValue };
          notify(this, this.#storage.logger, 'update', this.#data, delta);
        },
        enumerable: true,
        configurable: true,
      });
    }
  }

  // The record changed in storage — a remote op, a `storage.update()`, or
  // its own save landing. The view is rebuilt from the authoritative data,
  // unsaved local edits are laid back on top (they are still pending), and
  // listeners hear about it unless the record itself caused the change.
  [REFRESH](data, delta, source, plain = false) {
    if (data === null) {
      this.#data = null;
      this.#changes = {};
      if (source !== this) notify(this, this.#storage.logger, 'update', null, delta);
      return;
    }
    if (!plain || !this.#patch(data, delta)) this.#adopt(data);
    // What is staged lies back on top as the Record holds a field (a declared reference's id a Reference).
    const pending = Object.keys(this.#changes);
    for (let i = 0; i < pending.length; i++) this.#data[pending[i]] = this.#own(pending[i], this.#changes[pending[i]]);
    if (source !== this) notify(this, this.#storage.logger, 'update', this.#data, delta);
  }

  async data() {
    return this.#data;
  }

  delta() {
    return { ...this.#changes };
  }

  async save(options = {}) {
    if (Object.keys(this.#changes).length === 0) return;
    const delta = this.delta();
    await this.#storage[COMMIT]('set', this.#id, { data: delta }, { source: this, actor: options.actor });
    this.#changes = {};
  }

  /** Adds to a counter field; the storage-level `inc` with this record's id. */
  async inc(key, value = 1, options = {}) {
    await this.#storage.inc(this.#id, key, value, options);
  }

  /** Adds to a set field; the storage-level `add` with this record's id. */
  async add(key, elements, options = {}) {
    await this.#storage.add(this.#id, key, elements, options);
  }

  /** Removes from a set field; the storage-level `remove` with this record's id. */
  async remove(key, elements, options = {}) {
    await this.#storage.remove(this.#id, key, elements, options);
  }

  /** Removes fields; the storage-level `unset` with this record's id. */
  async unset(fields, options = {}) {
    await this.#storage.unset(this.#id, fields, options);
  }

  /** Splices a list or text field; the storage-level `splice` with this record's id. */
  async splice(key, index, count = 0, content, options = {}) {
    await this.#storage.splice(this.#id, key, index, count, content, options);
  }

  /** Appends to a list or text field; the storage-level `push` with this record's id. */
  async push(key, content, options = {}) {
    await this.#storage.push(this.#id, key, content, options);
  }

  /** Makes a text field read as `text`; the storage-level `updateText` with this record's id. */
  async updateText(key, text, options = {}) {
    return this.#storage.updateText(this.#id, key, text, options);
  }

  /** Marks a range of a text field; the storage-level `mark` with this record's id. */
  async mark(key, start, end, name, value, options = {}) {
    return this.#storage.mark(this.#id, key, start, end, name, value, options);
  }

  /** Removes a style from a text field; the storage-level `unmark` with this record's id. */
  async unmark(key, start, end, name, options = {}) {
    await this.#storage.unmark(this.#id, key, start, end, name, options);
  }

  /** Switches one mark off by its id; the storage-level `unmarkById` with this record's id. */
  async unmarkById(key, markId, options = {}) {
    await this.#storage.unmarkById(this.#id, key, markId, options);
  }

  /** The text field as runs of equal style; the storage-level `spans` with this record's id. */
  async spans(key) {
    return this.#storage.spans(this.#id, key);
  }

  /** Inserts an embed into a text field; the storage-level `insertEmbed` with this record's id. */
  async insertEmbed(key, index, embed, options = {}) {
    await this.#storage.insertEmbed(this.#id, key, index, embed, options);
  }

  /** Inserts a block marker into a text field; the storage-level `splitBlock` with this record's id. */
  async splitBlock(key, index, block, options = {}) {
    await this.#storage.splitBlock(this.#id, key, index, block, options);
  }

  /** Removes a block marker; the storage-level `joinBlock` with this record's id. */
  async joinBlock(key, index, options = {}) {
    await this.#storage.joinBlock(this.#id, key, index, options);
  }

  /** Replaces a block marker; the storage-level `updateBlock` with this record's id. */
  async updateBlock(key, index, block, options = {}) {
    await this.#storage.updateBlock(this.#id, key, index, block, options);
  }

  /** The marker at an index of a text field; the storage-level `block` with this record's id. */
  async block(key, index) {
    return this.#storage.block(this.#id, key, index);
  }

  /** A text field as its blocks; the storage-level `blocks` with this record's id. */
  async blocks(key) {
    return this.#storage.blocks(this.#id, key);
  }

  /** A cursor into a list or text field; the storage-level `cursor` with this record's id. */
  /** The name of a list element; the storage-level `elementAt` with this record's id. */
  async elementAt(key, index) {
    return this.#storage.elementAt(this.#id, key, index);
  }

  /** The names of a list's elements; the storage-level `elements` with this record's id. */
  async elements(key) {
    return this.#storage.elements(this.#id, key);
  }

  async cursor(key, index, options = {}) {
    return this.#storage.cursor(this.#id, key, index, options);
  }

  /** Where a cursor is now; the storage-level `index` with this record's id. */
  async index(key, cursor) {
    return this.#storage.index(this.#id, key, cursor);
  }

  /** Who last wrote a field; the storage-level `lastEditorOf` with this record's id. */
  lastEditorOf(field) {
    return this.#storage.lastEditorOf(this.#id, field);
  }

  /** Every node that wrote something this record carries; the storage-level `editorsOf`. */
  editorsOf() {
    return this.#storage.editorsOf(this.#id);
  }

  /** Who inserted an element of a list or text field; the storage-level `editorOf`. */
  async editorOf(key, index) {
    return this.#storage.editorOf(this.#id, key, index);
  }

  /** A cursor's index and side; the storage-level `position` with this record's id. */
  async position(key, cursor) {
    return this.#storage.position(this.#id, key, cursor);
  }

  /** Watches this record; the storage-level `observe` with this record's id. Returns the function that stops it. */
  observe(path, listener) {
    return this.#storage.observe(this.#id, path, listener);
  }

  /** Replaces an element of a list field; the storage-level `setAt` with this record's id. */
  async setAt(key, index, value, options = {}) {
    await this.#storage.setAt(this.#id, key, index, value, options);
  }

  /** Moves an element of a list field; the storage-level `move` with this record's id. */
  async move(key, from, to, options = {}) {
    await this.#storage.move(this.#id, key, from, to, options);
  }

  /** Puts a node of a tree field under a parent; the storage-level `treeMove` with this record's id. */
  async treeMove(key, node, parent = null, options = {}) {
    await this.#storage.treeMove(this.#id, key, node, parent, options);
  }

  /** Removes a node of a tree field with its subtree; the storage-level `treeRemove` with this record's id. */
  async treeRemove(key, node, options = {}) {
    await this.#storage.treeRemove(this.#id, key, node, options);
  }

  async delete(options = {}) {
    await this.#storage.delete(this.#id, options);
    this.#data = null;
    this.#changes = {};
  }
}

module.exports = { Reference, Document, Record: Document };
