'use strict';

// The CouchDB adapter (@alexify/syncom/connector/couchdb): the handlers
// `replicate()` takes, over one CouchDB database reached through an injected
// `fetch`. A pull is `_changes` with the documents included (`since` the
// checkpoint, `limit` the batch), a `_deleted` change a deletion, `last_seq`
// the checkpoint; the stream is `_changes?feed=longpoll` from the checkpoint
// the connector hands over, asked again and again (stopped by the function
// returned; a poll the server never answers is given up after the wait and a
// grace). A push is `_bulk_docs` with the `_rev` this adapter last saw for
// each document — CouchDB's compare-and-set — and a `conflict` answer is the
// document read back as the database holds it (a 404 a deletion); any other
// refusal of a document (an id starting with `_`, a forbidden write) is that
// row's `{ id, error }`. A probe (`assumed` undefined) is the document read
// back, nothing written. The revisions live in memory for the connector's
// life: a connector that starts anew learns them with its first pull, and a
// push of a document whose revision it does not know lands as a new document
// — a conflict where one exists, as it should. Credentials in the url move
// to the Authorization header, so no message ever carries them. No requires.

const DEFAULT_LONGPOLL = 60_000;
// A long poll the server never answers (a proxy holding the connection) is given up after the wait and this much.
const LONGPOLL_GRACE = 10_000;

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

// `user:password` as base64 of its UTF-8, for a Basic authorization.
const basic = (user, password) => {
  const bytes = new TextEncoder().encode(`${user}:${password}`);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return `Basic ${btoa(binary)}`;
};

/**
 * `{ pull, push }` for `replicate()`, over the CouchDB database at `url`
 * (`https://host/db`; credentials in it become the Authorization header).
 * `fetch` is the platform's unless given; `headers` ride on every request (an
 * `Authorization`); `longpoll` is the stream's wait in ms (60 000).
 */
const couchdb = ({ url, fetch = globalThis.fetch, headers = {}, longpoll = DEFAULT_LONGPOLL } = {}) => {
  if (typeof url !== 'string' || url.length === 0) throw new TypeError('couchdb(): url is required');
  if (typeof fetch !== 'function') throw new TypeError('couchdb(): fetch must be a function');
  if (!Number.isFinite(longpoll) || longpoll <= 0) throw new TypeError('couchdb(): longpoll must be a positive number');
  const common = { accept: 'application/json', ...headers };
  let base = url.replace(/\/+$/, '');
  try {
    // Credentials in the url become the header: no request's url, and no error's message, carries them.
    const parsed = new URL(base);
    if (parsed.username !== '' || parsed.password !== '') {
      common.authorization = basic(decodeURIComponent(parsed.username), decodeURIComponent(parsed.password));
      parsed.username = '';
      parsed.password = '';
      base = parsed.href.replace(/\/+$/, '');
    }
  } catch {
    // Not a url the platform parses: taken as it is.
  }
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
      // Long polls from the checkpoint the connector hands over: every answer is a page for `emit`.
      stream(emit, { checkpoint = null } = {}) {
        let since = checkpoint;
        let stopped = false;
        const controller = new AbortController();
        const loop = async () => {
          for (;;) {
            if (stopped) return;
            try {
              const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(longpoll + LONGPOLL_GRACE)]);
              const page = await changes(since, 100, { feed: 'longpoll', signal });
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
        const answers = [];
        for (let i = 0; i < rows.length; i++) {
          const row = rows[i];
          // A probe: the document as it stands, nothing written.
          if (row.assumed === undefined) {
            answers.push(await current(row.id));
            continue;
          }
          const doc = { _id: row.id, ...(row.deleted ? { _deleted: true } : row.data) };
          const rev = revs.get(row.id);
          if (rev !== undefined) doc._rev = rev;
          docs.push(doc);
        }
        if (docs.length === 0) return answers;
        const response = await request('/_bulk_docs', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ docs }),
        });
        if (!response.ok) throw await failed(response, '_bulk_docs');
        const results = await response.json();
        for (let i = 0; i < results.length; i++) {
          const result = results[i];
          if (result.ok === true && typeof result.rev === 'string') {
            revs.set(result.id, result.rev);
            continue;
          }
          if (result.error === 'conflict') {
            answers.push(await current(result.id));
            continue;
          }
          answers.push({ id: result.id, error: { code: result.error ?? 'refused', message: result.reason ?? '' } });
        }
        return answers;
      },
    },
    /** The revision this adapter last saw for a document, or undefined. */
    revisionOf: (id) => revs.get(id),
  };
};

module.exports = { couchdb };
