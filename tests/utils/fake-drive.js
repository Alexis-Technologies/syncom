'use strict';

// A drive in memory behind a `fetch`: files with an id, a name (two files may share one — two devices' first
// pushes), a `createdTime`, and an ETag that moves at every write with a compare-and-set on `If-Match` (412);
// fronted by the Google Drive routes the gdrive adapter calls (`files.list` by name — ordered by `createdTime` when
// asked, newest first otherwise — the v2 metadata for the ETag, `alt=media`, `files.create`, `files.delete`, the
// media upload) and by the Microsoft Graph routes the onedrive adapter calls (`root:/<path>`, `/items/<id>/content`,
// `PUT root:/<path>:/content` with `@microsoft.graph.conflictBehavior=fail` a 409 where the file is there).
// `write`/`read` are the backend's own door onto the collection file (another device's writes). `unconditional`
// counts the writes that would have overwritten whatever was there.

const empty = () => ({ seq: 0, docs: {} });

const createFileStore = () => {
  const files = new Map();
  let ids = 0;
  let etags = 0;
  let created = 0;
  const store = {
    files,
    /** Writes made without a compare-and-set (no If-Match, no conflictBehavior): what the adapters must never do. */
    unconditional: 0,
    byId: (id) => files.get(id),
    /** The files of a name, the oldest first. */
    byName(name) {
      const found = [];
      for (const file of files.values()) if (file.name === name) found.push(file);
      found.sort((a, b) => a.createdTime - b.createdTime);
      return found;
    },
    create(name) {
      const file = { id: `f${++ids}`, name, text: '', etag: `"e${++etags}"`, createdTime: ++created };
      files.set(file.id, file);
      return file;
    },
    remove(id) {
      return files.delete(id);
    },
    /** The text written under the compare-and-set: `ifMatch` the ETag held, `{ create }` to make a missing file. */
    putById(id, text, ifMatch) {
      const file = files.get(id);
      if (file === undefined) {
        const error = new Error('not found');
        error.status = 404;
        throw error;
      }
      if (ifMatch === undefined || ifMatch === null) store.unconditional++;
      else if (ifMatch !== file.etag) {
        const error = new Error('precondition failed');
        error.status = 412;
        throw error;
      }
      file.text = text;
      file.etag = `"e${++etags}"`;
      return file;
    },
    /** Graph's PUT by path: in place under If-Match; made under `fail` (a 409 where the file is there). */
    put(name, text, ifMatch, behavior = null) {
      const held = store.byName(name)[0];
      if (held === undefined) {
        if (ifMatch === undefined || ifMatch === null) {
          if (behavior !== 'fail') store.unconditional++;
          const file = store.create(name);
          file.text = text;
          return file;
        }
        const error = new Error('precondition failed');
        error.status = 412;
        throw error;
      }
      if (behavior === 'fail') {
        const error = new Error('name already exists');
        error.status = 409;
        throw error;
      }
      return store.putById(held.id, text, ifMatch);
    },
    /** Another device's write of one document into the collection file. */
    write(name, id, data, { deleted = false } = {}) {
      const file = store.byName(name)[0];
      const body = file && file.text ? JSON.parse(file.text) : empty();
      body.docs[id] = deleted
        ? { n: ++body.seq, deleted: true }
        : { n: ++body.seq, data: JSON.parse(JSON.stringify(data)) };
      store.put(name, JSON.stringify(body), file?.etag ?? null, file === undefined ? 'fail' : null);
    },
    read(name, id) {
      const file = store.byName(name)[0];
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
    /** The v2 metadata answers no ETag at all when set (neither body nor header). */
    noEtag: false,
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
        const found = wanted === null ? [] : store.byName(wanted);
        // Unordered, Drive lists the newest first here: an adapter that takes `files[0]` without `orderBy` is wrong.
        if (url.searchParams.get('orderBy') !== 'createdTime') found.reverse();
        const files = [];
        for (const file of found) files.push({ id: file.id });
        return answer(200, { files });
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
        if (drive.noEtag) return answer(200, { id: file.id });
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
      if (match && method === 'DELETE') {
        return store.remove(decodeURIComponent(match[1])) ? answer(204, null, { text: '' }) : answer(404, {});
      }
      match = /^\/upload\/drive\/v3\/files\/([^/]+)$/.exec(url.pathname);
      if (match && method === 'PATCH') {
        try {
          const saved = store.putById(decodeURIComponent(match[1]), init.body, headerOf(init, 'if-match'));
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
      graph.calls.push(`${method} ${pathname}${url.search}`);
      if (!target.startsWith(endpoint)) return answer(404, { error: 'not found' });
      let match = new RegExp(`^${base}/root:/(.+?)(:/content)?$`).exec(pathname);
      if (match) {
        const name = match[1];
        if (method === 'GET' && !match[2]) {
          const file = store.byName(name)[0];
          if (!file) return answer(404, { error: { code: 'itemNotFound' } });
          return answer(200, { id: file.id, eTag: file.etag, name });
        }
        if (method === 'PUT' && match[2]) {
          try {
            const behavior = url.searchParams.get('@microsoft.graph.conflictBehavior');
            const saved = store.put(name, init.body, headerOf(init, 'if-match'), behavior);
            return answer(201, { id: saved.id, eTag: saved.etag, name });
          } catch (error) {
            const code = error.status === 409 ? 'nameAlreadyExists' : 'resourceModified';
            return answer(error.status ?? 500, { error: { code } });
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
