'use strict';

// One JSON file as a backend — what the Google Drive and OneDrive adapters
// share. The file holds `{ seq, docs: { [id]: { n, data } | { n, deleted } } }`:
// `n` the position of a document's newest write, `seq` the newest of them. A
// pull reads the file (its ETag probed first where the store can: unchanged,
// nothing is downloaded) and answers the documents with `n` after the
// checkpoint, in that order, `batchSize` at a time. A push is a
// read-modify-write under the file's ETag: every row's document as the file
// holds it compared with what the row assumed — written where the same
// (`n = ++seq`), a conflict where not — and the file saved whole with
// `If-Match`; a 412 (another device wrote first) reads the file again and
// tries once more, `RETRIES` times in all. The stream, where `poll` is set,
// probes the ETag every `poll` ms and says `RESYNC` when it moved. The store
// is the backend's door: `load()` → `{ etag, text }` or null for no file,
// `save(text, etag)` → `{ etag }` (an error with `status: 412` is the
// conflict), `probe()` → the ETag or null. `requester` is the fetch the two
// drives share: the common headers on every request, an error with the status
// for every answer that is not ok. Requires same.js only.

const { same } = require('./same.js');

const RETRIES = 3;

const empty = () => ({ seq: 0, docs: {} });

// The file's text read into its shape — or refused: a file this is not is never overwritten.
const parse = (text) => {
  let file;
  try {
    file = JSON.parse(text);
  } catch (error) {
    throw new Error('jsonFile: the file is not JSON', { cause: error });
  }
  if (
    file === null ||
    typeof file !== 'object' ||
    typeof file.seq !== 'number' ||
    file.docs === null ||
    typeof file.docs !== 'object' ||
    Array.isArray(file.docs)
  ) {
    throw new Error('jsonFile: the file is not a collection file ({ seq, docs })');
  }
  return file;
};

/** `{ pull, push }` for `replicate()` over one file held by `store`; `poll` ms between probes for the stream (0: none). */
const jsonFile = (store, { poll = 0 } = {}) => {
  if (
    store === null ||
    typeof store !== 'object' ||
    typeof store.load !== 'function' ||
    typeof store.save !== 'function'
  ) {
    throw new TypeError('jsonFile(): store must have load() and save()');
  }
  if (!Number.isFinite(poll) || poll < 0) throw new TypeError('jsonFile(): poll must be a non-negative number');
  const probes = typeof store.probe === 'function';
  let etag = null;
  let file = empty();
  let loaded = false;

  // The file as the store holds it now — not downloaded again where the ETag says it did not move.
  const refresh = async (force = false) => {
    if (loaded && !force && probes && (await store.probe()) === etag) return;
    const got = await store.load();
    if (got === null) {
      etag = null;
      file = empty();
    } else {
      file = parse(got.text);
      etag = got.etag ?? null;
    }
    loaded = true;
  };

  return {
    pull: {
      async handler(checkpoint, batchSize) {
        await refresh();
        const since = typeof checkpoint === 'number' ? checkpoint : 0;
        const rows = [];
        for (const id of Object.keys(file.docs)) {
          const doc = file.docs[id];
          if (typeof doc?.n === 'number' && doc.n > since) rows.push([doc.n, id, doc]);
        }
        rows.sort((a, b) => a[0] - b[0]);
        const documents = [];
        let last = since;
        for (let i = 0; i < rows.length && i < batchSize; i++) {
          const [n, id, doc] = rows[i];
          documents.push(doc.deleted === true ? { id, deleted: true } : { id, data: doc.data });
          last = n;
        }
        return { documents, checkpoint: last };
      },
      ...(poll > 0 && probes
        ? {
            stream(emit) {
              let busy = false;
              const timer = setInterval(async () => {
                if (busy) return;
                busy = true;
                try {
                  if ((await store.probe()) !== etag) emit('RESYNC');
                } catch {
                  // The next probe tells.
                }
                busy = false;
              }, poll);
              return () => clearInterval(timer);
            },
          }
        : {}),
    },
    push: {
      async handler(rows) {
        if (!loaded) await refresh();
        for (let attempt = 0; ; attempt++) {
          const conflicts = [];
          const next = { seq: file.seq, docs: { ...file.docs } };
          let changed = false;
          for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            const doc = file.docs[row.id];
            const current = doc === undefined || doc.deleted === true ? null : doc.data;
            // A probe is the document as the file holds it; a row that assumed another state the same, a conflict.
            if (row.assumed === undefined || !same(current, row.assumed)) {
              conflicts.push(current === null ? { id: row.id, deleted: true } : { id: row.id, data: current });
              continue;
            }
            next.docs[row.id] = row.deleted ? { n: ++next.seq, deleted: true } : { n: ++next.seq, data: row.data };
            changed = true;
          }
          if (!changed) return conflicts;
          try {
            const saved = await store.save(JSON.stringify(next), etag);
            etag = saved?.etag ?? null;
            file = next;
            return conflicts;
          } catch (error) {
            // Another device wrote first: its file read, the rows judged again.
            if (error?.status !== 412 || attempt >= RETRIES) throw error;
            await refresh(true);
          }
        }
      },
    },
    /** The position of a document's newest write as this adapter last read the file, or undefined. */
    positionOf: (id) => file.docs[id]?.n,
  };
};

/**
 * A fetch over `fetch` with `headers` (and `token` as a bearer) on every
 * request, that answers the response when ok and throws an error carrying
 * `status` — `<label> <what> answered <status>` — otherwise.
 */
const requester = (fetch, { headers = {}, token = null, label }) => {
  if (typeof fetch !== 'function') throw new TypeError(`${label}: fetch must be a function`);
  if (token !== null && typeof token !== 'string') throw new TypeError(`${label}: token must be a string`);
  const common = { accept: 'application/json', ...headers };
  if (token !== null) common.authorization = `Bearer ${token}`;
  return async (url, init = {}, what) => {
    const response = await fetch(url, { ...init, headers: { ...common, ...(init.headers ?? {}) } });
    if (response.ok) return response;
    let text = '';
    if (response.status !== 404 && response.status !== 412) {
      try {
        text = await response.text();
      } catch {
        // The body is not the point.
      }
    }
    const error = new Error(`${label} ${what} answered ${response.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
    error.status = response.status;
    throw error;
  };
};

module.exports = { jsonFile, requester, RETRIES };
