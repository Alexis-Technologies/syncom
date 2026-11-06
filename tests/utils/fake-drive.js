'use strict';

// A drive in memory behind a `fetch`: files by name with an ETag that moves at
// every write and a compare-and-set on `If-Match` (412), fronted by the Google
// Drive routes the gdrive adapter calls (`files.list` by name, the v2 metadata
// for the ETag, `alt=media`, `files.create`, the media upload) and by the
// Microsoft Graph routes the onedrive adapter calls (`root:/<path>`,
// `/items/<id>/content`, `PUT root:/<path>:/content`). `write`/`read` are the
// backend's own door onto the collection file (another device's writes).

const empty = () => ({ seq: 0, docs: {} });

const createFileStore = () => {
  const files = new Map();
  let ids = 0;
  let etags = 0;
  const store = {
    files,
    byId(id) {
      for (const file of files.values()) if (file.id === id) return file;
      return undefined;
    },
    create(name) {
      const file = { id: `f${++ids}`, name, text: '', etag: `"e${++etags}"` };
      files.set(name, file);
      return file;
    },
    put(name, text, ifMatch) {
      let file = files.get(name);
      if (file === undefined) file = store.create(name);
      if (ifMatch !== undefined && ifMatch !== null && ifMatch !== file.etag) {
        const error = new Error('precondition failed');
        error.status = 412;
        throw error;
      }
      file.text = text;
      file.etag = `"e${++etags}"`;
      return file;
    },
    /** Another device's write of one document into the collection file. */
    write(name, id, data, { deleted = false } = {}) {
      const file = files.get(name);
      const body = file && file.text ? JSON.parse(file.text) : empty();
      body.docs[id] = deleted
        ? { n: ++body.seq, deleted: true }
        : { n: ++body.seq, data: JSON.parse(JSON.stringify(data)) };
      store.put(name, JSON.stringify(body), file?.etag);
    },
    read(name, id) {
      const file = files.get(name);
      if (file === undefined || !file.text) return null;
      const doc = JSON.parse(file.text).docs[id];
      return doc === undefined || doc.deleted === true ? null : doc.data;
    },
  };
  return store;
};

const answer = (status, body, { text = null, headers = {} } = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (name) => headers[name.toLowerCase()] ?? null },
  json: async () => JSON.parse(JSON.stringify(body)),
  text: async () => (text !== null ? text : JSON.stringify(body)),
});

const headerOf = (init, name) => {
  const headers = init.headers ?? {};
  for (const key of Object.keys(headers)) if (key.toLowerCase() === name) return headers[key];
  return null;
};

/** Google Drive's face over a file store. */
const createFakeDrive = ({
  endpoint = 'https://www.googleapis.com',
  name = 'tasks.json',
  store = createFileStore(),
} = {}) => {
  const drive = {
    store,
    calls: [],
    /** The v2 metadata answers the ETag in the header alone when set (the body's `etag` left out). */
    etagInHeader: false,
    write: (id, data, options) => store.write(name, id, data, options),
    read: (id) => store.read(name, id),
    async fetch(target, init = {}) {
      const url = new URL(target);
      const method = init.method ?? 'GET';
      drive.calls.push(`${method} ${url.pathname}`);
      if (!target.startsWith(endpoint)) return answer(404, { error: 'not found' });
      if (method === 'GET' && url.pathname === '/drive/v3/files') {
        const match = /name = '((?:\\.|[^'])*)'/.exec(url.searchParams.get('q') ?? '');
        const wanted = match ? match[1].replace(/\\(.)/g, '$1') : null;
        const file = wanted === null ? undefined : store.files.get(wanted);
        return answer(200, { files: file ? [{ id: file.id }] : [] });
      }
      if (method === 'POST' && url.pathname === '/drive/v3/files') {
        const body = JSON.parse(init.body);
        const file = store.create(body.name);
        return answer(200, { id: file.id, name: file.name });
      }
      let match = /^\/drive\/v2\/files\/([^/]+)$/.exec(url.pathname);
      if (match && method === 'GET') {
        const file = store.byId(decodeURIComponent(match[1]));
        if (!file) return answer(404, { error: 'not found' });
        return answer(200, drive.etagInHeader ? { id: file.id } : { id: file.id, etag: file.etag }, {
          headers: { etag: file.etag },
        });
      }
      match = /^\/drive\/v3\/files\/([^/]+)$/.exec(url.pathname);
      if (match && method === 'GET' && url.searchParams.get('alt') === 'media') {
        const file = store.byId(decodeURIComponent(match[1]));
        if (!file) return answer(404, { error: 'not found' });
        return answer(200, null, { text: file.text });
      }
      match = /^\/upload\/drive\/v3\/files\/([^/]+)$/.exec(url.pathname);
      if (match && method === 'PATCH') {
        const file = store.byId(decodeURIComponent(match[1]));
        if (!file) return answer(404, { error: 'not found' });
        try {
          const saved = store.put(file.name, init.body, headerOf(init, 'if-match'));
          return answer(200, { id: saved.id }, { headers: { etag: saved.etag } });
        } catch (error) {
          return answer(error.status ?? 500, { error: error.message });
        }
      }
      return answer(500, { error: `fake-drive: unsupported ${method} ${url.pathname}` });
    },
  };
  return drive;
};

/** Microsoft Graph's face over a file store. */
const createFakeGraph = ({
  endpoint = 'https://graph.microsoft.com/v1.0',
  path = 'syncom/tasks.json',
  store = createFileStore(),
} = {}) => {
  const base = `${new URL(endpoint).pathname.replace(/\/+$/, '')}/me/drive`;
  const graph = {
    store,
    calls: [],
    write: (id, data, options) => store.write(path, id, data, options),
    read: (id) => store.read(path, id),
    async fetch(target, init = {}) {
      const url = new URL(target);
      const method = init.method ?? 'GET';
      const pathname = decodeURIComponent(url.pathname);
      graph.calls.push(`${method} ${pathname}`);
      if (!target.startsWith(endpoint)) return answer(404, { error: 'not found' });
      let match = new RegExp(`^${base}/root:/(.+?)(:/content)?$`).exec(pathname);
      if (match) {
        const name = match[1];
        if (method === 'GET' && !match[2]) {
          const file = store.files.get(name);
          if (!file) return answer(404, { error: { code: 'itemNotFound' } });
          return answer(200, { id: file.id, eTag: file.etag, name });
        }
        if (method === 'PUT' && match[2]) {
          try {
            const saved = store.put(name, init.body, headerOf(init, 'if-match'));
            return answer(201, { id: saved.id, eTag: saved.etag, name });
          } catch (error) {
            return answer(error.status ?? 500, { error: { code: 'resourceModified' } });
          }
        }
      }
      match = new RegExp(`^${base}/items/([^/]+)/content$`).exec(pathname);
      if (match && method === 'GET') {
        const file = store.byId(match[1]);
        if (!file) return answer(404, { error: { code: 'itemNotFound' } });
        return answer(200, null, { text: file.text });
      }
      return answer(500, { error: `fake-graph: unsupported ${method} ${pathname}` });
    },
  };
  return graph;
};

module.exports = { createFileStore, createFakeDrive, createFakeGraph };
