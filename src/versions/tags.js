'use strict';

// Named versions of the whole storage, kept on this node alone. A tag
// names the log position it was taken at and keeps the record files as
// they were then, copy-on-write: the first change of a record after the
// newest tag copies the file into that tag first. Reading a record at a
// tag walks the tags from it to the newest for a copy and falls through to
// the record as it is — a record unchanged since the tag is its own copy —
// and the tag's own catalog, taken with it, says what existed then. A copy
// lands in the newest tag only: had the record changed between two tags, the
// older one took its copy when it was the newest. Tags do not replicate.
//
// Layout under `<path>/`:
//   tags.json                      { format: 1, tags: [{ name, eventId, seq, ts, vector, createdAt }] }, oldest first
//   tags/<name>/index/catalog.json the catalog as of the tag (src/catalog.js), stamp = eventId
//   tags/<name>/data/<id>.json     a record's file as it was at the tag, copied before its first change
//
// An open reads tags.json and the newest tag — the one the write path
// copies into; an older tag's catalog, and the ids of its copies, are read
// when the tag is first read, once (`#catalog`, `#copies`), so an open
// costs one catalog however many tags there are. A tag whose catalog
// cannot be read is dropped then — the newest at open — with a warning.
//
// Order of writes: a tag's catalog, then tags.json, then the registration
// here; an untag moves the copies the older tag needs, then rewrites
// tags.json, then removes the files. A `tags/<name>` left without its line
// in tags.json — a crash in between — is unknown to every reader and is
// emptied when a tag of that name is taken again (fsi lists files, not
// directories, so an open cannot find it).

const { SyncomError } = require('../errors.js');
const { isRecordId } = require('../shape.js');

const FILE = 'tags.json';
// Where an unreadable tags.json is kept for a repair by hand, and where the
// copies made while it was unreadable wait (`.pending` is no record id, so
// no tag can be named so).
const CORRUPT_FILE = 'tags.corrupt.json';
const PENDING = '.pending';
const FORMAT = 1;

const isTag = (value) =>
  value !== null &&
  typeof value === 'object' &&
  typeof value.name === 'string' &&
  typeof value.eventId === 'string' &&
  Number.isInteger(value.seq) &&
  typeof value.ts === 'number' &&
  value.vector !== null &&
  typeof value.vector === 'object' &&
  typeof value.createdAt === 'number';

const info = ({ name, eventId, seq, ts, vector, createdAt }) => ({
  name,
  eventId,
  seq,
  ts,
  vector: { ...vector },
  createdAt,
});

const notFound = (name, rest = '') => new SyncomError('TAG_NOT_FOUND', `Tag ${name} not found${rest}`, { tag: name });

class Tags {
  #fsi;
  #dir;
  #path;
  #logger;
  #catalogOf;
  #tags = [];
  #byName = new Map();
  // tags.json could not be read: the storage runs without tags, the file is
  // kept aside, take() refuses, and the copy-on-write seam keeps every
  // changed record's file under tags/.pending for the tag a repair brings back.
  #corrupt = false;
  #pending = new Set();

  // `catalogOf(path)` builds a Catalog rooted at `path` — one per tag, under
  // the storage's own entity definitions.
  constructor({ fsi, path, logger, catalogOf }) {
    this.#fsi = fsi;
    this.#path = path;
    this.#dir = `${path}/tags`;
    this.#logger = logger;
    this.#catalogOf = catalogOf;
  }

  get size() {
    return this.#tags.length;
  }

  /** Whether tags.json could not be read at open: no tags, `take()` refused until it is repaired. */
  get corrupt() {
    return this.#corrupt;
  }

  get #pendingDir() {
    return `${this.#dir}/${PENDING}/data`;
  }

  /** The tags, oldest first — copies. */
  list() {
    const tags = [];
    for (let i = 0; i < this.#tags.length; i++) tags.push(info(this.#tags[i]));
    return tags;
  }

  has(name) {
    return this.#byName.has(name);
  }

  info(name) {
    return info(this.#tag(name));
  }

  #tag(name) {
    const tag = this.#byName.get(name);
    if (tag === undefined) throw notFound(name);
    return tag;
  }

  #data(tag) {
    return `${this.#dir}/${tag.name}/data`;
  }

  async #names(dir) {
    try {
      return await this.#fsi.list(dir);
    } catch {
      return [];
    }
  }

  // Reads tags.json, and the newest tag (its catalog and copies: the write
  // path copies into it, and the pending copies go to it). A tags.json that
  // cannot be read does not stop the open: the tags are auxiliary (the
  // records, the log and the catalog are whole), and their names cannot be
  // listed back from the disk — fsi lists files, not directories — so the
  // file is kept aside for a repair by hand, and nothing here overwrites it.
  async load() {
    const exists = await this.#fsi.exists(this.#path, FILE);
    let parsed = null;
    if (exists) {
      let text = null;
      try {
        text = await this.#fsi.read(this.#path, FILE);
        parsed = JSON.parse(text);
      } catch (error) {
        return this.#unreadable(text, error);
      }
      if (!parsed || parsed.format !== FORMAT || !Array.isArray(parsed.tags)) return this.#unreadable(text, null);
    }
    const lines = parsed?.tags ?? [];
    for (const raw of lines) {
      if (!isTag(raw) || this.#byName.has(raw.name)) continue;
      // The name is a path segment under tags/: the record-id form `tag()`
      // takes, or the line is dropped — a file is a second way in.
      if (!isRecordId(raw.name)) {
        this.#logger?.warn({ event: 'tags.dropped', name: raw.name, reason: 'name' });
        continue;
      }
      const tag = { ...info(raw), catalog: null, copied: null, loading: null, listing: null };
      this.#tags.push(tag);
      this.#byName.set(tag.name, tag);
    }
    // The newest tag now, or the next one when its catalog is gone.
    while (this.#tags.length > 0) {
      const newest = this.#tags[this.#tags.length - 1];
      try {
        await this.#catalog(newest);
        await this.#copies(newest);
        break;
      } catch (error) {
        if (error.code !== 'TAG_NOT_FOUND') throw error;
      }
    }
    await this.#adoptPending();
    if (this.#tags.length !== lines.length) await this.#save();
  }

  // A tag's catalog, read once, at its first use; a tag whose catalog
  // cannot be read is dropped — the line out of tags.json, a warning — and
  // the reader is told TAG_NOT_FOUND. Concurrent first readers share the one load.
  #catalog(tag) {
    if (tag.catalog !== null) return Promise.resolve(tag.catalog);
    return (tag.loading ??= this.#loadCatalog(tag));
  }

  async #loadCatalog(tag) {
    const catalog = this.#catalogOf(`${this.#dir}/${tag.name}`);
    if ((await catalog.load({ strict: false })) === null) {
      // Dropped as an untag drops: what the older tag needs of its copies
      // moves there (it was the newest then, and reads the write path from
      // now on), the rest go with the line.
      this.#logger?.warn({ event: 'tags.dropped', name: tag.name, reason: 'catalog' });
      const index = this.#tags.indexOf(tag);
      const older = index > 0 ? this.#tags[index - 1] : null;
      this.#forget(tag);
      if (older !== null) {
        try {
          await this.#moveDown(tag, older);
        } catch (error) {
          if (error.code !== 'TAG_NOT_FOUND') throw error;
        }
      }
      await this.#save();
      await this.#erase(tag.name);
      throw notFound(tag.name, ': its catalog could not be read, and the tag is dropped');
    }
    tag.catalog = catalog;
    return catalog;
  }

  // A copy `tag` holds is the state at `older` too when the record did not
  // change between them — `older` has no copy of its own then and existed to
  // have one — so it moves there. Reads `older` when it was not yet.
  async #moveDown(tag, older) {
    const [copied, catalog, held] = await Promise.all([this.#copies(tag), this.#catalog(older), this.#copies(older)]);
    const from = this.#data(tag);
    for (const id of copied) {
      const row = catalog.row(id);
      if (row === null || row.gone || held.has(id)) continue;
      await this.#fsi.write(this.#data(older), `${id}.json`, await this.#fsi.read(from, `${id}.json`));
      held.add(id);
    }
  }

  // The ids a tag holds a copy of, listed once, at the first read that walks through it.
  #copies(tag) {
    if (tag.copied !== null) return Promise.resolve(tag.copied);
    return (tag.listing ??= this.#loadCopies(tag));
  }

  async #loadCopies(tag) {
    const copied = new Set();
    for (const file of await this.#names(this.#data(tag))) {
      if (file.endsWith('.json')) copied.add(file.slice(0, -5));
    }
    tag.copied = copied;
    return copied;
  }

  #forget(tag) {
    const index = this.#tags.indexOf(tag);
    if (index !== -1) this.#tags.splice(index, 1);
    this.#byName.delete(tag.name);
  }

  /** Reads the tag's catalog if it is not read yet — ahead of `hasAt`, `rowAt`, `catalogOf`. Rejects with `TAG_NOT_FOUND`. */
  async ensure(name) {
    await this.#catalog(this.#tag(name));
  }

  async #unreadable(text, cause) {
    this.#corrupt = true;
    const event = { event: 'tags.unreadable', file: FILE, kept: CORRUPT_FILE };
    if (cause !== null) event.err = cause;
    this.#logger?.warn(event);
    if (text !== null) await this.#fsi.write(this.#path, CORRUPT_FILE, text);
    for (const name of await this.#names(this.#pendingDir)) {
      if (name.endsWith('.json')) this.#pending.add(name.slice(0, -5));
    }
  }

  // Copies kept aside while tags.json was unreadable: each goes to the
  // newest tag when it holds the record live and has no copy of it yet —
  // the state before the record's first change after the tag, as
  // copyBefore would have kept it — and goes away otherwise.
  async #adoptPending() {
    const names = await this.#names(this.#pendingDir);
    const newest = this.#tags[this.#tags.length - 1];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const id = name.slice(0, -5);
      const row = newest === undefined ? null : newest.catalog.row(id);
      if (row !== null && !row.gone && !newest.copied.has(id)) {
        await this.#fsi.write(this.#data(newest), name, await this.#fsi.read(this.#pendingDir, name));
        newest.copied.add(id);
      }
      await this.#fsi.remove(this.#pendingDir, name);
    }
  }

  // While tags.json is unreadable: the file as it is, kept aside once per
  // record, for the newest tag of a repaired file.
  async #keepAside(id, file) {
    if (this.#pending.has(id)) return;
    const text = await file();
    if (text === null) return;
    await this.#fsi.write(this.#pendingDir, `${id}.json`, text);
    this.#pending.add(id);
  }

  async #save() {
    const text = JSON.stringify({ format: FORMAT, tags: this.list() });
    await this.#fsi.write(this.#path, FILE, text);
  }

  // Every file of a tag directory; the directories stay (fsi has no rmdir).
  async #erase(name) {
    const data = `${this.#dir}/${name}/data`;
    for (const file of await this.#names(data)) await this.#fsi.remove(data, file);
    const index = `${this.#dir}/${name}/index`;
    for (const file of await this.#names(index)) await this.#fsi.remove(index, file);
  }

  /**
   * Takes a tag: the catalog's rows as they are now become the tag's
   * catalog, saved under the log position; then the tag is written to
   * tags.json and known here. Called inside the mutation queue, so no write
   * lands between the rows and the position.
   */
  async take(name, { eventId, seq, ts, vector, rows }) {
    if (this.#corrupt) {
      const message = `${FILE} is unreadable; repair or remove it (a copy is in ${CORRUPT_FILE}) before taking a tag`;
      throw new SyncomError('CORRUPT', message, { file: FILE });
    }
    if (this.#byName.has(name)) throw new SyncomError('TAG_EXISTS', `Tag ${name} exists`, { tag: name });
    // Whatever a crash left under this name goes first: a stale copy would
    // read as this tag's.
    await this.#erase(name);
    const tag = {
      name,
      eventId,
      seq,
      ts,
      vector: { ...vector },
      createdAt: Date.now(),
      catalog: this.#catalogOf(`${this.#dir}/${name}`),
      copied: new Set(),
      loading: null,
      listing: null,
    };
    tag.catalog.adopt(rows);
    await tag.catalog.save(eventId);
    this.#tags.push(tag);
    this.#byName.set(name, tag);
    try {
      await this.#save();
    } catch (error) {
      this.#forget(tag);
      throw error;
    }
    return info(tag);
  }

  /**
   * Drops a tag: what the next older tag needs of its copies moves there
   * (`#moveDown`; the older tag is read here when it was not yet — the
   * newest after this drop, it serves the write path from now on), the
   * rest go.
   */
  async drop(name) {
    const tag = this.#tag(name);
    const index = this.#tags.indexOf(tag);
    const older = index > 0 ? this.#tags[index - 1] : null;
    if (older !== null) await this.#moveDown(tag, older);
    this.#forget(tag);
    await this.#save();
    await this.#erase(name);
  }

  /**
   * Before a record's file changes: when the newest tag has no copy of it
   * yet and the record existed at the tag, the file as it is — `file()`,
   * null when there is none — goes into the tag first. A record held since
   * the tag (a write whose file failed) still has the tag's state on disk:
   * nothing landed on the file after the tag, or the copy would be here.
   */
  async copyBefore(id, file) {
    if (this.#corrupt) return this.#keepAside(id, file);
    const tag = this.#tags[this.#tags.length - 1];
    if (tag === undefined) return;
    // The newest tag is read at open, at take() and at the drop that made
    // it the newest: these resolve at once.
    const [catalog, copied] = await Promise.all([this.#catalog(tag), this.#copies(tag)]);
    if (copied.has(id)) return;
    const row = catalog.row(id);
    if (row === null || row.gone) return;
    const text = await file();
    if (text === null) return;
    await this.#fsi.write(this.#data(tag), `${id}.json`, text);
    copied.add(id);
  }

  /** Whether `id` was a live record at the tag — encrypted ones included. After `ensure(name)`. */
  hasAt(name, id) {
    const row = this.catalogOf(name).row(id);
    return row !== null && !row.gone;
  }

  /** The tag's catalog row of `id`, or null. After `ensure(name)`. */
  rowAt(name, id) {
    return this.catalogOf(name).row(id);
  }

  /**
   * The record `id` as it was at the tag: `{ exists: false }` when it was
   * not there, else `raw` — the file's text from the first tag that holds a
   * copy, from this one on, or `null` for a record unchanged since (read it
   * as it is).
   */
  async readAt(name, id) {
    const tag = this.#tag(name);
    const catalog = await this.#catalog(tag);
    const row = catalog.row(id);
    if (row === null || row.gone) return { exists: false, raw: null };
    for (let i = this.#tags.indexOf(tag); i < this.#tags.length; i++) {
      const holder = this.#tags[i];
      const copied = await this.#copies(holder);
      if (copied.has(id)) return { exists: true, raw: await this.#fsi.read(this.#data(holder), `${id}.json`) };
    }
    return { exists: true, raw: null };
  }

  /**
   * A purge reaches the tags: every copy of `id` goes — one kept aside too —
   * and every tag's catalog forgets the row; a purge reads every tag.
   */
  async scrub(id) {
    if (this.#pending.has(id)) {
      await this.#fsi.remove(this.#pendingDir, `${id}.json`);
      this.#pending.delete(id);
    }
    for (const tag of [...this.#tags]) {
      let copied;
      let catalog;
      try {
        [copied, catalog] = await Promise.all([this.#copies(tag), this.#catalog(tag)]);
      } catch (error) {
        // A tag dropped for its catalog has nothing to forget; its copies went with it.
        if (error.code !== 'TAG_NOT_FOUND') throw error;
        continue;
      }
      if (copied.has(id)) {
        await this.#fsi.remove(this.#data(tag), `${id}.json`);
        copied.delete(id);
      }
      if (catalog.row(id) !== null) {
        catalog.put(id, null);
        await catalog.save(tag.eventId);
      }
    }
  }

  /** The tag's catalog — what a view at the tag reads through. After `ensure(name)`. */
  catalogOf(name) {
    const tag = this.#tag(name);
    if (tag.catalog === null) throw new TypeError(`Tag ${name}: ensure() first — its catalog is not read yet`);
    return tag.catalog;
  }
}

module.exports = { Tags };
