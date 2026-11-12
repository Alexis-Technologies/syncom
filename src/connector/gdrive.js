'use strict';

// The Google Drive adapter (@alexify/syncom/connector/gdrive): one JSON file
// of the collection in the user's Drive — the application data folder by
// default — through an injected `fetch` and the token it is given, in the
// shape of src/connector/jsonfile.js. The file is found by `name` in the
// folder (or taken by `fileId`) — the OLDEST by `createdTime` where two
// devices made one each — its ETag read from the v2 metadata (v3 answers
// none), its text with `alt=media`, written in place with `uploadType=media`
// under `If-Match` (a 412 the conflict) and made with `POST /drive/v3/files`
// where there is none: the list is read again after the create, and a file
// older than ours (another device's, made meanwhile) is the collection's —
// ours is deleted and the rows are judged against it (a 412). A write is
// never unconditional: a file without an ETag is refused (428). Requires
// jsonfile.js only.

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
  const refused = (status, message) => {
    const error = new Error(message);
    error.status = status;
    return error;
  };
  // The files of that name in the folder, the oldest first.
  const listed = async () => {
    const query = new URLSearchParams({
      q: `name = '${name.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}' and trashed = false`,
      spaces: folder,
      fields: 'files(id)',
      orderBy: 'createdTime',
    });
    const body = await (await request(`${base}/drive/v3/files?${query}`, {}, 'files.list')).json();
    const ids = [];
    const files = Array.isArray(body.files) ? body.files : [];
    for (let i = 0; i < files.length; i++) if (typeof files[i].id === 'string') ids.push(files[i].id);
    return ids;
  };
  // The file's id, the oldest by its name in the folder: null for none.
  const resolve = async () => {
    if (id !== null) return id;
    const ids = await listed();
    if (ids.length > 0) id = ids[0];
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
      let match = etag;
      if ((await resolve()) === null) {
        const init = {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name, parents: [folder], mimeType: 'application/json' }),
        };
        const made = (await (await request(`${base}/drive/v3/files`, init, 'files.create')).json()).id;
        // Another device may have made the file meanwhile: the oldest is the collection's, ours goes.
        const ids = fileId === null ? await listed() : [made];
        const oldest = ids.length > 0 ? ids[0] : made;
        if (oldest !== made) {
          await request(`${base}/drive/v3/files/${encodeURIComponent(made)}`, { method: 'DELETE' }, 'files.delete');
          id = oldest;
          throw refused(412, 'Google Drive: another device made the collection file first');
        }
        id = made;
        match = await etagOf();
      }
      if (match === null) throw refused(428, 'Google Drive answered no ETag: no compare-and-set, nothing written');
      const init = { method: 'PATCH', headers: { 'content-type': 'application/json', 'if-match': match }, body: text };
      const url = `${base}/upload/drive/v3/files/${encodeURIComponent(id)}?uploadType=media`;
      const response = await request(url, init, 'files.update');
      return { etag: response.headers.get('etag') ?? (await etagOf()) };
    },
  };
  return { ...jsonFile(store, { poll }), fileId: () => id };
};

module.exports = { gdrive };
