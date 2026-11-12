'use strict';

// The OneDrive adapter (@alexify/syncom/connector/onedrive): one JSON file of
// the collection at `path` in the user's drive, through Microsoft Graph with
// an injected `fetch` and the token it is given, in the shape of
// src/connector/jsonfile.js. The item's metadata (`root:/<path>`) gives the
// eTag, `/content` the text, and `PUT root:/<path>:/content` under `If-Match`
// writes it in place (a 412 the conflict) or, where no file is known, makes
// it with `@microsoft.graph.conflictBehavior=fail` (a 409 the conflict: a
// file another device made first) — a simple upload, so a collection file
// stays under Graph's 4 MB. Requires jsonfile.js only.

const { jsonFile, requester } = require('./jsonfile.js');

/**
 * `{ pull, push }` for `replicate()`. `token` is the Graph access token
 * (`Files.ReadWrite`) — or `headers` carry the authorization; `path` the
 * file's path in the drive (`syncom/tasks.json`), `drive` the drive
 * (`me/drive`), `poll` ms between probes for the stream (0: none).
 */
const onedrive = ({
  fetch = globalThis.fetch,
  token = null,
  headers = {},
  path,
  drive = 'me/drive',
  endpoint = 'https://graph.microsoft.com/v1.0',
  poll = 0,
} = {}) => {
  const request = requester(fetch, { headers, token, label: 'OneDrive' });
  if (typeof path !== 'string' || path.length === 0) throw new TypeError('onedrive(): path is required');
  const base = `${endpoint.replace(/\/+$/, '')}/${drive.replace(/^\/+|\/+$/g, '')}`;
  const segments = path.split('/');
  for (let i = 0; i < segments.length; i++) segments[i] = encodeURIComponent(segments[i]);
  const at = segments.join('/');

  // The item's id and eTag, or null for no file.
  const item = async () => {
    try {
      return await (await request(`${base}/root:/${at}?$select=id,eTag`, {}, 'item')).json();
    } catch (error) {
      if (error?.status !== 404) throw error;
      return null;
    }
  };

  const store = {
    async probe() {
      const meta = await item();
      return meta === null ? null : (meta.eTag ?? null);
    },
    async load() {
      const meta = await item();
      if (meta === null) return null;
      const response = await request(`${base}/items/${encodeURIComponent(meta.id)}/content`, {}, 'content');
      return { etag: meta.eTag ?? null, text: await response.text() };
    },
    // In place under `If-Match`, or made where no file is known — `conflictBehavior=fail`: a file another device
    // made first is a 409, read and judged like a 412 — never an unconditional write.
    async save(text, etag) {
      const init = { method: 'PUT', headers: { 'content-type': 'application/json' }, body: text };
      let url = `${base}/root:/${at}:/content`;
      if (etag !== null) init.headers['if-match'] = etag;
      else url += '?@microsoft.graph.conflictBehavior=fail';
      const body = await (await request(url, init, 'upload')).json();
      return { etag: body.eTag ?? null };
    },
  };
  return jsonFile(store, { poll });
};

module.exports = { onedrive };
