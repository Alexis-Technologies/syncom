'use strict';

// The Appwrite adapter (@alexify/syncom/connector/appwrite): the handlers
// `replicate()` takes, over one collection through the injected SDK —
// `databases` (its `Databases` service), `Query` (its query builder) and, for
// the stream, `client` (its `subscribe`). A document's `$updatedAt` is the
// position: a pull is the documents updated after the checkpoint
// `{ updatedAt, id }` — those at the same instant by `$id` — ordered so,
// `batchSize` at a time; a tombstone is a boolean attribute of the
// collection's (`deletedField`, `deleted`), so a pull sees a deletion. A push
// reads the rows' documents in one query and compares each with what its row
// assumed: a row never there is `createDocument` (a 409 the conflict, the
// document read back), a row the same is `updateDocument`, a row that differs
// a conflict answered as the document stands; a probe (`assumed` undefined)
// is the document as it stands, nothing written; a 400 (an id Appwrite cannot
// carry — past 36 letters, a `.`; an attribute the collection lacks) is that
// row's `{ id, error }`. Appwrite has no compare-and-set write, so a write
// landing between the read and the update is overwritten — said in the docs,
// as RxDB says it. The stream is Realtime's channel of the collection's
// documents, every event a `RESYNC`. Requires same.js only.

const { same } = require('./same.js');

const CALLS = ['listDocuments', 'createDocument', 'updateDocument', 'getDocument'];
const BUILDERS = ['equal', 'greaterThan', 'orderAsc', 'limit', 'or', 'and'];

const text = (name, value) => {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`appwrite(): ${name} is required`);
};

/**
 * `{ pull, push }` for `replicate()`. `databases` and `Query` are the SDK's,
 * `databaseId`/`collectionId` the collection's; `deletedField` (`deleted`)
 * the boolean attribute of a tombstone; `client` the SDK's client for the
 * stream (`stream: false`, or no client, for none).
 */
const appwrite = ({
  client = null,
  databases,
  Query,
  databaseId,
  collectionId,
  deletedField = 'deleted',
  stream = true,
} = {}) => {
  if (databases === null || typeof databases !== 'object') {
    throw new TypeError('appwrite(): databases must be the Databases service');
  }
  for (let i = 0; i < CALLS.length; i++) {
    if (typeof databases[CALLS[i]] !== 'function') {
      throw new TypeError(`appwrite(): databases.${CALLS[i]} must be a function`);
    }
  }
  if (Query === null || Query === undefined) throw new TypeError('appwrite(): Query is required');
  for (let i = 0; i < BUILDERS.length; i++) {
    if (typeof Query[BUILDERS[i]] !== 'function') {
      throw new TypeError(`appwrite(): Query.${BUILDERS[i]} must be a function`);
    }
  }
  text('databaseId', databaseId);
  text('collectionId', collectionId);
  text('deletedField', deletedField);
  if (typeof stream !== 'boolean') throw new TypeError('appwrite(): stream must be a boolean');
  if (client !== null && typeof client?.subscribe !== 'function') {
    throw new TypeError('appwrite(): client.subscribe must be a function');
  }

  const strip = (doc) => {
    const data = {};
    for (const key of Object.keys(doc)) if (key[0] !== '$' && key !== deletedField) data[key] = doc[key];
    return data;
  };
  const documentOf = (doc) =>
    doc[deletedField] === true ? { id: doc.$id, deleted: true } : { id: doc.$id, data: strip(doc) };
  const list = (queries) => databases.listDocuments(databaseId, collectionId, queries);

  return {
    pull: {
      async handler(checkpoint, batchSize) {
        const queries = [Query.orderAsc('$updatedAt'), Query.orderAsc('$id'), Query.limit(batchSize)];
        const after = checkpoint !== null && typeof checkpoint === 'object' && typeof checkpoint.updatedAt === 'string';
        if (after) {
          const ties = Query.and([
            Query.equal('$updatedAt', checkpoint.updatedAt),
            Query.greaterThan('$id', checkpoint.id),
          ]);
          queries.push(Query.or([Query.greaterThan('$updatedAt', checkpoint.updatedAt), ties]));
        }
        const result = await list(queries);
        const documents = [];
        let last = after ? checkpoint : null;
        const docs = Array.isArray(result?.documents) ? result.documents : [];
        for (let i = 0; i < docs.length; i++) {
          const doc = docs[i];
          documents.push(documentOf(doc));
          last = { updatedAt: doc.$updatedAt, id: doc.$id };
        }
        return { documents, checkpoint: last };
      },
      ...(stream && client !== null
        ? {
            stream(emit) {
              const off = client.subscribe(`databases.${databaseId}.collections.${collectionId}.documents`, () =>
                emit('RESYNC'),
              );
              return () => off();
            },
          }
        : {}),
    },
    push: {
      async handler(rows) {
        const ids = [];
        for (let i = 0; i < rows.length; i++) ids.push(rows[i].id);
        const found = await list([Query.equal('$id', ids), Query.limit(Math.max(ids.length, 1))]);
        const current = new Map();
        const docs = Array.isArray(found?.documents) ? found.documents : [];
        for (let i = 0; i < docs.length; i++) current.set(docs[i].$id, docs[i]);
        const conflicts = [];
        for (let i = 0; i < rows.length; i++) {
          const row = rows[i];
          const doc = current.get(row.id);
          const data = doc === undefined || doc[deletedField] === true ? null : strip(doc);
          // A probe is the document as it stands; a row that assumed another state the same, a conflict.
          if (row.assumed === undefined || !same(data, row.assumed)) {
            conflicts.push(doc === undefined ? { id: row.id, deleted: true } : documentOf(doc));
            continue;
          }
          const body = row.deleted ? {} : { ...row.data };
          body[deletedField] = row.deleted === true;
          try {
            if (doc === undefined) await databases.createDocument(databaseId, collectionId, row.id, body);
            else await databases.updateDocument(databaseId, collectionId, row.id, body);
          } catch (error) {
            // Made meanwhile (409), or taken away meanwhile (404): the document as it stands is the conflict. A 400
            // (an id Appwrite cannot carry, an attribute the collection lacks) is the row refused by name.
            if (error?.code === 409) {
              conflicts.push(documentOf(await databases.getDocument(databaseId, collectionId, row.id)));
            } else if (error?.code === 404) conflicts.push({ id: row.id, deleted: true });
            else if (error?.code === 400) {
              conflicts.push({ id: row.id, error: { code: '400', message: error.message ?? '' } });
            } else throw error;
          }
        }
        return conflicts;
      },
    },
  };
};

module.exports = { appwrite };
