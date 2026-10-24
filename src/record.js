'use strict';

// What a storage hands the application: a Record (a live view of one record
// that saves through the storage), a Reference (a record named by another's
// field) and a Collection (an entity's records). They use the storage's
// public API and the three module-private symbols — nothing below them.

const { Emitter } = require('./emitter.js');
const { notify } = require('./hooks.js');
const { Cursor } = require('./query.js');
const { isPlainObject } = require('./shape.js');
const { COMMIT, REFRESH, SOURCE } = require('./symbols.js');
const { SyncomError } = require('./errors.js');

class Reference {
  #id;
  #storage = null;

  constructor(id, storage) {
    this.#id = id;
    this.#storage = storage;
  }

  async record() {
    return await this.#storage.record(this.#id);
  }
}

class Record extends Emitter {
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

  #convertToReferences(data) {
    if (!data || typeof data !== 'object') return;
    for (const key in data) {
      const value = data[key];
      if (typeof value === 'string') {
        if (this.#storage.hasRecord(value)) {
          data[key] = new Reference(value, this.#storage);
        }
      } else if (value && typeof value === 'object') {
        const isReference = value instanceof Reference;
        if (!isReference) {
          this.#convertToReferences(value);
        }
      }
    }
  }

  get id() {
    return this.#id;
  }

  #defineProperties() {
    for (const key in this.#data) {
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
  [REFRESH](data, delta, source) {
    if (data === null) {
      this.#data = null;
      this.#changes = {};
      if (source !== this) notify(this, this.#storage.logger, 'update', null, delta);
      return;
    }
    this.#adopt(data);
    for (const key in this.#changes) this.#data[key] = this.#changes[key];
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

  /** The text field as runs of equal style; the storage-level `spans` with this record's id. */
  async spans(key) {
    return this.#storage.spans(this.#id, key);
  }

  /** A cursor into a list or text field; the storage-level `cursor` with this record's id. */
  async cursor(key, index, options = {}) {
    return this.#storage.cursor(this.#id, key, index, options);
  }

  /** Where a cursor is now; the storage-level `index` with this record's id. */
  async index(key, cursor) {
    return this.#storage.index(this.#id, key, cursor);
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

class Collection {
  #storage;
  #name;

  constructor(storage, name) {
    this.#storage = storage;
    this.#name = name;
  }

  get name() {
    return this.#name;
  }

  // A live record of another collection (or of none): what the catalog says
  // of `id`. An unknown id is not foreign — it is simply absent.
  #foreign(id) {
    const row = this.#storage[SOURCE].row(id);
    return row !== null && !row.gone && row.type !== this.#name;
  }

  #mine(id) {
    if (this.#foreign(id)) {
      throw new SyncomError('NOT_FOUND', `Record ${id} is not a ${this.#name}`, { id, entity: this.#name });
    }
  }

  async insert(data, options = {}) {
    const record = { ...data, $type: this.#name };
    const id = await this.#storage.insert(record, options);
    return this.#storage.record(id);
  }

  /** The record, or null when it is absent or belongs to another collection. */
  async get(id) {
    if (this.#foreign(id)) return null;
    return this.#storage.get(id);
  }

  /** A cursor over this collection: `select(query).order(f).limit(n).fetch()`. */
  select(query) {
    return new Cursor(this.#storage[SOURCE], this.#name, query);
  }

  /** How many records of this collection match `query`. */
  count(query) {
    return this.select(query).count();
  }

  /** Replaces the record wholesale, stamped as this collection's. */
  async set(id, data, options) {
    if (!isPlainObject(data)) throw new TypeError('set() takes a plain object');
    return this.#storage.set(id, { ...data, $type: this.#name }, options);
  }

  async delete(id, options = {}) {
    this.#mine(id);
    return this.#storage.delete(id, options);
  }

  async update(id, delta, options = {}) {
    if (isPlainObject(delta) && Object.hasOwn(delta, '$type')) {
      throw new TypeError('$type is immutable; update() may not name it');
    }
    this.#mine(id);
    return this.#storage.update(id, delta, options);
  }

  async record(id) {
    this.#mine(id);
    return this.#storage.record(id);
  }
}

module.exports = { Reference, Record, Collection };
