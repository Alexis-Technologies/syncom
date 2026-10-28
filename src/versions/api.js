'use strict';

// The versions API — the versions plugin's (./versions.js) — over the
// `core` Storage lends (Storage#lend): a record at a version
// (`get(id, { at })`), its history, the patches between two versions
// (`diff`) and the way back (`restore`), and the tags (`tag`, `untag`,
// `at`). A version is read out of the log by ./history.js and a tag's copy
// by ./tags.js; the patches are the core's (src/patch.js) and land through
// `applyPatches` (src/patches.js, the core's too: the undo subpath stands on
// it) inside the mutation queue — rehearsed first, so a restore lands whole
// or not at all. The storage keeps one stub per method (`Storage#api`), so
// the public surface stays on the facade and the bodies live here.

const { snapshotPage } = require('../bootstrap.js');
const { isAlive, deepEqual, kindsOf } = require('../ops.js');
const { decompose } = require('../compose.js');
const { parseVersion, within, exactStart, fold, gone } = require('./history.js');
const { opKey } = require('../vector.js');
const { appliedHere } = require('../log.js');
const { diffViews } = require('../patch.js');
const { runHook } = require('../hooks.js');
const { traced } = require('../telemetry/writer.js');
const { asJson, isRecordId, invalidId } = require('../shape.js');
const { SyncomError, typed } = require('../errors.js');
const { sealed, reading, applyPatches } = require('../patches.js');

// The record at a tag, as an entry: its file as it was — the tag's copy,
// or the file as it is when nothing changed it since — parsed; `null`
// when it was not there.
const entryAt = async (core, name, id, again = false) => {
  if (!isRecordId(id)) return null;
  let { exists, raw } = await core.tags.readAt(name, id);
  if (!exists) return null;
  // No copy: nothing landed on the file since the tag. A record held since
  // (a write whose file failed, or one deferred) reads as the file, which
  // is still the tag's state; any other reads as it is.
  if (raw === null && core.entries.held(id)) {
    raw = await core.entries.file(id);
    try {
      return await core.entries.parse(id, raw);
    } catch (error) {
      // A landing was writing the file as it was read (a record file is not
      // written atomically — the log mends a crash): once the landings in
      // flight are down, the tag has its copy, or the file is whole.
      if (again || error?.code !== 'INTEGRITY') throw error;
      await core.landing(() => undefined);
      return entryAt(core, name, id, true);
    }
  }
  return raw === null ? core.entries.load(id) : core.entries.parse(id, raw);
};

// The retained entries of `id` this node applied, oldest first, and the
// seq of its purge when the record is purged (0 when the purge itself is
// no longer retained; `null` when not purged). An encrypted record has no
// past in the log.
const applied = async (core, id) => {
  if (!isRecordId(id)) return { entries: [], purged: null, current: null };
  const current = await core.entries.load(id);
  if (current?.encrypted) throw sealed(id, '; it has no history');
  const logged = core.log.entriesOf(id);
  const entries = [];
  let purge = null;
  for (let i = 0; i < logged.length; i++) {
    const entry = logged[i];
    if (!appliedHere(entry, core.version)) continue;
    entries.push(entry);
    if (purge === null && entry.op.type === 'purge') purge = entry;
  }
  const purged = purge !== null ? purge.seq : current?.meta?.purged ? 0 : null;
  return { entries, purged, current };
};

// Whether the fold of everything retained of `id` reads as the record
// does: when it does not, compaction took something a retained op still
// depends on (a counter incremented across the reset the fold starts at).
const present = async (core, id, folded) => {
  const current = await core.entries.load(id);
  const now = current !== null && isAlive(current) ? current.data : null;
  const then = folded !== null && isAlive(folded) ? folded.data : null;
  return deepEqual(now, then);
};

// The entries of `id` inside `version`, and where to fold them from; null
// when the record was not there (or was purged). Throws HISTORY_GONE when
// the log cannot give the version exactly, INVALID_VERSION for a seq this
// log has not reached.
const past = async (core, id, version) => {
  const { log } = core;
  if (version.kind === 'event') {
    if (version.epoch !== log.epoch) throw gone(id, 'epoch');
    if (version.seq >= log.next) {
      throw typed('INVALID_VERSION', `at: ${log.formatId(version.seq)} is not in this log yet`);
    }
  }
  const { entries, purged, current } = await applied(core, id);
  const inside = [];
  let purgeInside = false;
  let mergeAfter = false;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (within(version, entry)) {
      inside.push(entry);
      if (entry.seq === purged) purgeInside = true;
    }
    if (version.kind === 'stamp' && entry.op.type === 'merge' && entry.op.ts > version.ts) mergeAfter = true;
  }
  if (purged !== null) {
    // After the purge, nothing; before it, nothing readable.
    if (purged === 0 || purgeInside) return null;
    throw gone(id, 'scrubbed');
  }
  if (mergeAfter) throw gone(id, 'merge');
  const droppedTs = log.droppedTs;
  if (inside.length === 0) {
    if (droppedTs === 0 || core.catalog.row(id) === null) return null;
    throw gone(id, 'compacted');
  }
  const { start, exact } = exactStart(inside, droppedTs);
  if (!exact) throw gone(id, 'compacted');
  if (droppedTs > 0) {
    // The whole retained past must read as the present does, or the cut
    // cannot be trusted either.
    const all = fold(entries, exactStart(entries, droppedTs).start, core.limits);
    const last = all.length > 0 ? all[all.length - 1].entry : null;
    if (current === null || !(await present(core, id, last))) throw gone(id, 'compacted');
  }
  return { entries: inside, start };
};

// The entry of `id` at `version` — a tag's copy, or the fold of the log,
// a span (`syncom.version`) when a tracer listens — and how many entries
// the fold ran over; the entry is null when the record was not there.
const versionEntry = async (core, id, version) => {
  if (version.kind === 'tag') return { entry: await entryAt(core, version.name, id), folded: 0 };
  const read = async () => {
    const was = await past(core, id, version);
    if (was === null) return { entry: null, folded: 0 };
    const steps = fold(was.entries, was.start, core.limits);
    return { entry: steps.length > 0 ? steps[steps.length - 1].entry : null, folded: was.entries.length };
  };
  const { otel } = core;
  if (!otel.enabled) return read();
  return traced(otel, 'syncom.version', {}, read, (result) => ({ 'syncom.ops.count': result.folded }));
};

// The entry of `id` at a version — the present when `at` is undefined,
// a tag's copy, or the fold of the log — or null when it was not there.
const entryOf = async (core, id, at) => {
  if (at === undefined) return core.entries.load(id);
  return (await versionEntry(core, id, parseVersion(at))).entry;
};

/**
 * `get(id, { at })`: the record at a version — an event id (as this node
 * held it after that entry), a stamp (every op stamped at or below it),
 * `{ vector }` (every op it covers) or `{ tag }` — folded from the log
 * (src/versions/history.js) or read from the tag's copy, through the lens and the
 * read hooks, which see `at`.
 */
const getAt = async (core, id, at) => {
  const version = parseVersion(at);
  await runHook(core.hooks, 'beforeRead', { id, at });
  const { entry } = await versionEntry(core, id, version);
  const data = await reading(core, id, entry);
  const replaced = await runHook(core.hooks, 'afterRead', { id, at }, data);
  return replaced === undefined ? data : replaced;
};

// What a cursor at a tag reads through: the tag's catalog, and the record
// as it was — lensed, without the read hooks, like the live seam. A tag
// does not change, so there is nothing to watch, and its catalog carries
// no text index. The catalog is read at the first use (`ready`, which
// the Cursor awaits before it reads).
const sourceAt = (core, name) => {
  const { tags } = core;
  const catalog = () => tags.catalogOf(name);
  return {
    logger: core.logger,
    ready: () => tags.ensure(name),
    candidates: (entity, query) => catalog().candidates(entity, query),
    ids: (entity) => catalog().ids(entity),
    row: (id) => catalog().row(id),
    indexed: (entity) => catalog().indexed(entity),
    searches: () => {
      throw new TypeError(`select(): $text is not served at tag ${name}: a tag keeps no text index`);
    },
    subscribe: () => {
      throw new TypeError(`watch(): tag ${name} does not change`);
    },
    load: async (id) => {
      const entry = await entryAt(core, name, id);
      if (entry === null || entry.encrypted || !isAlive(entry)) return null;
      return core.view(id, entry);
    },
  };
};

/**
 * The patches that turn record `id` as it was at `from` into how it is at
 * `to` (the present when omitted): per field by kind — a register's new
 * value, a counter's delta, a set's added and removed elements, a text's
 * or a list's splices, a tree's moves — and a whole-record `write` plus
 * the other kinds made again when a register is gone or a field changed
 * kind. In the terms the application writes (through the lens); a text's
 * marks are not diffed. Raw: no read hooks. Rejects as `get(id, { at })`
 * would for either version; `ENCRYPTED` for an encrypted record.
 */
const diff = async (core, id, from, to) => {
  if (!isRecordId(id)) throw invalidId(id);
  const [was, now] = await Promise.all([entryOf(core, id, from), entryOf(core, id, to)]);
  if (was?.encrypted || now?.encrypted) throw sealed(id);
  // Each reading in the op model's terms: flat, every path a field.
  const live = async (entry) => {
    if (entry === null || !isAlive(entry)) return [null, {}];
    const kinds = kindsOf(entry, core.plugins);
    const flat = decompose(await core.view(id, entry), entry, core.plugins);
    // A field not in the reading — under a member that is not shown — is no field of it.
    for (const field of Object.keys(kinds)) if (!Object.hasOwn(flat, field)) delete kinds[field];
    return [flat, kinds];
  };
  const [[before, beforeKinds], [after, afterKinds]] = await Promise.all([live(was), live(now)]);
  const purged = now?.meta.purged != null;
  const context = { from: { entry: was }, to: { entry: now } };
  return asJson(diffViews(before, beforeKinds, after, afterKinds, { purged, plugins: core.plugins, context }));
};

/**
 * Makes record `id` read as it did at `at` — `diff(id, undefined, at)`
 * applied: new ops that lead back, so the step is a version of its own
 * and merges like any write. Resolves to how many ops it took.
 */
const restore = async (core, id, at, { actor, source = null } = {}) => {
  if (at === undefined) throw new TypeError('restore() takes a version');
  return applyPatches(core, id, await diff(core, id, undefined, at), { actor, source });
};

/**
 * Names the storage as it is now: a tag — `{ name, eventId, seq, ts,
 * vector, createdAt }` — that `at(name)` and `get(id, { at: { tag } })`
 * read records through as they were when it was taken. Kept on this node
 * (tags do not replicate) as the catalog of the moment plus a copy of
 * each record's file made before its first change after the tag; a tag
 * costs nothing per record until the record changes. `name` is a
 * [record id](../guide/storage#custom-identifiers); rejects with
 * `TAG_EXISTS`.
 */
const tag = async (core, name) => {
  if (!isRecordId(name)) throw new TypeError('tag() takes a name of the record-id form');
  // What is in flight lands first (outside the queue), then the deferred
  // files (inside it); what is held after that failed to write.
  await core.drain();
  return core.run(async () => {
    await core.flushDeferred();
    // A record logged but not on disk has no file to copy from: the tag
    // waits for it to land (the next write of it, or the next open).
    const held = core.entries.heldIds();
    if (held.size > 0) {
      const ids = [...held];
      const message = `tag(): ${ids.join(', ')}: logged, but not written; take the tag once they land`;
      throw new SyncomError('UNPERSISTED', message, { ids });
    }
    const rows = core.catalog.rows();
    const take = () =>
      core.tags.take(name, {
        eventId: core.log.lastEventId,
        seq: core.log.next - 1,
        ts: core.log.latestTs,
        vector: core.log.vector,
        rows,
      });
    const { otel } = core;
    if (!otel.enabled) return take();
    return traced(otel, 'syncom.tag', {}, take, () => ({ 'syncom.records': rows.length }));
  });
};

/** Drops a tag; what the next older tag needs of its copies moves there. Rejects with `TAG_NOT_FOUND`. */
const untag = async (core, name) => {
  if (typeof name !== 'string') throw new TypeError('untag() takes a name');
  const drop = () => core.tags.drop(name);
  const { otel } = core;
  return core.run(() => (otel.enabled ? traced(otel, 'syncom.untag', {}, drop, () => ({})) : drop()));
};

/**
 * A view of the storage at tag `name`: the tag's fields plus `get(id)` —
 * the record as it was, through the lens and the read hooks (`at: { tag }`)
 * — and `has(id)`, whether it was a live record then. Throws
 * `TAG_NOT_FOUND` for a tag this node has not; the tag's catalog is read
 * at the view's first read, and a reader of a tag whose catalog is gone is
 * told `TAG_NOT_FOUND` then.
 */
const at = (core, name) => {
  if (typeof name !== 'string') throw new TypeError('at() takes a name');
  const { tags } = core;
  const info = tags.info(name);
  const ready = () => tags.ensure(name);
  const source = sourceAt(core, name);
  const get = (id) => getAt(core, id, { tag: name });
  // What a snapshot page reads: the tag's catalog and entries, under the
  // tag's position — the pages another storage joins to stand at the tag.
  const paging = {
    get catalog() {
      return tags.catalogOf(name);
    },
    log: {
      lastEventId: info.eventId,
      get vector() {
        return { ...info.vector };
      },
    },
    entries: { load: (id) => entryAt(core, name, id) },
    scopeOf: core.scopeOf,
    logger: core.logger,
    otel: core.otel,
  };
  return {
    ...info,
    get,
    has: async (id) => {
      await ready();
      return isRecordId(id) && tags.hasAt(name, id);
    },
    list: async () => {
      await ready();
      return [...tags.catalogOf(name).ids()];
    },
    collection: (entity) => {
      if (!core.entities.has(entity)) throw new TypeError(`collection(): unknown entity ${entity}`);
      return {
        name: entity,
        get: async (id) => {
          if (!isRecordId(id)) return null;
          await ready();
          return tags.rowAt(name, id)?.type === entity ? get(id) : null;
        },
        select: (query) => core.cursor(source, entity, query),
        count: (query) => core.cursor(source, entity, query).count(),
      };
    },
    snapshot: async (options) => {
      await ready();
      return snapshotPage(paging, options);
    },
  };
};

// The storage at a version that is no tag — an event id, a stamp, a vector
// — read out of the log: every record folded to it, the vector of the ops
// within it, and the pages another storage joins to stand there
// (`branch(parent, { from: { at } })`). Exact only while the log retains
// what the version needs: a record compacted past it is HISTORY_GONE on
// the read, and so is a stream cut by compaction with nothing of it inside
// the version — under `retention: 'all'`, never.
const atVersion = (core, given) => {
  const version = parseVersion(given);
  if (version.kind === 'tag') return at(core, version.name);
  const { log } = core;
  if (version.kind === 'event') {
    if (version.epoch !== log.epoch) throw gone(null, 'epoch');
    if (version.seq >= log.next) {
      throw typed('INVALID_VERSION', `at: ${log.formatId(version.seq)} is not in this log yet`);
    }
  }
  // Everything the log retains, from its floor: below it is compacted.
  const retained = log.since(log.formatId(Math.max(0, log.floor - 1))) ?? [];
  const inside = [];
  const streams = new Map();
  const adopted = new Map();
  for (const entry of retained) {
    if (entry.skipped) continue;
    const key = opKey(entry.op);
    const stream = streams.get(key) ?? { within: 0, outside: false };
    if (within(version, entry)) {
      inside.push(entry);
      stream.within = Math.max(stream.within, entry.op.seq);
      if (entry.op.type === 'advance') {
        for (const name of Object.keys(entry.op.vector)) {
          adopted.set(name, Math.max(adopted.get(name) ?? 0, entry.op.vector[name]));
        }
      }
    } else stream.outside = true;
    streams.set(key, stream);
  }
  // The vector at the version: per stream, the newest op inside it among
  // what the log retains; a stream the log holds nothing of was dropped
  // whole below the floor — all of it inside the version; one retained
  // only past the version was cut by compaction: what came before is gone.
  const vector = {};
  const held = log.vector;
  for (const key of Object.keys(held)) {
    const stream = streams.get(key);
    if (stream === undefined) vector[key] = held[key];
    else if (stream.within > 0) vector[key] = stream.within;
    else if (log.floor > 1) throw gone(null, 'compacted');
  }
  for (const [key, seq] of adopted) vector[key] = Math.max(vector[key] ?? 0, seq);
  const last = inside.length > 0 ? inside[inside.length - 1] : null;
  const eventId = version.kind === 'event' ? log.formatId(version.seq) : log.formatId(last === null ? 0 : last.seq);
  const ts = last === null ? 0 : last.op.ts;
  const known = new Set();
  const logged = log.ids();
  for (let i = 0; i < logged.length; i++) known.add(logged[i]);
  const listed = core.catalog.all();
  for (let i = 0; i < listed.length; i++) known.add(listed[i]);
  const ids = [...known].sort();
  // Each record folded once for the view: `has`, `list` and the snapshot's
  // pages ask again and again (a failed fold is asked anew).
  const folded = new Map();
  const load = (id) => {
    let entry = folded.get(id);
    if (entry === undefined) {
      entry = versionEntry(core, id, version).then((result) => result.entry);
      entry.catch(() => folded.delete(id));
      folded.set(id, entry);
    }
    return entry;
  };
  const entries = { load };
  const paging = {
    catalog: { all: () => ids, row: () => null },
    log: { lastEventId: eventId, vector },
    entries,
    scopeOf: core.scopeOf,
    logger: core.logger,
    otel: core.otel,
  };
  const live = async (id) => {
    const entry = isRecordId(id) ? await entries.load(id) : null;
    return entry !== null && isAlive(entry);
  };
  return {
    eventId,
    vector,
    ts,
    at: given,
    get: (id) => getAt(core, id, given),
    has: live,
    list: async () => {
      const out = [];
      for (const id of ids) if (await live(id)) out.push(id);
      return out;
    },
    snapshot: (options) => snapshotPage(paging, options),
  };
};

// The fold and the versions handed out — `folded`, how many entries, for the span.
const versions = async (core, id, limit, cut) => {
  await runHook(core.hooks, 'beforeRead', { id, history: true });
  const { entries, purged } = await applied(core, id);
  const droppedTs = core.log.droppedTs;
  const { start, exact: fromReset } = exactStart(entries, droppedTs);
  const steps = fold(entries, start, core.limits);
  // The fold is whole — each version is the record after its op — but the
  // lens and afterRead run for the versions handed out alone.
  let upto = steps.length;
  if (cut !== null) {
    for (let i = 0; i < steps.length; i++) {
      if (steps[i].logged.seq < cut.seq) continue;
      upto = i;
      break;
    }
  }
  const first = Math.max(0, upto - limit);
  const shown = steps.slice(first, upto);
  const out = [];
  for (const { logged, entry, delta } of shown) {
    const { seq, op, scrubbed } = logged;
    const version = {
      eventId: core.log.formatId(seq),
      seq,
      ts: op.ts,
      origin: op.origin,
      actor: op.actor ?? null,
      message: op.msg ?? null,
      type: op.type,
      fields: Object.keys(delta),
      data: null,
    };
    // Before a purge the payloads are gone: the ops are listed, their
    // content is not.
    if (scrubbed) version.scrubbed = true;
    if (purged === null || seq >= purged) {
      version.data = isAlive(entry) ? asJson(await core.view(id, entry)) : null;
    } else {
      version.fields = [];
      version.scrubbed = true;
    }
    const replaced = await runHook(core.hooks, 'afterRead', { id, at: version.eventId }, version.data);
    if (replaced !== undefined) version.data = replaced;
    out.push(version);
  }
  out.reverse();
  const last = steps.length > 0 ? steps[steps.length - 1].entry : null;
  const exact = fromReset && (await present(core, id, last));
  return { versions: out, complete: droppedTs === 0 && first === 0, exact, folded: entries.length };
};

/**
 * The record's past as this node's log holds it: one version per op of
 * the record this node applied, newest first — `{ eventId, seq, ts,
 * origin, actor, type, fields, data, scrubbed? }`, `data` the record as it
 * read after the op (`null` once deleted) through the lens and `afterRead`,
 * `fields` what the op changed. `exact` says the versions are what this
 * node held (false once compaction took something a retained op still
 * depends on), `complete` that the list reaches the first op the node
 * ever applied to the record (nothing dropped, nothing cut by `limit`).
 * `before`, an event id of this log, pages back: the versions older than
 * it. Rejects with ENCRYPTED for an encrypted record.
 */
const history = async (core, id, { limit = 50, before } = {}) => {
  if (!(Number.isInteger(limit) && limit > 0) && limit !== Infinity) {
    throw new TypeError('history({ limit }) takes a positive integer');
  }
  let cut = null;
  if (before !== undefined) {
    cut = parseVersion(before);
    if (cut.kind !== 'event') throw new TypeError('history({ before }) takes an event id');
    if (cut.epoch !== core.log.epoch) throw gone(id, 'epoch');
  }
  const read = () => versions(core, id, limit, cut);
  const { otel } = core;
  const after = (result) => ({
    'syncom.ops.count': result.folded,
    'syncom.versions': result.versions.length,
    'syncom.exact': result.exact,
  });
  const { folded, ...result } = otel.enabled ? await traced(otel, 'syncom.history', {}, read, after) : await read();
  return result;
};

module.exports = { getAt, diff, restore, tag, untag, at, atVersion, history };
