'use strict';

// A Collection: an entity's records, `db.<Entity>` — what the application
// holds for a collection. It uses the database's public API and two of the
// module-private symbols (SOURCE, CURSOR) — nothing below them. The Document
// (a live view of one record) and the Reference live in src/document.js.

const { isPlainObject } = require('./shape.js');
const { SOURCE, CURSOR } = require('./symbols.js');
const { SyncomError } = require('./errors.js');

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
    return this.#storage.document(id);
  }

  /** The record, or null when it is absent or belongs to another collection. */
  async get(id, options = {}) {
    if (this.#foreign(id)) return null;
    return this.#storage.get(id, options);
  }

  /** A cursor over this collection: `select(query).order(f).limit(n).fetch()` — the query plugin's. */
  select(query) {
    return this.#storage[CURSOR](this.#name, query);
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

  async unset(id, fields, options = {}) {
    this.#mine(id);
    return this.#storage.unset(id, fields, options);
  }

  /** The live Document of `id` — of this collection, or `NOT_FOUND`. */
  async document(id) {
    this.#mine(id);
    return this.#storage.document(id);
  }

  /** @deprecated `document()` — the name before the rename. */
  record(id) {
    return this.document(id);
  }
}

module.exports = { Collection };
