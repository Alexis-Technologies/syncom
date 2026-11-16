'use strict';

// The attachments a dialed node waits for the bytes of, on disk. A push names them — every `_attachments/<name>`
// register a page the host took sets — and the bytes follow it (src/sync/manager.js `#upload`); what has not gone
// up yet is kept here per node, by digest (the record and the name that named it), `MAX_UPLOADS` a node, the oldest
// let go, and saved as `uploads.json` of the root kv namespace:
//
//   { "v": 1, "nodes": { "<url>": [["<digest>", "<id>", "<name>"], …] } }     each list oldest first
//
// so a restart takes them up again at the next hello, where memory alone forgot them and the host kept a register
// naming bytes it would never get. Saved when an entry is noted and when one goes — uploaded, refused for good, let
// go past the bound, its node removed — coalesced: one save in flight, the next after it. A save is never awaited
// by a push, and one that fails is logged (`sync.uploads.failed`), never thrown. `waiting` — this node lacks the
// bytes — is not stored: the blobs store says it again at the first upload after an open. A file of its own, not a
// field of the node's registry entry (src/sync/registry.js): that one is rewritten at every page received, and a
// relay may hold a thousand of these for long. Requires blobs.js only.

const { isDigest } = require('../blobs.js');

const UPLOADS_FILE = 'uploads.json';
const UPLOADS_VERSION = 1;
// The attachments a node waits for the bytes of beyond this: the oldest let go — a reader of them fetches them
// from a peer that holds them.
const MAX_UPLOADS = 1024;

class UploadQueue {
  #kv;
  #logger;
  #frozen;
  // By node url: a Map digest → `{ id, name, waiting }`, in the order noted.
  #nodes = new Map();
  #saving = Promise.resolve();
  #queued = false;

  /** `kv` the database's; `frozen()` says whether nothing may be written (a database that turned read-only). */
  constructor(kv, logger, frozen) {
    this.#kv = kv;
    this.#logger = logger;
    this.#frozen = frozen;
  }

  /**
   * What the root kv holds, read: the entries of every node `held(url)` still registers. A text that does not read
   * is said (`sync.uploads.unreadable`) and read as none; a row that is no `[digest, id, name]` is left out.
   */
  async load(held) {
    let parsed = null;
    try {
      const text = await this.#kv.get('', UPLOADS_FILE);
      if (text !== null) parsed = JSON.parse(text);
    } catch (error) {
      this.#logger.warn({ event: 'sync.uploads.unreadable', err: error });
    }
    if (parsed === null || typeof parsed !== 'object' || parsed.v !== UPLOADS_VERSION) return;
    const { nodes } = parsed;
    if (nodes === null || typeof nodes !== 'object' || Array.isArray(nodes)) return;
    const urls = Object.keys(nodes);
    for (let i = 0; i < urls.length; i++) {
      const rows = nodes[urls[i]];
      if (!held(urls[i]) || !Array.isArray(rows)) continue;
      const queue = this.of(urls[i]);
      for (let j = 0; j < rows.length; j++) {
        if (!Array.isArray(rows[j])) continue;
        const [digest, id, name] = rows[j];
        if (!isDigest(digest) || typeof id !== 'string' || typeof name !== 'string') continue;
        queue.set(digest, { id, name, waiting: false });
        if (queue.size > MAX_UPLOADS) queue.delete(queue.keys().next().value);
      }
    }
  }

  /** The entries of the node `url` by digest — the Map itself, which an upload walks. */
  of(url) {
    let queue = this.#nodes.get(url);
    if (queue === undefined) this.#nodes.set(url, (queue = new Map()));
    return queue;
  }

  /**
   * An attachment the node `url` was pushed the register of: kept until its bytes went up. One kept already is
   * looked at again — the bytes it waited for may have come another way (a local put of the same bytes).
   */
  note(url, digest, id, name) {
    const queue = this.of(url);
    const kept = queue.get(digest);
    if (kept !== undefined) {
      kept.waiting = false;
      return;
    }
    queue.set(digest, { id, name, waiting: false });
    if (queue.size > MAX_UPLOADS) queue.delete(queue.keys().next().value);
    this.#save();
  }

  /** An entry gone: its bytes went up, or the host refused them for good. */
  settle(url, digest) {
    const queue = this.#nodes.get(url);
    if (queue === undefined || !queue.delete(digest)) return;
    this.#save();
  }

  /** A node removed: nothing waits for it. */
  forget(url) {
    const queue = this.#nodes.get(url);
    if (queue === undefined) return;
    this.#nodes.delete(url);
    if (queue.size > 0) this.#save();
  }

  /** Bytes that landed here: no node's entry waits for them any more — a link that is down takes them up at its next push. */
  landed(digest) {
    for (const queue of this.#nodes.values()) {
      const entry = queue.get(digest);
      if (entry !== undefined) entry.waiting = false;
    }
  }

  #save() {
    if (this.#queued || this.#frozen()) return;
    this.#queued = true;
    this.#saving = this.#saving.then(async () => {
      this.#queued = false;
      const nodes = Object.create(null);
      for (const [url, queue] of this.#nodes) {
        if (queue.size === 0) continue;
        const rows = [];
        for (const [digest, entry] of queue) rows.push([digest, entry.id, entry.name]);
        nodes[url] = rows;
      }
      try {
        const text = JSON.stringify({ v: UPLOADS_VERSION, nodes });
        await this.#kv.put('', UPLOADS_FILE, text, { atomic: true });
      } catch (error) {
        this.#logger.warn({ event: 'sync.uploads.failed', err: error });
      }
    });
  }

  /** Resolves once every save asked for is done. */
  drain() {
    return this.#saving;
  }
}

module.exports = { UploadQueue, MAX_UPLOADS };
