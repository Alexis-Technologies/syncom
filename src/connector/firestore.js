'use strict';

// The Firestore adapter (@alexify/syncom/connector/firestore): the handlers
// `replicate()` takes, over one collection reached through the injected
// modular SDK — `firebase/firestore` handed in whole as `sdk`: the adapter
// calls its `query`, `orderBy`, `limit`, `startAfter`, `documentId`,
// `getDocs`, `doc`, `runTransaction`, `serverTimestamp`, `Timestamp` and
// `onSnapshot`, and ships none of them. A document carries two fields of the
// adapter's: the stamp the server sets on every write (`stampField`,
// `serverTimestamp`) and a tombstone (`deletedField`, `_deleted`), so a pull
// sees a deletion. A pull is the documents ordered by the stamp, then by id,
// after the checkpoint `{ at, id }` — one cursor, no second query for the
// ties; a document whose stamp is still pending (a write of the SDK's own
// cache not yet on the server) is left to the next pull. A push is a
// transaction per CHUNK rows (Firestore's limit on a transaction's writes):
// every document read, compared with what its row assumed, written where it
// is the same and answered as a conflict where it is not — the transaction's
// own reads and writes, so a write landing between them makes Firestore run
// it again; a probe (`assumed` undefined) is the document as it stands,
// nothing written; an id or a body the SDK refuses is that row's
// `{ id, error }`. The stream is `onSnapshot` over the newest document, every
// change the server confirmed a `RESYNC`, its error an `END`. With `lookback`
// ms a pull run starts that far before its checkpoint — a document stamped
// behind it by a writer that sets the stamp field itself is pulled after all
// (lookback.js). Requires same.js, lookback.js only.

const { same } = require('./same.js');
const { checkLookback, lookbackPull } = require('./lookback.js');

const CALLS = [
  'query',
  'orderBy',
  'limit',
  'startAfter',
  'documentId',
  'getDocs',
  'doc',
  'runTransaction',
  'serverTimestamp',
];
// The most writes one Firestore transaction takes.
const CHUNK = 500;

const field = (name, value) => {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`firestore(): ${name} must be a field name`);
};

const refused = (id, error) => ({
  id,
  error: { code: String(error?.code ?? 'refused'), message: error?.message ?? '' },
});

/**
 * `{ pull, push }` for `replicate()`. `sdk` is `firebase/firestore`,
 * `database` its `Firestore`, `collection` a `CollectionReference`;
 * `stampField` (`serverTimestamp`) and `deletedField` (`_deleted`) name the
 * adapter's fields on every document; `stream: false` for no `onSnapshot`;
 * `lookback` the milliseconds a pull run starts before its checkpoint (0: none).
 */
const firestore = ({
  sdk,
  database,
  collection,
  stampField = 'serverTimestamp',
  deletedField = '_deleted',
  stream = true,
  lookback = 0,
} = {}) => {
  if (sdk === null || typeof sdk !== 'object') {
    throw new TypeError('firestore(): sdk must be the firebase/firestore module');
  }
  for (let i = 0; i < CALLS.length; i++) {
    if (typeof sdk[CALLS[i]] !== 'function') throw new TypeError(`firestore(): sdk.${CALLS[i]} must be a function`);
  }
  if (typeof sdk.Timestamp !== 'function' || typeof sdk.Timestamp.fromMillis !== 'function') {
    throw new TypeError('firestore(): sdk.Timestamp is required');
  }
  if (database === undefined || database === null) throw new TypeError('firestore(): database is required');
  if (collection === undefined || collection === null) throw new TypeError('firestore(): collection is required');
  field('stampField', stampField);
  field('deletedField', deletedField);
  if (typeof stream !== 'boolean') throw new TypeError('firestore(): stream must be a boolean');
  checkLookback('firestore', lookback);
  if (stream && typeof sdk.onSnapshot !== 'function') throw new TypeError('firestore(): sdk.onSnapshot is required');

  const strip = (data) => {
    const out = {};
    for (const key of Object.keys(data)) if (key !== stampField && key !== deletedField) out[key] = data[key];
    return out;
  };
  // What the collection holds of a document: its data, or null for none or a tombstone.
  const held = (snap) => {
    if (!snap.exists()) return null;
    const data = snap.data();
    return data[deletedField] === true ? null : strip(data);
  };
  // A stamp as the server set it — `{ seconds, nanoseconds }`, whole: milliseconds would skip or repeat the rest of a
  // commit's documents at a page's edge — or null for one still pending.
  const stampOf = (value) => {
    if (typeof value?.seconds === 'number' && typeof value.nanoseconds === 'number') {
      return { seconds: value.seconds, nanoseconds: value.nanoseconds };
    }
    if (typeof value?.toMillis === 'function') return stampOf(sdk.Timestamp.fromMillis(value.toMillis()));
    return null;
  };
  // A checkpoint's position: `{ seconds, nanoseconds, id }`, or the older `{ at, id }` in milliseconds.
  const parse = (value) => {
    if (value === null || typeof value !== 'object' || typeof value.id !== 'string') return null;
    if (typeof value.seconds === 'number' && typeof value.nanoseconds === 'number') {
      return { seconds: value.seconds, nanoseconds: value.nanoseconds, id: value.id };
    }
    return typeof value.at === 'number' ? { ...stampOf(sdk.Timestamp.fromMillis(value.at)), id: value.id } : null;
  };
  // The documents after a position, in the cursor's order — by the stamp, then by id: one cursor, no second query
  // for the ties; a position with no id (a lookback's start) is the stamp alone.
  const read = async (after, limit) => {
    const byStamp = sdk.orderBy(stampField);
    const byId = sdk.orderBy(sdk.documentId());
    const page = sdk.limit(limit);
    if (after === null) return (await sdk.getDocs(sdk.query(collection, byStamp, byId, page))).docs;
    const stamp = new sdk.Timestamp(after.seconds, after.nanoseconds);
    const cursor = after.id === null ? sdk.startAfter(stamp) : sdk.startAfter(stamp, after.id);
    return (await sdk.getDocs(sdk.query(collection, byStamp, byId, cursor, page))).docs;
  };
  // A stamp the server has not set yet (the SDK's own pending write) has no position: left to the next pull.
  const positionOf = (snap) => {
    const stamp = stampOf(snap.data()[stampField]);
    return stamp === null ? null : { ...stamp, id: snap.id };
  };
  const documentOf = (snap) => {
    const data = snap.data();
    if (stampOf(data[stampField]) === null) return null;
    return data[deletedField] === true ? { id: snap.id, deleted: true } : { id: snap.id, data: strip(data) };
  };
  const pull =
    lookback > 0
      ? lookbackPull({
          lookback,
          parse,
          millis: (position) => position.seconds * 1000 + position.nanoseconds / 1e6,
          since: (ms) => ({ ...stampOf(sdk.Timestamp.fromMillis(Math.max(ms, 0))), id: null }),
          read,
          positionOf,
          documentOf,
        })
      : async (checkpoint, batchSize) => {
          const after = parse(checkpoint);
          const snaps = await read(after, batchSize);
          const documents = [];
          let last = after === null ? null : checkpoint;
          for (let i = 0; i < snaps.length; i++) {
            const document = documentOf(snaps[i]);
            if (document === null) continue;
            documents.push(document);
            last = positionOf(snaps[i]);
          }
          return { documents, checkpoint: last };
        };

  // One transaction over `rows`: the answers for them (conflicts, refusals).
  const transact = async (rows) => {
    let answers = [];
    await sdk.runTransaction(database, async (tx) => {
      // Run again by Firestore when a read moved under it: begun afresh.
      answers = [];
      const refs = [];
      const snaps = [];
      for (let i = 0; i < rows.length; i++) {
        try {
          refs.push(sdk.doc(collection, rows[i].id));
        } catch (error) {
          // An id the SDK refuses: the row's, said.
          refs.push(null);
          answers.push(refused(rows[i].id, error));
          snaps.push(null);
          continue;
        }
        snaps.push(await tx.get(refs[i]));
      }
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        if (refs[i] === null) continue;
        const current = held(snaps[i]);
        const stands = current === null ? { id: row.id, deleted: true } : { id: row.id, data: current };
        // A probe is the document as it stands; a row that assumed another state the same, a conflict.
        if (row.assumed === undefined || !same(current, row.assumed)) {
          answers.push(stands);
          continue;
        }
        const body = row.deleted ? {} : { ...row.data };
        body[deletedField] = row.deleted === true;
        body[stampField] = sdk.serverTimestamp();
        try {
          tx.set(refs[i], body);
        } catch (error) {
          answers.push(refused(row.id, error));
        }
      }
    });
    return answers;
  };

  return {
    pull: {
      async handler(checkpoint, batchSize) {
        if (typeof sdk.waitForPendingWrites === 'function') await sdk.waitForPendingWrites(database);
        return pull(checkpoint, batchSize);
      },
      ...(stream
        ? {
            stream(emit) {
              const newest = sdk.query(collection, sdk.orderBy(stampField, 'desc'), sdk.limit(1));
              let stopped = false;
              const off = sdk.onSnapshot(
                newest,
                (snapshot) => {
                  if (snapshot.metadata?.hasPendingWrites !== true) emit('RESYNC');
                },
                // The listener erring is over: the connector follows again after a backoff.
                () => {
                  if (!stopped) emit('END');
                },
              );
              return () => {
                stopped = true;
                off();
              };
            },
          }
        : {}),
    },
    push: {
      async handler(rows) {
        const answers = [];
        for (let from = 0; from < rows.length; from += CHUNK) {
          const chunk = await transact(rows.slice(from, from + CHUNK));
          for (let i = 0; i < chunk.length; i++) answers.push(chunk[i]);
        }
        return answers;
      },
    },
  };
};

module.exports = { firestore };
