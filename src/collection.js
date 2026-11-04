'use strict';

// A Collection: an entity's records, `db.<Entity>` — what the application
// holds for a collection. It writes through the database's public API and
// the `[SOURCE]`/`[CURSOR]` seams (src/symbols.js) — the id its data names
// through `namedId` (src/schema/entity.js), a bulk as one transaction with
// a verdict per row — and nothing below them. The Document (a live view of
// one record) and the Reference live in src/document.js. An emitter
// (src/emitter.js, the events contained through src/hooks.js `notify`):
// `change` (`{ id, action }`), `insert`, `update` and `remove` (`{ id }`)
// from the catalog's action stream, told on a microtask after the landing —
// one listener of the catalog per collection, taken at the first `on()`,
// let go of with the last listener.

const { Emitter } = require('./emitter.js');
const { notify } = require('./hooks.js');
const { isPlainObject, MAX_BATCH } = require('./shape.js');
const { SOURCE, CURSOR } = require('./symbols.js');
const { SyncomError, typed } = require('./errors.js');
const { namedId, idReason } = require('./schema/entity.js');

// A bulk write's rows: an array of at most MAX_BATCH (one transaction).
const list = (method, rows) => {
  if (!Array.isArray(rows)) throw new TypeError(`${method}() takes an array`);
  if (rows.length > MAX_BATCH) {
    throw new TypeError(
      `${method}() takes at most ${MAX_BATCH} rows in one transaction (${rows.length} given): page the batch`,
    );
  }
  return rows;
};

// How many records `remove()` takes in one transaction.
const PAGE = 500;

// A collection with no definition names its records by an `id` field.
const LOOSE = Object.freeze({ id: null, idField: 'id' });

// A row's own verdict — on its data, its id, its collection — as against a failure of the batch
// (the disk, the log, the database closed), which fails the whole write.
const ROW_CODES = new Set([
  'VALIDATION_FAILED',
  'NOT_FOUND',
  'FIELD_KIND',
  'EXISTS',
  'OUT_OF_RANGE',
  'CYCLE',
  'ENCRYPTED',
  'HOOK_FAILED',
  'INVALID_ID',
  'TYPE_IMMUTABLE',
]);
const ownVerdict = (error) => error instanceof TypeError || ROW_CODES.has(error?.code);

class Collection extends Emitter {
  #storage;
  #name;
  // The catalog's subscription while anything listens, and what takes it off; the changes heard and not yet told.
  #unsubscribe = null;
  #queued = [];

  constructor(storage, name) {
    super();
    this.#storage = storage;
    this.#name = name;
    // The collection's `statics`, bound to it, hidden from enumeration.
    const statics = storage[SOURCE].definition(name)?.statics ?? null;
    if (statics !== null) {
      for (const key of Object.keys(statics)) {
        Object.defineProperty(this, key, { value: statics[key].bind(this), enumerable: false, configurable: true });
      }
    }
  }

  get name() {
    return this.#name;
  }

  /** The local documents under this collection's prefix (`<name>.<key>`) — the `local` plugin's. */
  get local() {
    return this.#storage.local.scoped(this.#name);
  }

  // What the catalog says of a record of this collection, heard inside the landing and told on a microtask after
  // it — the row in place by then, the landing never held by a listener: `change` with the action, then the
  // action's own event; contained like every event. The subscription goes once no listener is left.
  #hear(id, action) {
    this.#queued.push(id, action);
    if (this.#queued.length === 2) queueMicrotask(() => this.#tell());
  }

  #tell() {
    const queued = this.#queued;
    this.#queued = [];
    const { logger } = this.#storage;
    for (let i = 0; i < queued.length; i += 2) {
      notify(this, logger, 'change', { id: queued[i], action: queued[i + 1] });
      notify(this, logger, queued[i + 1], { id: queued[i] });
    }
    this.#unlisten();
  }

  #listen() {
    if (this.#unsubscribe !== null) return;
    this.#unsubscribe = this.#storage[SOURCE].subscribe(this.#name, (changed, id, action) => this.#hear(id, action));
  }

  // Nothing listens any more — `off()` of the last, a `once()` that fired — and the catalog's subscription goes.
  #unlisten() {
    if (this.#unsubscribe === null) return;
    const names = this.eventNames();
    for (let i = 0; i < names.length; i++) if (this.listenerCount(names[i]) > 0) return;
    this.#unsubscribe();
    this.#unsubscribe = null;
  }

  on(event, listener) {
    super.on(event, listener);
    this.#listen();
  }

  once(event, listener) {
    super.once(event, listener);
    this.#listen();
  }

  off(event, listener) {
    super.off(event, listener);
    this.#unlisten();
  }

  clear(event) {
    super.clear(event);
    this.#unlisten();
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

  // A record of this collection, as the database writes it.
  #typed(method, data) {
    if (!isPlainObject(data)) throw new TypeError(`${method}() takes a plain object`);
    return { ...data, $type: this.#name };
  }

  // The id a record's data names under this collection's definition — a
  // composite id (its fields stay in the data), or the id field's value (the
  // field leaves it) — with the data to write: `{ id, data }`, as `namedId`
  // derives it for every writer; a TypeError (INVALID_ID) when it names none.
  #named(method, data) {
    const def = this.#storage[SOURCE].definition(this.#name) ?? LOOSE;
    const named = namedId(def, data);
    if (named === null) {
      throw typed('INVALID_ID', `${method}(): a ${this.#name} needs its id under ${def.idField || 'an id field'}`, {
        entity: this.#name,
        field: def.idField || null,
      });
    }
    if (named.id === null) {
      throw typed('INVALID_ID', `${method}(): a ${this.#name} ${idReason(named)}`, {
        entity: this.#name,
        field: named.field,
      });
    }
    return named;
  }

  // The id a row's data names, where it names one and well — for a refused row's report; null otherwise.
  #knownId(data) {
    if (!isPlainObject(data)) return null;
    const named = namedId(this.#storage[SOURCE].definition(this.#name) ?? LOOSE, data);
    return named !== null && named.id !== null ? named.id : null;
  }

  /**
   * Writes a new record of this collection: under the id its data names
   * (the entity's composite id, or its id field — a live record there is
   * `EXISTS`), else under a minted one. Resolves to the record's Document.
   */
  async insert(data, options = {}) {
    const id = await this.#storage.insert(this.#typed('insert', data), options);
    return this.#storage.document(id);
  }

  /**
   * Writes the record its data names (the composite id, or the id field —
   * a TypeError without one) whole, new or not: `set()` by the named id.
   * Resolves to the record's Document.
   */
  async upsert(data, options = {}) {
    const named = this.#named('upsert', this.#typed('upsert', data));
    await this.#storage.set(named.id, named.data, options);
    return this.#storage.document(named.id);
  }

  /**
   * Writes the record its data names unless a live one is there already,
   * decided inside the queue; resolves to the Document either way — the
   * one written, or the one that was there (of this collection, or
   * `NOT_FOUND`).
   */
  async insertIfAbsent(data, options = {}) {
    const { id, data: record } = this.#named('insertIfAbsent', this.#typed('insertIfAbsent', data));
    await this.#storage.transact(
      async (tx) => {
        if (await tx.has(id)) return;
        await tx.set(id, record, { actor: options.actor });
      },
      { actor: options.actor },
    );
    return this.document(id);
  }

  // A bulk write: ONE transaction, a verdict per row — a row refused on its
  // own account (its validator, a unique key, its id, its collection) goes
  // to `error` and the rest go on; a failure of the batch (the disk, the log)
  // throws and nothing lands. Resolves to `{ success, error }` — the ids
  // written, and `{ index, id, data, error }` per refused row.
  async #bulk(method, rows, options, write, idOf) {
    list(method, rows);
    const success = [];
    const error = [];
    try {
      await this.#storage.transact(
        async (tx) => {
          for (let i = 0; i < rows.length; i++) {
            let id = null;
            try {
              id = await write(tx, rows[i]);
            } catch (cause) {
              if (!ownVerdict(cause)) throw cause;
              error.push({ index: i, id: cause.id ?? id ?? idOf(rows[i]), data: rows[i], error: cause });
              continue;
            }
            success.push(id);
          }
        },
        { actor: options.actor, message: options.message },
      );
    } catch (cause) {
      // An afterWrite hook failed AFTER the rows landed: the verdicts are the caller's (the writes are durable), the
      // hook's failure the database's `error` event and a warning — never a rejection that loses which rows went.
      if (cause?.code !== 'HOOK_FAILED' || cause.hook !== 'afterWrite') throw cause;
      const { logger } = this.#storage;
      logger.warn({ event: 'hook.failed', hook: 'afterWrite', method, err: cause });
      notify(this.#storage, logger, 'error', cause);
    }
    const { otel } = this.#storage[SOURCE];
    if (otel.enabled) {
      otel.recordBulk('success', success.length);
      otel.recordBulk('error', error.length);
    }
    return { success, error };
  }

  /** Inserts every row as `insert()` would, as one transaction with a verdict per row. */
  bulkInsert(rows, options = {}) {
    return this.#bulk(
      'bulkInsert',
      rows,
      options,
      async (tx, data) => {
        const record = this.#typed('bulkInsert', data);
        const id = await tx.insert(record, options);
        return id;
      },
      (data) => this.#knownId(data),
    );
  }

  /** Writes every row whole under the id its data names, as one transaction with a verdict per row. */
  bulkUpsert(rows, options = {}) {
    return this.#bulk(
      'bulkUpsert',
      rows,
      options,
      async (tx, data) => {
        const named = this.#named('bulkUpsert', this.#typed('bulkUpsert', data));
        await tx.set(named.id, named.data, options);
        return named.id;
      },
      (data) => this.#knownId(data),
    );
  }

  /** Deletes every id of this collection, as one transaction with a verdict per row: an absent or foreign one is `NOT_FOUND`. */
  bulkRemove(ids, options = {}) {
    return this.#bulk(
      'bulkRemove',
      ids,
      options,
      async (tx, id) => {
        if (typeof id !== 'string') throw new TypeError('bulkRemove() takes ids');
        this.#mine(id);
        if (!(await tx.has(id))) {
          throw new SyncomError('NOT_FOUND', `Record ${id} not found`, { id, entity: this.#name });
        }
        await tx.delete(id, options);
        return id;
      },
      (id) => (typeof id === 'string' ? id : null),
    );
  }

  /**
   * Deletes every record of the collection as it is when the call begins — tombstones that replicate, or with
   * `purge: true` purges scrubbed from the log, every file holding them rewritten once per page — in pages of 500,
   * each page one turn of the queue (an encrypted record, which has no op, is removed on its own); a record written
   * meanwhile stays, one a peer revived is not deleted again. Resolves to how many. The definition stays:
   * `removeCollection()` forgets it. Takes `{ purge, actor }` and nothing else: `remove({ status: 'old' })` is a
   * TypeError, not the collection gone — the matches of a query go through `select(query).delete()`.
   */
  async remove(options = {}) {
    if (!isPlainObject(options)) throw new TypeError('remove() takes an options object: { purge, actor }');
    for (const key of Object.keys(options)) {
      if (key === 'purge' || key === 'actor') continue;
      throw new TypeError(
        `remove() takes { purge, actor } and nothing else (${key} given): the matches of a query go through select(query).delete()`,
      );
    }
    const { purge = false, actor } = options;
    const source = this.#storage[SOURCE];
    // The ids as the call begins (the catalog's list, never edited): the pages come from it.
    const live = source.ids(this.#name);
    let removed = 0;
    let at = 0;
    while (at < live.length) {
      const ids = [];
      const sealed = [];
      for (; at < live.length && ids.length < PAGE; at++) {
        const row = source.row(live[at]);
        if (row === null || row.gone) continue;
        if (row.encrypted) sealed.push(live[at]);
        else ids.push(live[at]);
      }
      for (let i = 0; i < sealed.length; i++) await this.#storage.delete(sealed[i], { actor });
      if (ids.length > 0) {
        if (purge) await source.purgeMany(ids, { actor });
        else {
          await this.#storage.transact(
            async (tx) => {
              for (let i = 0; i < ids.length; i++) await tx.delete(ids[i], { actor });
            },
            { actor },
          );
        }
      }
      removed += ids.length + sealed.length;
    }
    this.#storage.logger.info({ event: 'collection.remove', entity: this.#name, purge, removed });
    return { removed };
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

  /**
   * The records of `ids` that are live and of this collection, as a Map by
   * id — one read of the engine for the ones not cached (`records.getMany`);
   * an id absent, gone or of another collection is left out. To follow a
   * set of ids, `select({ id: { $in: ids } }).watch(...)`.
   */
  async findByIds(ids) {
    if (!Array.isArray(ids)) throw new TypeError('findByIds() takes an array of ids');
    const found = await this.#storage[SOURCE].loadMany(ids);
    const out = new Map();
    for (const [id, data] of found) {
      if (data === null || data.$type !== this.#name) continue;
      out.set(id, JSON.parse(JSON.stringify(data)));
    }
    return out;
  }

  /** The distinct values of `field` among the records matching `query` — the cursor's `distinct()`. */
  distinct(field, query) {
    return this.select(query).distinct(field);
  }

  /** The distinct values of `field` with how many records hold each — the cursor's `countBy()`. */
  countBy(field, query) {
    return this.select(query).countBy(field);
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
    const names = isPlainObject(delta) && (Object.hasOwn(delta, '$type') || Object.hasOwn(delta.$set ?? {}, '$type'));
    if (names) throw new TypeError('$type is immutable; update() may not name it');
    this.#mine(id);
    return this.#storage.update(id, delta, options);
  }

  async unset(id, fields, options = {}) {
    this.#mine(id);
    return this.#storage.unset(id, fields, options);
  }

  /** Changes the record by a function, inside the queue — the database's `modify()` for a record of this collection. */
  async modify(id, fn, options = {}) {
    this.#mine(id);
    return this.#storage.modify(id, fn, options);
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
