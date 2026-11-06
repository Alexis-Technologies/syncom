'use strict';

// The CouchDB adapter (@alexify/syncom/connector/couchdb): the handlers
// `replicate()` takes, over one CouchDB database reached through an injected
// `fetch`. A pull is `_changes` with the documents included (`since` the
// checkpoint, `limit` the batch), a `_deleted` change a deletion, `last_seq`
// the checkpoint; the stream is `_changes?feed=longpoll` asked again and
// again (stopped by the function returned). A push is `_bulk_docs` with the
// `_rev` this adapter last saw for each document — CouchDB's compare-and-set
// — and a `conflict` answer is the document read back as the database holds
// it (a 404 a deletion). The revisions live in memory for the connector's
// life: a connector that starts anew learns them with its first pull, and a
// push of a document whose revision it does not know lands as a new document
// — a conflict where one exists, as it should. No requires.

const DEFAULT_LONGPOLL = 60_000;

const strip = (doc) => {
  const data = {};
  for (const key of Object.keys(doc)) if (key !== '_id' && key !== '_rev' && key !== '_deleted') data[key] = doc[key];
  return data;
};

const failed = async (response, what) => {
  let text = '';
  try {
    text = await response.text();
  } catch {
    // The body is not the point.
  }
  const error = new Error(`CouchDB ${what} answered ${response.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
  error.status = response.status;
  return error;
};

/**
 * `{ pull, push }` for `replicate()`, over the CouchDB database at `url`
 * (`https://host/db`). `fetch` is the platform's unless given; `headers` ride
 * on every request (an `Authorization`); `longpoll` is the stream's wait in
 * ms (60 000).
 */
const couchdb = ({ url, fetch = globalThis.fetch, headers = {}, longpoll = DEFAULT_LONGPOLL } = {}) => {
  if (typeof url !== 'string' || url.length === 0) throw new TypeError('couchdb(): url is required');
  if (typeof fetch !== 'function') throw new TypeError('couchdb(): fetch must be a function');
  if (!Number.isFinite(longpoll) || longpoll <= 0) throw new TypeError('couchdb(): longpoll must be a positive number');
  const base = url.replace(/\/+$/, '');
  const common = { accept: 'application/json', ...headers };
  const revs = new Map();

  const request = async (path, init = {}) => {
    const response = await fetch(`${base}${path}`, { ...init, headers: { ...common, ...(init.headers ?? {}) } });
    return response;
  };

  // A page of `_changes`, read into documents; the revisions remembered.
  const changes = async (since, limit, { feed = null, signal = null } = {}) => {
    const query = new URLSearchParams({ include_docs: 'true', limit: String(limit) });
    if (since !== null && since !== undefined) query.set('since', String(since));
    if (feed !== null) {
      query.set('feed', feed);
      query.set('timeout', String(longpoll));
    }
    const response = await request(`/_changes?${query}`, { signal });
    if (!response.ok) throw await failed(response, '_changes');
    const body = await response.json();
    const documents = [];
    const results = Array.isArray(body.results) ? body.results : [];
    for (let i = 0; i < results.length; i++) {
      const row = results[i];
      if (typeof row.id !== 'string') continue;
      const doc = row.doc;
      const deleted = row.deleted === true || doc?._deleted === true;
      if (doc && typeof doc._rev === 'string') revs.set(row.id, doc._rev);
      documents.push(deleted ? { id: row.id, deleted: true } : { id: row.id, data: doc ? strip(doc) : {} });
    }
    return { documents, checkpoint: body.last_seq ?? since ?? null };
  };

  // The document as the database holds it now: data, or a deletion (404, or `_deleted`).
  const current = async (id) => {
    const response = await request(`/${encodeURIComponent(id)}`);
    if (response.status === 404) {
      revs.delete(id);
      return { id, deleted: true };
    }
    if (!response.ok) throw await failed(response, `GET ${id}`);
    const doc = await response.json();
    if (typeof doc._rev === 'string') revs.set(id, doc._rev);
    return doc._deleted === true ? { id, deleted: true } : { id, data: strip(doc) };
  };

  return {
    pull: {
      handler: (checkpoint, batchSize) => changes(checkpoint, batchSize),
      // Long polls from the checkpoint the connector moved to last: every answer is a page for `emit`.
      stream(emit) {
        let since = null;
        let stopped = false;
        const controller = new AbortController();
        const loop = async () => {
          for (;;) {
            if (stopped) return;
            try {
              const page = await changes(since, 100, { feed: 'longpoll', signal: controller.signal });
              if (stopped) return;
              since = page.checkpoint;
              if (page.documents.length > 0) emit(page);
            } catch {
              if (stopped) return;
              // Asked again after a pause: a long poll that fails is the network's business.
              await new Promise((resolve) => setTimeout(resolve, 1000));
            }
          }
        };
        loop();
        return () => {
          stopped = true;
          controller.abort();
        };
      },
    },
    push: {
      async handler(rows) {
        const docs = [];
        for (let i = 0; i < rows.length; i++) {
          const row = rows[i];
          const doc = { _id: row.id, ...(row.deleted ? { _deleted: true } : row.data) };
          const rev = revs.get(row.id);
          if (rev !== undefined) doc._rev = rev;
          docs.push(doc);
        }
        const response = await request('/_bulk_docs', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ docs }),
        });
        if (!response.ok) throw await failed(response, '_bulk_docs');
        const results = await response.json();
        const conflicts = [];
        for (let i = 0; i < results.length; i++) {
          const result = results[i];
          if (result.ok === true && typeof result.rev === 'string') {
            revs.set(result.id, result.rev);
            continue;
          }
          if (result.error === 'conflict') conflicts.push(await current(result.id));
          else {
            throw new Error(`CouchDB refused ${result.id}: ${result.error ?? 'unknown'} ${result.reason ?? ''}`.trim());
          }
        }
        return conflicts;
      },
    },
    /** The revision this adapter last saw for a document, or undefined. */
    revisionOf: (id) => revs.get(id),
  };
};

module.exports = { couchdb };
