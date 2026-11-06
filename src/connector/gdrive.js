'use strict';

// The Google Drive adapter (@alexify/syncom/connector/gdrive): one JSON file
// of the collection in the user's Drive — the application data folder by
// default — through an injected `fetch` and the token it is given, in the
// shape of src/connector/jsonfile.js. The file is found by `name` in the
// folder (or taken by `fileId`), its ETag read from the v2 metadata (v3
// answers none), its text with `alt=media`, written in place with
// `uploadType=media` under `If-Match` (a 412 the conflict) and made with
// `POST /drive/v3/files` where there is none. Requires jsonfile.js only.

const { jsonFile, requester } = require('./jsonfile.js');

/**
 * `{ pull, push }` for `replicate()`. `token` is the OAuth access token
 * (`https://www.googleapis.com/auth/drive.appdata` for the application data
 * folder) — or `headers` carry the authorization; `name` the file's, `folder`
 * its parent (`appDataFolder`), `fileId` the file itself when known; `poll`
 * ms between probes for the stream (0: none, the connector pulls every
 * `retryTime`).
 */
const gdrive = ({
  fetch = globalThis.fetch,
  token = null,
  headers = {},
  name,
  fileId = null,
  folder = 'appDataFolder',
  endpoint = 'https://www.googleapis.com',
  poll = 0,
} = {}) => {
  const request = requester(fetch, { headers, token, label: 'Google Drive' });
  if (fileId === null && (typeof name !== 'string' || name.length === 0)) {
    throw new TypeError('gdrive(): name or fileId is required');
  }
  const base = endpoint.replace(/\/+$/, '');
  let id = fileId;

  const notFound = (error) => {
    if (error?.status !== 404) throw error;
    return null;
  };
  // The file's id, by its name in the folder: null for none.
  const resolve = async () => {
    if (id !== null) return id;
    const query = new URLSearchParams({
      q: `name = '${name.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}' and trashed = false`,
      spaces: folder,
      fields: 'files(id)',
    });
    const body = await (await request(`${base}/drive/v3/files?${query}`, {}, 'files.list')).json();
    const files = Array.isArray(body.files) ? body.files : [];
    if (files.length > 0 && typeof files[0].id === 'string') id = files[0].id;
    return id;
  };
  const etagOf = async () => {
    const response = await request(`${base}/drive/v2/files/${encodeURIComponent(id)}?fields=etag`, {}, 'files.get');
    const body = await response.json();
    return body.etag ?? response.headers.get('etag') ?? null;
  };

  const store = {
    async probe() {
      if ((await resolve()) === null) return null;
      return etagOf().catch(notFound);
    },
    async load() {
      const etag = await store.probe();
      if (etag === null) return null;
      const response = await request(`${base}/drive/v3/files/${encodeURIComponent(id)}?alt=media`, {}, 'files.get');
      return { etag, text: await response.text() };
    },
    async save(text, etag) {
      if ((await resolve()) === null) {
        const init = {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name, parents: [folder], mimeType: 'application/json' }),
        };
        id = (await (await request(`${base}/drive/v3/files`, init, 'files.create')).json()).id;
      }
      const init = { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: text };
      if (etag !== null) init.headers['if-match'] = etag;
      const url = `${base}/upload/drive/v3/files/${encodeURIComponent(id)}?uploadType=media`;
      const response = await request(url, init, 'files.update');
      return { etag: response.headers.get('etag') ?? (await etagOf()) };
    },
  };
  return { ...jsonFile(store, { poll }), fileId: () => id };
};

module.exports = { gdrive };
