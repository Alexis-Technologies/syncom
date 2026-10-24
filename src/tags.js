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
// Order of writes: a tag's catalog, then tags.json, then the registration
// here; an untag moves the copies the older tag needs, then rewrites
// tags.json, then removes the files. A `tags/<name>` left without its line
// in tags.json — a crash in between — is unknown to every reader and is
// emptied when a tag of that name is taken again (fsi lists files, not
// directories, so an open cannot find it).

const { SyncomError } = require('./errors.js');
const { isRecordId } = require('./shape.js');

const FILE = 'tags.json';
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

class Tags {
  #fsi;
  #dir;
  #path;
  #logger;
  #catalogOf;
  #tags = [];
  #byName = new Map();

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

  /** The tags, oldest first — copies. */
  list() {
    return this.#tags.map(info);
  }

  has(name) {
    return this.#byName.has(name);
  }

  info(name) {
    return info(this.#tag(name));
  }

  #tag(name) {
    const tag = this.#byName.get(name);
    if (tag === undefined) throw new SyncomError('TAG_NOT_FOUND', `Tag ${name} not found`, { tag: name });
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

  // Reads tags.json and every tag's catalog and copies.
  async load() {
    const exists = await this.#fsi.exists(this.#path, FILE);
    let parsed = null;
    if (exists) {
      try {
        parsed = JSON.parse(await this.#fsi.read(this.#path, FILE));
      } catch (error) {
        throw new SyncomError('CORRUPT', `${FILE} is unreadable`, { cause: error });
      }
      if (!parsed || parsed.format !== FORMAT || !Array.isArray(parsed.tags)) {
        throw new SyncomError('CORRUPT', `${FILE} is not a tags file`);
      }
    }
    const known = new Set();
    for (const raw of parsed?.tags ?? []) {
      if (!isTag(raw) || known.has(raw.name)) continue;
      // The name is a path segment under tags/: the record-id form `tag()`
      // takes, or the line is dropped — a file is a second way in.
      if (!isRecordId(raw.name)) {
        this.#logger?.warn({ event: 'tags.dropped', name: raw.name, reason: 'name' });
        continue;
      }
      const tag = {
        ...info(raw),
        catalog: this.#catalogOf(`${this.#dir}/${raw.name}`),
        copied: new Set(),
        held: new Set(),
      };
      if ((await tag.catalog.load({ strict: false })) === null) {
        this.#logger?.warn({ event: 'tags.dropped', name: raw.name, reason: 'catalog' });
        continue;
      }
      for (const file of await this.#names(this.#data(tag))) {
        if (file.endsWith('.json')) tag.copied.add(file.slice(0, -5));
      }
      known.add(tag.name);
      this.#tags.push(tag);
      this.#byName.set(tag.name, tag);
    }
    if (known.size !== (parsed?.tags.length ?? 0)) await this.#save();
  }

  async #save() {
    const text = JSON.stringify({ format: FORMAT, tags: this.#tags.map(info) });
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
    };
    tag.catalog.adopt(rows);
    await tag.catalog.save(eventId);
    this.#tags.push(tag);
    this.#byName.set(name, tag);
    try {
      await this.#save();
    } catch (error) {
      this.#tags.pop();
      this.#byName.delete(name);
      throw error;
    }
    return info(tag);
  }

  /**
   * Drops a tag. A copy it holds is the state at the older tag too when the
   * record did not change between them — the older tag has no copy of its
   * own then and existed to have one — so it moves there; the rest go.
   */
  async drop(name) {
    const tag = this.#tag(name);
    const index = this.#tags.indexOf(tag);
    const older = index > 0 ? this.#tags[index - 1] : null;
    const from = this.#data(tag);
    if (older !== null) {
      for (const id of tag.copied) {
        const row = older.catalog.row(id);
        if (row === null || row.gone || older.copied.has(id)) continue;
        await this.#fsi.write(this.#data(older), `${id}.json`, await this.#fsi.read(from, `${id}.json`));
        older.copied.add(id);
      }
    }
    this.#tags.splice(index, 1);
    this.#byName.delete(name);
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
    const tag = this.#tags[this.#tags.length - 1];
    if (tag === undefined || tag.copied.has(id)) return;
    const row = tag.catalog.row(id);
    if (row === null || row.gone) return;
    const text = await file();
    if (text === null) return;
    await this.#fsi.write(this.#data(tag), `${id}.json`, text);
    tag.copied.add(id);
  }

  /** Whether `id` was a live record at the tag — encrypted ones included. */
  hasAt(name, id) {
    const row = this.#tag(name).catalog.row(id);
    return row !== null && !row.gone;
  }

  /** The tag's catalog row of `id`, or null. */
  rowAt(name, id) {
    return this.#tag(name).catalog.row(id);
  }

  /**
   * The record `id` as it was at the tag: `{ exists: false }` when it was
   * not there, else `raw` — the file's text from the first tag that holds a
   * copy, from this one on, or `null` for a record unchanged since (read it
   * as it is).
   */
  async readAt(name, id) {
    const tag = this.#tag(name);
    const row = tag.catalog.row(id);
    if (row === null || row.gone) return { exists: false, raw: null };
    for (let i = this.#tags.indexOf(tag); i < this.#tags.length; i++) {
      const holder = this.#tags[i];
      if (holder.copied.has(id)) return { exists: true, raw: await this.#fsi.read(this.#data(holder), `${id}.json`) };
    }
    return { exists: true, raw: null };
  }

  /** A purge reaches the tags: every copy of `id` goes, and every tag's catalog forgets the row. */
  async scrub(id) {
    for (const tag of this.#tags) {
      if (tag.copied.has(id)) {
        await this.#fsi.remove(this.#data(tag), `${id}.json`);
        tag.copied.delete(id);
      }
      if (tag.catalog.row(id) !== null) {
        tag.catalog.put(id, null);
        await tag.catalog.save(tag.eventId);
      }
    }
  }

  /** The tag's catalog — what a view at the tag reads through. */
  catalogOf(name) {
    return this.#tag(name).catalog;
  }
}

module.exports = { Tags };
