'use strict';

// A CouchDB in memory behind a `fetch`: one database, `_changes` (with
// `include_docs`, `since`, `limit`, and `feed=longpoll` that waits for a
// change or the timeout), `_bulk_docs` (a `_rev` that is not the current one
// is a `conflict`), `GET /<id>` (404 for none, `_deleted` for a deletion).
// Enough of the HTTP face for the adapter; it answers 500 to what it lacks.

const clone = (value) => JSON.parse(JSON.stringify(value));

const createFakeCouch = ({ url = 'https://couch.test/db' } = {}) => {
  const docs = new Map();
  const changes = [];
  const waiters = new Set();
  let revisions = 0;
  const base = url.replace(/\/+$/, '');
  const answer = (status, body) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => clone(body),
    text: async () => JSON.stringify(body),
  });
  const record = (id, doc) => {
    docs.set(id, doc);
    changes.push({ seq: changes.length + 1, id, deleted: doc._deleted === true });
    for (const wake of [...waiters]) wake();
  };
  const nextRev = (held) =>
    `${(held ? Number(held.split('-')[0]) : 0) + 1}-${(++revisions).toString(16).padStart(8, '0')}`;
  const page = (since, limit, includeDocs) => {
    const results = [];
    for (let i = since; i < changes.length && results.length < limit; i++) {
      const change = changes[i];
      // One row per document, as CouchDB answers: the newest change of each.
      if (changes.slice(i + 1).some((later) => later.id === change.id)) continue;
      const doc = docs.get(change.id);
      const row = { seq: change.seq, id: change.id, changes: [{ rev: doc._rev }] };
      if (doc._deleted === true) row.deleted = true;
      if (includeDocs) row.doc = clone(doc);
      results.push(row);
    }
    const last = results.length > 0 ? results[results.length - 1].seq : since;
    return { results, last_seq: Math.max(last, since) };
  };
  const couch = {
    docs,
    changes,
    calls: [],
    /** A write on the database itself: another client's. */
    write(id, data, { deleted = false } = {}) {
      const held = docs.get(id);
      const doc = deleted ? { _id: id, _deleted: true } : { _id: id, ...clone(data) };
      doc._rev = nextRev(held?._rev);
      record(id, doc);
      return doc;
    },
    read(id) {
      const doc = docs.get(id);
      if (doc === undefined || doc._deleted === true) return null;
      const { _id, _rev, ...data } = doc;
      return data;
    },
    async fetch(target, init = {}) {
      couch.calls.push(`${init.method ?? 'GET'} ${target.slice(base.length)}`);
      if (!target.startsWith(base)) return answer(404, { error: 'not_found' });
      const path = target.slice(base.length);
      const [route, query = ''] = path.split('?');
      const params = new URLSearchParams(query);
      if (route === '/_changes') {
        const since = Number(params.get('since') ?? 0);
        const limit = Number(params.get('limit') ?? 100);
        const includeDocs = params.get('include_docs') === 'true';
        if (params.get('feed') === 'longpoll' && since >= changes.length) {
          await new Promise((resolve) => {
            const wake = () => {
              waiters.delete(wake);
              clearTimeout(timer);
              resolve();
            };
            const timer = setTimeout(wake, Math.min(Number(params.get('timeout') ?? 1000), 200));
            waiters.add(wake);
            init.signal?.addEventListener?.('abort', wake, { once: true });
          });
          if (init.signal?.aborted) return answer(500, { error: 'aborted' });
        }
        return answer(200, page(since, limit, includeDocs));
      }
      if (route === '/_bulk_docs' && init.method === 'POST') {
        const body = JSON.parse(init.body);
        const results = [];
        for (const given of body.docs) {
          const held = docs.get(given._id);
          const current = held?._rev;
          if (
            (current === undefined) !== (given._rev === undefined) ||
            (current !== undefined && current !== given._rev)
          ) {
            results.push({ id: given._id, error: 'conflict', reason: 'Document update conflict.' });
            continue;
          }
          const doc = { ...clone(given), _rev: nextRev(current) };
          record(given._id, doc);
          results.push({ ok: true, id: given._id, rev: doc._rev });
        }
        return answer(201, results);
      }
      if (route.startsWith('/') && !init.method) {
        const id = decodeURIComponent(route.slice(1));
        const doc = docs.get(id);
        if (doc === undefined) return answer(404, { error: 'not_found', reason: 'missing' });
        return answer(200, doc);
      }
      return answer(500, { error: 'fake-couch: unsupported', route });
    },
  };
  return couch;
};

module.exports = { createFakeCouch };
