'use strict';

// The MongoDB adapter (@alexify/syncom/connector/mongodb): the handlers
// `replicate()` takes, over one collection of the driver's (injected, as the
// engine takes its client). A document of the collection is the record's data
// with three fields of the adapter's: `_rev` (a count of its writes — the
// compare-and-set a push checks against), `_deleted` (a tombstone, so a pull
// sees a deletion) and `_updated` (the position: a pull is the documents
// `_updated` after the checkpoint, in that order, the checkpoint the last
// one's `_updated`; two writes in one millisecond are read again at the next
// pull — an equal document makes no op). The stream is a change stream on
// the collection, every change a `RESYNC` (a replica set; `changes: false`
// without one). A push is a `replaceOne` per row matched on the `_rev` this
// adapter last saw — none matched, nothing upserted, is a conflict, answered
// as the document stands. No requires.

const FIELDS = new Set(['_id', '_rev', '_deleted', '_updated']);

const strip = (doc) => {
  const data = {};
  for (const key of Object.keys(doc)) if (!FIELDS.has(key)) data[key] = doc[key];
  return data;
};

const documentOf = (doc) => {
  const id = String(doc._id);
  return doc._deleted === true ? { id, deleted: true } : { id, data: strip(doc) };
};

/** `{ pull, push }` for `replicate()`, over the driver's `collection`. */
const mongodb = ({ collection, changes = true, now = Date.now } = {}) => {
  const driver =
    collection !== null &&
    typeof collection === 'object' &&
    typeof collection.replaceOne === 'function' &&
    typeof collection.findOne === 'function';
  if (!driver) throw new TypeError("mongodb(): collection must be the driver's collection (find, replaceOne, findOne)");
  if (typeof changes !== 'boolean') throw new TypeError('mongodb(): changes must be a boolean');
  const revs = new Map();

  return {
    pull: {
      async handler(checkpoint, batchSize) {
        const since = typeof checkpoint === 'number' ? checkpoint : 0;
        // oxlint-disable-next-line no-restricted-properties -- the driver's find, not an array's
        const cursor = collection.find({ _updated: { $gt: since } }, { sort: { _updated: 1 }, limit: batchSize });
        const docs = await cursor.toArray();
        const documents = [];
        let last = since;
        for (let i = 0; i < docs.length; i++) {
          const doc = docs[i];
          if (typeof doc._rev === 'number') revs.set(String(doc._id), doc._rev);
          if (typeof doc._updated === 'number' && doc._updated > last) last = doc._updated;
          documents.push(documentOf(doc));
        }
        return { documents, checkpoint: last };
      },
      ...(changes
        ? {
            stream(emit) {
              const stream = collection.watch();
              let stopped = false;
              const over = () => {
                if (stopped) return;
                stopped = true;
                try {
                  stream.close()?.catch?.(() => {});
                } catch {
                  // Closed already.
                }
              };
              stream.on('change', () => emit('RESYNC'));
              stream.on('error', over);
              stream.on('close', over);
              return over;
            },
          }
        : {}),
    },
    push: {
      async handler(rows) {
        const conflicts = [];
        for (let i = 0; i < rows.length; i++) {
          const row = rows[i];
          const held = revs.get(row.id);
          const next = (held ?? 0) + 1;
          const doc = { _id: row.id, _rev: next, _updated: now(), ...(row.deleted ? { _deleted: true } : row.data) };
          // Matched on the revision last seen; a document never seen is made, and one that is there collides.
          const filter = held === undefined ? { _id: row.id, _rev: { $exists: false } } : { _id: row.id, _rev: held };
          let result;
          try {
            result = await collection.replaceOne(filter, doc, { upsert: held === undefined });
          } catch (error) {
            // An upsert on an `_id` another holds: the duplicate key is the conflict.
            if (error?.code !== 11000) throw error;
            result = { matchedCount: 0, upsertedCount: 0 };
          }
          if (result.matchedCount > 0 || result.upsertedCount > 0) {
            revs.set(row.id, next);
            continue;
          }
          const current = await collection.findOne({ _id: row.id });
          if (current === null) {
            revs.delete(row.id);
            conflicts.push({ id: row.id, deleted: true });
            continue;
          }
          if (typeof current._rev === 'number') revs.set(row.id, current._rev);
          conflicts.push(documentOf(current));
        }
        return conflicts;
      },
    },
    /** The revision this adapter last saw for a document, or undefined. */
    revisionOf: (id) => revs.get(id),
  };
};

module.exports = { mongodb };
